import { ZeroAddress } from "ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { ONE_PERCENT_BPS } from "../../typescript/common/bps_constants";
import { DETH_TOKEN_ID, DUSD_TOKEN_ID, INCENTIVES_PROXY_ID } from "../../typescript/deploy-ids";
import { ORACLE_AGGREGATOR_BASE_CURRENCY_UNIT, ORACLE_AGGREGATOR_PRICE_DECIMALS } from "../../typescript/oracle_aggregator/constants";
import { fetchTokenInfo } from "../../typescript/token/utils";
import {
  rateStrategyHighLiquidityStable,
  rateStrategyHighLiquidityVolatile,
  rateStrategyMediumLiquidityStable,
  rateStrategyMediumLiquidityVolatile,
} from "../dlend/interest-rate-strategies";
import { strategyDETH, strategyDUSD, strategySFRXUSD, strategySTETH, strategyWETH } from "../dlend/reserves-params";
import { Config } from "../types";

/**
 * Get the configuration for the network
 *
 * @param _hre - Hardhat Runtime Environment
 * @returns The configuration for the network
 */
export async function getConfig(_hre: HardhatRuntimeEnvironment): Promise<Config> {
  const dUSDDeployment = await _hre.deployments.getOrNull(DUSD_TOKEN_ID);
  const dETHDeployment = await _hre.deployments.getOrNull(DETH_TOKEN_ID);

  // IMPORTANT: All addresses below are placeholders (0x0000...)
  // These MUST be replaced with actual Katana mainnet addresses before deployment
  const wETHAddress = "0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62"; // Katana uses vbETH, which is their canonical WETH
  const wstETHAddress = "0x7Fb4D0f51544F24F385a421Db6e7D4fC71Ad8e5C"; // Wrapped Lido Staked ETH
  const weETHAddress = "0x9893989433e7a383Cb313953e4c2365107dc19a7"; // Wrapped eETH

  const frxUSDAddress = "0xFB55A212Dd6187bc4B088a79F7ab9d1aeA86E50e"; // Frax USD
  const sfrxUSDAddress = "0xBA2F8EA0A9e790ffC982F7241bEc17af949C71b3"; // Staked Frax USD
  const USDCAddress = "0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36"; // Actually vbUSDC
  const USDTAddress = "0x2DCa96907fde857dd3D816880A0df407eeB2D2F2"; // Actually vbUSDT
  const AUSDAddress = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a"; // Natively issued AUSD
  const yUSDAddress = "0x4772D2e014F9fC3a820C444e3313968e9a5C8121"; // YieldFi yUSD

  const governanceSafeMultisig = "0xE83c188a7BE46B90715C757A06cF917175f30262"; // Placeholder - set governance multisig

  // Safe configuration for governance multisig
  const safeOwners = [
    "0x9E0c8376940aBE845A89b7304147a95c72644f59", // David
    "0x0000000000000000000000000000000000000000", // Placeholder - set actual owners
    "0x0000000000000000000000000000000000000000", // Placeholder - set actual owners
  ];
  const safeThreshold = 2; // 2 of 3 multisig

  // Fetch deployed dLend StaticATokenLM wrapper, aToken and RewardsController (may be undefined prior to deployment)
  const dLendATokenWrapperDUSDDeployment = await _hre.deployments.getOrNull("dLend_ATokenWrapper_dUSD");
  const rewardsControllerDeployment = await _hre.deployments.getOrNull(INCENTIVES_PROXY_ID);
  const aTokenDUSDDeployment = await _hre.deployments.getOrNull("dLEND-dUSD");

  // Fetch dUSD token decimals from the contract if deployed
  let dUSDDecimals = 0;

  if (dUSDDeployment?.address) {
    const dUSDTokenInfo = await fetchTokenInfo(_hre, dUSDDeployment.address);
    dUSDDecimals = dUSDTokenInfo.decimals;

    if (dUSDDecimals < 1) {
      throw Error("dUSD token decimals must be greater than 0");
    }
  }

  return {
    safeConfig: {
      safeAddress: governanceSafeMultisig,
      owners: safeOwners,
      threshold: safeThreshold,
      chainId: 747474, // Katana mainnet chain ID
      rpcUrl: "https://rpc.katana.network/", // Official Katana mainnet RPC
      // Katana mainnet Safe Transaction Service
      txServiceUrl: "https://safe-transaction-katana.safe.global",
    },
    tokenAddresses: {
      dUSD: emptyStringIfUndefined(dUSDDeployment?.address),
      dETH: emptyStringIfUndefined(dETHDeployment?.address),
      WETH: wETHAddress, // WETH is actually vbETH on Katana
      wstETH: wstETHAddress, // Wrapped stETH
      weETH: weETHAddress, // Wrapped eETH
      frxUSD: frxUSDAddress, // Canonical frxUSD
      sfrxUSD: sfrxUSDAddress, // Canonical sfrxUSD
      USDC: USDCAddress, // vbUSDC
      USDT: USDTAddress, // vbUSDT
      AUSD: AUSDAddress, // Natively issued AUSD
      yUSD: yUSDAddress, // YieldFi yUSD
    },
    walletAddresses: {
      governanceMultisig: governanceSafeMultisig,
      incentivesVault: "0x0000000000000000000000000000000000000000", // Placeholder - set incentives vault
    },
    pendle: {
      ptYtLpOracleAddress: "0x0000000000000000000000000000000000000000", // Placeholder - update when known
      ptTokens: [],
    },
    dStables: {
      dUSD: {
        collaterals: [frxUSDAddress, sfrxUSDAddress, USDCAddress, USDTAddress, AUSDAddress, yUSDAddress],
        initialFeeReceiver: governanceSafeMultisig,
        initialRedemptionFeeBps: 0.4 * ONE_PERCENT_BPS, // Default for stablecoins
        collateralRedemptionFees: {
          // Default regular stablecoins to the default redemption fee
          // Yield bearing stablecoins: 0.5%
          [sfrxUSDAddress]: 0.5 * ONE_PERCENT_BPS,
          [yUSDAddress]: 0.5 * ONE_PERCENT_BPS,
        },
      },
      dETH: {
        collaterals: [wETHAddress, wstETHAddress, weETHAddress], // Updated for Katana
        initialFeeReceiver: governanceSafeMultisig,
        initialRedemptionFeeBps: 0.4 * ONE_PERCENT_BPS, // Default for stablecoins
        collateralRedemptionFees: {
          // Default regular stablecoins to the default redemption fee
          // Yield bearing stablecoins: 0.5%
          [wstETHAddress]: 0.5 * ONE_PERCENT_BPS,
          [weETHAddress]: 0.5 * ONE_PERCENT_BPS,
        },
      },
    },
    oracleAggregators: {
      USD: {
        baseCurrency: ZeroAddress, // Note that USD is represented by the zero address, per Aave's convention
        hardDStablePeg: ORACLE_AGGREGATOR_BASE_CURRENCY_UNIT,
        priceDecimals: ORACLE_AGGREGATOR_PRICE_DECIMALS,
        api3OracleAssets: {
          plainApi3OracleWrappers: {},
          api3OracleWrappersWithThresholding: {
            [frxUSDAddress]: {
              proxy: "0x4Dc7AAd0DfA29565469172dcaAc33cEd6FFF56B6", // frxUSD/USD API3 feed
              lowerThreshold: ORACLE_AGGREGATOR_BASE_CURRENCY_UNIT,
              fixedPrice: ORACLE_AGGREGATOR_BASE_CURRENCY_UNIT,
            },
          },
          compositeApi3OracleWrappersWithThresholding: {
            [sfrxUSDAddress]: {
              feedAsset: sfrxUSDAddress,
              proxy1: "0x0F546720261f447A8810A466269BCE6A66Cd1326", // sfrxUSD/frxUSD API3 feed
              proxy2: "0x4Dc7AAd0DfA29565469172dcaAc33cEd6FFF56B6", // frxUSD/USD API3 feed
              lowerThresholdInBase1: 0n,
              fixedPriceInBase1: 0n,
              lowerThresholdInBase2: ORACLE_AGGREGATOR_BASE_CURRENCY_UNIT,
              fixedPriceInBase2: ORACLE_AGGREGATOR_BASE_CURRENCY_UNIT,
            },
          },
        },
        redstoneOracleAssets: {
          plainRedstoneOracleWrappers: {
            [yUSDAddress]: "0xe61b585418B92917771c89D4d3957707cfFE6154", // yUSD/USD Chainlink feed
          },
          redstoneOracleWrappersWithThresholding: {
            [USDCAddress]: {
              feed: "0xbe5CE90e16B9d9d988D64b0E1f6ed46EbAfb9606", // USDC/USD Chainlink feed
              lowerThreshold: ORACLE_AGGREGATOR_BASE_CURRENCY_UNIT,
              fixedPrice: ORACLE_AGGREGATOR_BASE_CURRENCY_UNIT,
            },
            [USDTAddress]: {
              feed: "0xF03E1566Fc6B0eBFA3dD3aA197759C4c6617ec78", // USDT/USD Chainlink feed
              lowerThreshold: ORACLE_AGGREGATOR_BASE_CURRENCY_UNIT,
              fixedPrice: ORACLE_AGGREGATOR_BASE_CURRENCY_UNIT,
            },
            [AUSDAddress]: {
              feed: "0x3A49D4e23868222785f148BA2bd0bAEc80d36a2A", // AUSD/USD Chainlink feed
              lowerThreshold: ORACLE_AGGREGATOR_BASE_CURRENCY_UNIT,
              fixedPrice: ORACLE_AGGREGATOR_BASE_CURRENCY_UNIT,
            },
          },
          compositeRedstoneOracleWrappersWithThresholding: {},
        },
        chainlinkCompositeAggregator: {},
      },
      ETH: {
        hardDStablePeg: ORACLE_AGGREGATOR_BASE_CURRENCY_UNIT,
        priceDecimals: ORACLE_AGGREGATOR_PRICE_DECIMALS,
        baseCurrency: wETHAddress, // Using WETH as base currency for Katana
        api3OracleAssets: {
          plainApi3OracleWrappers: {},
          api3OracleWrappersWithThresholding: {},
          compositeApi3OracleWrappersWithThresholding: {},
        },
        redstoneOracleAssets: {
          plainRedstoneOracleWrappers: {
            // PLACEHOLDER: Update with actual Katana oracle addresses
            [wstETHAddress]: "0xCB568C33EA2B0B81852655d722E3a52d9D44e7De", // wstETH/ETH Chainlink Feed
            [weETHAddress]: "0x3Eae75C0a2f9b1038C7c9993C1Da36281E838811", // weETH/ETH Chainlink Feed
          },
          redstoneOracleWrappersWithThresholding: {},
          compositeRedstoneOracleWrappersWithThresholding: {},
        },
      },
    },
    dLend: {
      providerID: 1, // Arbitrary as long as we don't repeat
      flashLoanPremium: {
        total: 0.0005e4, // 0.05%
        protocol: 0.0004e4, // 0.04%
      },
      rateStrategies: [
        rateStrategyHighLiquidityVolatile,
        rateStrategyMediumLiquidityVolatile,
        rateStrategyHighLiquidityStable,
        rateStrategyMediumLiquidityStable,
      ],
      reservesConfig: {
        dUSD: strategyDUSD,
        dETH: strategyDETH,
        stETH: strategySTETH,
        sfrxUSD: strategySFRXUSD,
        WETH: strategyWETH,
      },
    },
    dStake: {
      sdUSD: {
        dStable: emptyStringIfUndefined(dUSDDeployment?.address),
        name: "Staked dUSD",
        symbol: "sdUSD",
        initialAdmin: governanceSafeMultisig,
        initialFeeManager: governanceSafeMultisig,
        initialWithdrawalFeeBps: 0.1 * ONE_PERCENT_BPS, // 0.1%
        adapters: [
          {
            vaultAsset: emptyStringIfUndefined(dLendATokenWrapperDUSDDeployment?.address),
            adapterContract: "WrappedDLendConversionAdapter",
          },
        ],
        defaultDepositVaultAsset: emptyStringIfUndefined(dLendATokenWrapperDUSDDeployment?.address),
        collateralVault: "DStakeCollateralVault_sdUSD", // Keep in sync with deploy ID constants
        collateralExchangers: [governanceSafeMultisig],
        dLendRewardManager: {
          managedVaultAsset: emptyStringIfUndefined(dLendATokenWrapperDUSDDeployment?.address), // StaticATokenLM wrapper
          dLendAssetToClaimFor: emptyStringIfUndefined(aTokenDUSDDeployment?.address), // dLEND aToken for dUSD
          dLendRewardsController: emptyStringIfUndefined(rewardsControllerDeployment?.address), // RewardsController proxy
          treasury: governanceSafeMultisig,
          maxTreasuryFeeBps: 20 * ONE_PERCENT_BPS, // 20%
          initialTreasuryFeeBps: 0 * ONE_PERCENT_BPS, // 0%
          initialExchangeThreshold: 100n * 10n ** BigInt(dUSDDecimals), // 100 sdUSD
        },
      },
    },
    // Not launching dBOOST yet, so keep disabled for now
    // vesting: {
    //   name: "dBOOST sdUSD Season 1",
    //   symbol: "sdUSD-S1",
    //   dstakeToken: emptyStringIfUndefined(sdUSDDeployment?.address),
    //   vestingPeriod: 180 * 24 * 60 * 60, // 6 months
    //   maxTotalSupply: _hre.ethers.parseUnits("20000000", 18).toString(), // 20M tokens
    //   initialOwner: governanceSafeMultisig,
    //   minDepositThreshold: _hre.ethers.parseUnits("250000", 18).toString(), // 250k tokens
    // },
  };
}

/**
 * Return an empty string if the value is undefined
 *
 * @param value - The value to check
 * @returns An empty string if the value is undefined, otherwise the value itself
 */
function emptyStringIfUndefined(value: string | undefined): string {
  return value || "";
}
