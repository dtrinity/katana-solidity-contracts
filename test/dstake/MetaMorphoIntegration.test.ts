import { expect } from "chai";
import { ethers, deployments, getNamedAccounts } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { 
  DStakeRewardManagerMetaMorpho,
  MockMetaMorphoVault,
  MockUniversalRewardsDistributor,
  TestMintableERC20,
  DStakeCollateralVault,
  DStakeRouterDLend,
  MetaMorphoConversionAdapter,
  DStakeToken
} from "../../typechain-types";
import { SDUSD_CONFIG, SDETH_CONFIG, DStakeFixtureConfig } from "./fixture";
import { getTokenContractForSymbol } from "../../typescript/token/utils";

describe("MetaMorpho Integration", function () {
  // Run tests for both sdUSD and sdETH
  [SDUSD_CONFIG, SDETH_CONFIG].forEach((config) => {
    describe(`${config.DStakeTokenSymbol} MetaMorpho Integration`, function () {
      let owner: SignerWithAddress;
      let user: SignerWithAddress;
      let treasury: SignerWithAddress;
      let manager: SignerWithAddress;
      
      let dStable: TestMintableERC20;
      let rewardToken: TestMintableERC20;
      let metaMorphoVault: MockMetaMorphoVault;
      let urd: MockUniversalRewardsDistributor;
      let collateralVault: DStakeCollateralVault;
      let router: DStakeRouterDLend;
      let adapter: MetaMorphoConversionAdapter;
      let rewardManager: DStakeRewardManagerMetaMorpho;
      let dStakeToken: DStakeToken;

      const setupFixture = deployments.createFixture(async (hre) => {
        // Deploy all required contracts in a single fixture call to avoid state reset issues
        // Use mock dStake deployment to avoid config evaluation issues
        const allTags = [
          "local-setup",     // Mock tokens and oracles
          "oracle",          // Oracle setup
          "dusd",            // dUSD token
          "deth",            // dETH token  
          "mock-dstake",     // Mock dStake contracts (replaces "dStake")
          "mock-metamorpho-vaults",
          "mock-urd",
          "metamorpho-adapters",
          "mock-metamorpho-rewards",
        ];
        
        await deployments.fixture(allTags);

        const { deployer, user1, user2 } = await getNamedAccounts();
        const [ownerSigner, userSigner, treasurySigner, managerSigner] = await ethers.getSigners();
        
        // Get deployed contracts
        const { contract: dStableContract } = await getTokenContractForSymbol(
          hre,
          deployer,
          config.dStableSymbol
        );
        
        const dStakeTokenDeployment = await deployments.get(config.DStakeTokenContractId);
        const dStakeTokenContract = await ethers.getContractAt("DStakeToken", dStakeTokenDeployment.address);
        
        const collateralVaultDeployment = await deployments.get(config.collateralVaultContractId);
        const collateralVaultContract = await ethers.getContractAt(
          "DStakeCollateralVault",
          collateralVaultDeployment.address
        );
        
        const routerDeployment = await deployments.get(config.routerContractId);
        const routerContract = await ethers.getContractAt("DStakeRouterDLend", routerDeployment.address);
        
        const metaMorphoVaultDeployment = await deployments.get(
          `MockMetaMorphoVault_${config.dStableSymbol}`
        );
        const metaMorphoVaultContract = await ethers.getContractAt(
          "MockMetaMorphoVault",
          metaMorphoVaultDeployment.address
        );
        
        const adapterDeployment = await deployments.get(
          `MetaMorphoConversionAdapter_${config.dStableSymbol}`
        );
        const adapterContract = await ethers.getContractAt(
          "MetaMorphoConversionAdapter",
          adapterDeployment.address
        );
        
        const urdDeployment = await deployments.get("MockUniversalRewardsDistributor");
        const urdContract = await ethers.getContractAt(
          "MockUniversalRewardsDistributor",
          urdDeployment.address
        );
        
        const rewardManagerDeployment = await deployments.get(
          `DStakeRewardManagerMetaMorpho_${config.DStakeTokenSymbol}`
        );
        const rewardManagerContract = await ethers.getContractAt(
          "DStakeRewardManagerMetaMorpho",
          rewardManagerDeployment.address
        );
        
        // Deploy a reward token
        const TokenFactory = await ethers.getContractFactory("TestMintableERC20");
        const rewardTokenContract = await TokenFactory.deploy("Reward Token", "RWD", 18);
        
        // Setup initial state
        await dStableContract.mint(userSigner.address, ethers.parseEther("10000"));
        // Mint reward tokens to owner for later funding the URD
        await rewardTokenContract.mint(ownerSigner.address, ethers.parseEther("1000"));
        
        return {
          owner: ownerSigner,
          user: userSigner,
          treasury: treasurySigner,
          manager: managerSigner,
          dStable: dStableContract as TestMintableERC20,
          rewardToken: rewardTokenContract,
          metaMorphoVault: metaMorphoVaultContract,
          urd: urdContract,
          collateralVault: collateralVaultContract,
          router: routerContract,
          adapter: adapterContract,
          rewardManager: rewardManagerContract,
          dStakeToken: dStakeTokenContract,
          config,
        };
      });
      
      beforeEach(async function () {
        const fixture = await setupFixture();
        owner = fixture.owner;
        user = fixture.user;
        treasury = fixture.treasury;
        manager = fixture.manager;
        dStable = fixture.dStable;
        rewardToken = fixture.rewardToken;
        metaMorphoVault = fixture.metaMorphoVault;
        urd = fixture.urd;
        collateralVault = fixture.collateralVault;
        router = fixture.router;
        adapter = fixture.adapter;
        rewardManager = fixture.rewardManager;
        dStakeToken = fixture.dStakeToken;
        
        // Grant manager role
        const REWARDS_MANAGER_ROLE = await rewardManager.REWARDS_MANAGER_ROLE();
        await rewardManager.grantRole(REWARDS_MANAGER_ROLE, manager.address);
      });
      
      describe("Deployment", function () {
        it("should deploy with correct configuration", async function () {
          expect(await rewardManager.dStakeCollateralVault()).to.equal(collateralVault.target);
          expect(await rewardManager.dStakeRouter()).to.equal(router.target);
          expect(await rewardManager.metaMorphoVault()).to.equal(metaMorphoVault.target);
          expect(await rewardManager.urd()).to.equal(urd.target);
          expect(await rewardManager.exchangeAsset()).to.equal(dStable.target);
        });
        
        it("should have correct adapter registered in router", async function () {
          const registeredAdapter = await router.vaultAssetToAdapter(metaMorphoVault.target);
          expect(registeredAdapter).to.equal(adapter.target);
        });
      });
      
      describe("Reward Skimming", function () {
        beforeEach(async function () {
          await metaMorphoVault.setSkimRecipient(urd.target);
          await rewardToken.mint(metaMorphoVault.target, ethers.parseEther("100"));
        });
        
        it("should skim rewards from MetaMorpho vault", async function () {
          const balanceBefore = await rewardToken.balanceOf(urd.target);
          
          await expect(rewardManager.connect(manager).skimRewards([rewardToken.target]))
            .to.emit(rewardManager, "RewardsSkimmed")
            .withArgs(rewardToken.target, ethers.parseEther("100"));
          
          const balanceAfter = await rewardToken.balanceOf(urd.target);
          expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("100"));
        });
      });
      
      describe("URD Integration", function () {
        beforeEach(async function () {
          await urd.setPendingReward(collateralVault.target, rewardToken.target, ethers.parseEther("100"));
          // Approve URD to spend reward tokens
          await rewardToken.approve(urd.target, ethers.parseEther("100"));
          await urd.fund(rewardToken.target, ethers.parseEther("100"));
        });
        
        it("should claim rewards from URD", async function () {
          const claimData = [{
            rewardToken: rewardToken.target,
            claimableAmount: ethers.parseEther("100"),
            proof: [ethers.keccak256(ethers.toUtf8Bytes("proof"))]
          }];
          
          await expect(rewardManager.connect(manager).claimRewardsFromURD(claimData))
            .to.emit(rewardManager, "RewardsClaimed")
            .withArgs(rewardToken.target, ethers.parseEther("100"));
          
          expect(await rewardToken.balanceOf(rewardManager.target)).to.equal(ethers.parseEther("100"));
        });
      });
      
      describe("Compounding", function () {
        beforeEach(async function () {
          // Setup rewards in reward manager
          await rewardToken.mint(rewardManager.target, ethers.parseEther("100"));
          
          // Setup MetaMorpho vault for deposits
          await dStable.connect(user).approve(metaMorphoVault.target, ethers.MaxUint256);
          await metaMorphoVault.connect(user).deposit(ethers.parseEther("1000"), user.address);
        });
        
        it("should compound rewards into vault", async function () {
          const compoundAmount = ethers.parseEther("50");
          await dStable.connect(user).approve(rewardManager.target, compoundAmount);
          
          const vaultSharesBefore = await metaMorphoVault.balanceOf(collateralVault.target);
          
          await expect(
            rewardManager.connect(user).compoundRewards(
              compoundAmount,
              [rewardToken.target],
              user.address
            )
          ).to.emit(rewardManager, "RewardCompounded")
            .withArgs(dStable.target, compoundAmount, [rewardToken.target]);
          
          const vaultSharesAfter = await metaMorphoVault.balanceOf(collateralVault.target);
          expect(vaultSharesAfter).to.be.gt(vaultSharesBefore);
        });
      });
    });
  });
});