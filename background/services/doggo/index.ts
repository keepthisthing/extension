import { BigNumber } from "ethers"
import { ServiceLifecycleEvents, ServiceCreatorFunction } from "../types"
import { Eligible } from "./types"
import BaseService from "../base"
import { getFileHashProspect, getClaimFromFileHash } from "./utils"
import ChainService from "../chain"
import { ETHEREUM } from "../../constants"
import { sameNetwork } from "../../networks"
import { ClaimWithFriends } from "./contracts"
import IndexingService from "../indexing"
import logger from "../../lib/logger"
import { HexString } from "../../types"
import { AddressOnNetwork } from "../../accounts"
import { DoggoDatabase, getOrCreateDB, ReferrerStats } from "./db"

interface Events extends ServiceLifecycleEvents {
  newEligibility: Eligible
  newReferral: { referrer: AddressOnNetwork } & ReferrerStats
}

/**
 * Hunting grounds for earn, currently hardocded. Should be resolved via the
 * hunting ground registry in the future.
 */
const HARCODED_HUNTING_GROUNDS = [
  {
    network: ETHEREUM,
    asset: {
      name: "USDT",
      symbol: "USDT",
      contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      decimals: 6,
    },
    vaultAddress: "0x6575a8E8Ca0FD1Fb974419AE1f9128cCb1055209",
    yearnVault: "0x7Da96a3891Add058AdA2E826306D812C638D87a7",
    active: true,
  },
  {
    network: ETHEREUM,
    asset: {
      name: "Wrapped BTC",
      symbol: "WBTC",
      contractAddress: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      decimals: 8,
    },
    vaultAddress: "0xAAfcDd71F8eb9B6229852fD6B005F0c39394Af06",
    yearnVault: "0xA696a63cc78DfFa1a63E9E50587C197387FF6C7E",
    active: true,
  },
  {
    network: ETHEREUM,
    asset: {
      name: "ChainLink",
      symbol: "LINK",
      contractAddress: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
      decimals: 18,
    },
    vaultAddress: "0x30EEB5c3d3B3FB3aC532c77cD76dd59f78Ff9070",
    yearnVault: "0x671a912C10bba0CFA74Cfc2d6Fba9BA1ed9530B2",
    active: false,
  },
]

/*
 * The DOGGO service handles interactions, caching, and indexing related to the
 * DOGGO token and its capabilities.
 *
 * This includes handling DOGGO claim data, as well as
 */
export default class DoggoService extends BaseService<Events> {
  static create: ServiceCreatorFunction<
    Events,
    DoggoService,
    [Promise<ChainService>, Promise<IndexingService>]
  > = async (chainService, indexingService) => {
    return new this(
      await getOrCreateDB(),
      await chainService,
      await indexingService
    )
  }

  private constructor(
    private db: DoggoDatabase,
    private chainService: ChainService,
    private indexingService: IndexingService
  ) {
    super()
  }

  protected async internalStartService(): Promise<void> {
    await super.internalStartService()

    const huntingGrounds = HARCODED_HUNTING_GROUNDS

    const ethereumProvider = this.chainService.providerForNetwork(ETHEREUM)
    if (ethereumProvider === undefined) {
      logger.error(
        "No Ethereum provider available, not setting up DOGGO monitoring..."
      )
    }

    // Make sure the hunting ground assets are being tracked.
    huntingGrounds.forEach(({ network, asset }) => {
      this.indexingService.addAssetToTrack({ ...asset, homeNetwork: network })
    })

    // Track referrals for all added accounts and any new ones that are added
    // after load.
    this.chainService.emitter.on("newAccountToTrack", (addressOnNetwork) => {
      this.trackReferrals(addressOnNetwork)
    })
    ;(await this.chainService.getAccountsToTrack()).forEach(
      (addressOnNetwork) => {
        this.trackReferrals(addressOnNetwork)
      }
    )
  }

  protected async internalStopService(): Promise<void> {
    await super.internalStopService()
  }

  async getEligibility(address: string): Promise<Eligible> {
    const fileHash = await getFileHashProspect(address)
    const { account, amount, index, proof } = await getClaimFromFileHash(
      address,
      fileHash
    )

    const claim = {
      index,
      amount: BigInt(amount),
      account,
      proof,
    }
    this.emitter.emit("newEligibility", claim)
    return claim
  }

  /**
   * Returns the total users referred and the referral bonus total for the
   * given referrer. Only tracked for accounts that are being tracked by the
   * ChainService.
   */
  async getReferrerStats(referrer: AddressOnNetwork): Promise<ReferrerStats> {
    return this.db.getReferrerStats(referrer)
  }

  private async trackReferrals({
    address,
    network,
  }: AddressOnNetwork): Promise<void> {
    if (sameNetwork(network, ETHEREUM)) {
      const provider = this.chainService.providerForNetwork(ETHEREUM)

      if (provider === undefined) {
        return
      }

      const providedClaimWithFriends = ClaimWithFriends.connect(provider)
      const referralFilter =
        ClaimWithFriends.filters.ClaimedWithCommunityCode(address)

      const referralHandler: Parameters<
        typeof providedClaimWithFriends["on"]
      >[1] = (...args) => {
        if (args.length !== 6) {
          logger.error(
            "Malformed event, got an unexpected number of ClaimedWithCommunityCode parameters:",
            args
          )
          return
        }

        this.registerReferral({ address, network }, [
          args[0],
          args[1],
          args[2],
          args[3],
          args[4],
          args[5],
        ])
      }

      providedClaimWithFriends.on(referralFilter, referralHandler)
      ;(await providedClaimWithFriends.queryFilter(referralFilter)).forEach(
        (event) => {
          if (event.args === undefined) {
            logger.error(
              "Malformed event lookup, got no decoded ClaimedWithCommunityCode parameters:",
              event
            )
            return
          }

          referralHandler(
            event.args.index,
            event.args.claimant,
            event.args.amountClaimed,
            event.args.claimedBonus,
            event.args.communityRef,
            event.args.communityBonus
          )
        }
      )
    }
  }

  private async registerReferral(
    referrer: AddressOnNetwork,
    [, claiming, , , , communityBonus]: [
      BigNumber,
      HexString,
      BigNumber,
      BigNumber,
      HexString,
      BigNumber
    ]
  ): Promise<void> {
    await this.db.addReferralBonus(
      referrer,
      { address: claiming, network: referrer.network },
      communityBonus.toBigInt()
    )

    this.emitter.emit("newReferral", {
      referrer,
      ...(await this.getReferrerStats(referrer)),
    })
  }
}
