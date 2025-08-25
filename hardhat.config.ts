import "@typechain/hardhat";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-verify";
import "hardhat-deploy";
import "dotenv/config";

import { extendEnvironment, HardhatUserConfig } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getEnvPrivateKeys } from "./typescript/hardhat/named-accounts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Wrapper function to add a delay to transactions

const wrapSigner = (signer: any, hre: HardhatRuntimeEnvironment): any => {
  const originalSendTransaction = signer.sendTransaction;

  signer.sendTransaction = async (tx: any): Promise<any> => {
    const result = await originalSendTransaction.apply(signer, [tx]);

    if (hre.network.live) {
      const sleepTime = 15000; // 15 seconds to ensure at least 1 block
      console.log(`\n>>> Waiting ${sleepTime}ms after transaction to ${result.to || "a new contract"}`);
      await sleep(sleepTime);
    }
    return result;
  };
  return signer;
};

extendEnvironment((hre: HardhatRuntimeEnvironment) => {
  // Wrap hre.ethers.getSigner
  const originalGetSigner = hre.ethers.getSigner;

  hre.ethers.getSigner = async (address): Promise<any> => {
    const signer = await originalGetSigner(address);
    return wrapSigner(signer, hre);
  };

  // Wrap hre.ethers.getSigners
  const originalGetSigners = hre.ethers.getSigners;

  hre.ethers.getSigners = async (): Promise<any[]> => {
    const signers = await originalGetSigners();
    return signers.map((signer) => wrapSigner(signer, hre));
  };
});

/* eslint-disable camelcase -- Network names follow specific naming conventions that require snake_case */
const config: HardhatUserConfig = {
  //
  // Compile settings -------------------------------------------------------
  //  • Default: classic solc pipeline (fast) with optimizer.
  //  • Set env `VIA_IR=true` to enable the IR pipeline for **all** contracts.
  //  • Always compile complex contracts and their dependencies with IR to avoid
  //    "stack too deep" errors, without slowing down the whole codebase.
  // -----------------------------------------------------------------------
  solidity: {
    compilers: [
      {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          ...(process.env.VIA_IR === "true" ? { viaIR: true } : {}),
        },
      },
      {
        version: "0.8.22",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          ...(process.env.VIA_IR === "true" ? { viaIR: true } : {}),
        },
      },
    ],
    overrides: {
      // RewardClaimable is part of the inheritance chain; compile with IR as well
      "contracts/vaults/rewards_claimable/RewardClaimable.sol": {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
      // DStake router with stack too deep errors
      "contracts/vaults/dstake/DStakeRouterDLend.sol": {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
      // Contracts that import DStakeRouterDLend
      "contracts/vaults/dstake/rewards/DStakeRewardManagerDLend.sol": {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
      // Vesting NFT with stack too deep errors
      "contracts/vaults/vesting/ERC20VestingNFT.sol": {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
    },
  },
  networks: {
    hardhat: {
      deploy: ["deploy-mocks", "deploy"],
      allowUnlimitedContractSize: true,
      saveDeployments: false, // allow testing without needing to remove the previous deployments
    },
    localhost: {
      deploy: ["deploy-mocks", "deploy"],
      saveDeployments: true,
    },
    katana_testnet: {
      // Katana Bokuto testnet
      url: `https://rpc-bokuto.katanarpc.com`,
      chainId: 737373,
      deploy: ["deploy-mocks", "deploy"],
      saveDeployments: true,
      accounts: getEnvPrivateKeys("katana_testnet"),
    },
    katana_mainnet: {
      url: `https://rpc.katana.network/`,
      chainId: 747474,
      deploy: ["deploy"], // NOTE: DO NOT DEPLOY mocks
      saveDeployments: true,
      accounts: getEnvPrivateKeys("katana_mainnet"),
    },
  },
  namedAccounts: {
    deployer: 0,
    user1: 1,
    user2: 2,
    user3: 3,
    user4: 4,
    user5: 5,
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
    deployments: "./deployments",
    deploy: "./deploy",
  },
  gasReporter: {
    enabled: false, // Enable this when testing new complex functions
  },
  etherscan: {
    // Used for verifying single contracts when hardhat-deploy auto verify doesn't work
    apiKey: {
      katana_mainnet: process.env.KATANA_API_KEY || "YOUR_KATANA_API_KEY",
      katana_testnet: process.env.KATANA_API_KEY || "YOUR_KATANA_API_KEY",
    },
    customChains: [
      {
        network: "katana_testnet",
        chainId: 737373,
        urls: {
          apiURL: "https://bokuto.katanascan.com/api",
          browserURL: "https://bokuto.katanascan.com/",
        },
      },
      {
        network: "katana_mainnet",
        chainId: 747474,
        urls: {
          apiURL: "https://katanascan.com/api",
          browserURL: "https://katanascan.com/",
        },
      },
    ],
  },
  sourcify: {
    // Just here to mute warning
    enabled: false,
  },
};
/* eslint-enable camelcase -- Re-enabling camelcase rule after network definitions */

export default config;
