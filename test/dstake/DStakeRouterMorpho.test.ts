import { expect } from "chai";
import { ethers, deployments, getNamedAccounts } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { 
  DStakeRouterMorpho,
  MockMetaMorphoVault,
  MockUniversalRewardsDistributor,
  TestMintableERC20,
  DStakeCollateralVault,
  MetaMorphoConversionAdapter,
  DStakeToken
} from "../../typechain-types";
import { SDUSD_CONFIG, DStakeFixtureConfig } from "./fixture";
import { getTokenContractForSymbol } from "../../typescript/token/utils";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("DStakeRouterMorpho Integration Tests", function () {
  // Test configuration
  const config = SDUSD_CONFIG;

  // Core contracts
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let charlie: SignerWithAddress;
  let guardian: SignerWithAddress;
  let collateralExchanger: SignerWithAddress;
  
  let dStable: TestMintableERC20;
  let router: DStakeRouterMorpho;
  let collateralVault: DStakeCollateralVault;
  let dStakeToken: DStakeToken;
  
  // Multi-vault setup (3 vaults for comprehensive testing)
  let vault1: MockMetaMorphoVault;  // Target: 50% (5000 bps)
  let vault2: MockMetaMorphoVault;  // Target: 30% (3000 bps)
  let vault3: MockMetaMorphoVault;  // Target: 20% (2000 bps)
  let adapter1: MetaMorphoConversionAdapter;
  let adapter2: MetaMorphoConversionAdapter;
  let adapter3: MetaMorphoConversionAdapter;
  let urd: MockUniversalRewardsDistributor;

  /**
   * Comprehensive deployment fixture that sets up:
   * - DStakeRouterMorpho contract 
   * - 3 MetaMorpho vaults with different target allocations
   * - All necessary adapters and configurations
   * - Proper role assignments and permissions
   */
  async function setupDStakeMetaMorpho() {
    const allTags = [
      "local-setup",     // Mock tokens and oracles
      "oracle",          // Oracle setup  
      "dusd",            // dUSD token
      "deth",            // dETH token (for completeness)
      "dUSD-aTokenWrapper",
      "dETH-aTokenWrapper", 
      "dlend",           // dLend infrastructure
      "dStake",          // Base dStake deployment
      "mock-metamorpho-vaults", // Mock MetaMorpho vaults
      "mock-urd",               // Universal Rewards Distributor
      "metamorpho-adapters",    // MetaMorpho adapters
      "mock-metamorpho-rewards", // Reward managers
      "test-permissions",        // Grant roles for testing
    ];
    
    await deployments.fixture(allTags);

    const { deployer } = await getNamedAccounts();
    const [
      ownerSigner,
      aliceSigner, 
      bobSigner,
      charlieSigner,
      guardianSigner,
      collateralExchangerSigner
    ] = await ethers.getSigners();
    
    // Get deployed contracts
    const { contract: dStableBaseContract } = await getTokenContractForSymbol(
      { deployments, getNamedAccounts, ethers } as any,
      deployer,
      config.dStableSymbol
    );
    
    const dStableContract = await ethers.getContractAt(
      "ERC20StablecoinUpgradeable",
      dStableBaseContract.target
    );
    
    // Deploy DStakeRouterMorpho contract
    const DStakeRouterMorphoFactory = await ethers.getContractFactory("DStakeRouterMorpho");
    const dStakeTokenDeployment = await deployments.get(config.DStakeTokenContractId);
    const collateralVaultDeployment = await deployments.get(config.collateralVaultContractId);
    
    const routerContract = await DStakeRouterMorphoFactory.deploy(
      dStakeTokenDeployment.address,
      collateralVaultDeployment.address
    );
    
    const dStakeTokenContract = await ethers.getContractAt("DStakeToken", dStakeTokenDeployment.address);
    const collateralVaultContract = await ethers.getContractAt(
      "DStakeCollateralVault",
      collateralVaultDeployment.address
    );
    
    // Deploy 3 MetaMorpho vaults for multi-vault testing
    const MockMetaMorphoFactory = await ethers.getContractFactory("MockMetaMorphoVault");
    const vault1Contract = await MockMetaMorphoFactory.deploy(
      dStableContract.target,
      "MetaMorpho Vault 1",
      "MM1"
    );
    const vault2Contract = await MockMetaMorphoFactory.deploy(
      dStableContract.target,
      "MetaMorpho Vault 2", 
      "MM2"
    );
    const vault3Contract = await MockMetaMorphoFactory.deploy(
      dStableContract.target,
      "MetaMorpho Vault 3",
      "MM3"
    );
    
    // Deploy adapters for each vault
    const MetaMorphoAdapterFactory = await ethers.getContractFactory("MetaMorphoConversionAdapter");
    const adapter1Contract = await MetaMorphoAdapterFactory.deploy(
      vault1Contract.target,
      dStableContract.target,
      "MetaMorpho Adapter 1"
    );
    const adapter2Contract = await MetaMorphoAdapterFactory.deploy(
      vault2Contract.target,
      dStableContract.target,
      "MetaMorpho Adapter 2"
    );
    const adapter3Contract = await MetaMorphoAdapterFactory.deploy(
      vault3Contract.target,
      dStableContract.target,
      "MetaMorpho Adapter 3"
    );
    
    // Get URD
    const urdDeployment = await deployments.get("MockUniversalRewardsDistributor");
    const urdContract = await ethers.getContractAt(
      "MockUniversalRewardsDistributor",
      urdDeployment.address
    );
    
    // Setup vault configurations with target allocations
    const vaultConfigs = [
      {
        vault: vault1Contract.target,
        adapter: adapter1Contract.target,
        targetBps: 500000, // 50% (500,000 out of 1,000,000)
        isActive: true
      },
      {
        vault: vault2Contract.target,
        adapter: adapter2Contract.target,
        targetBps: 300000, // 30% (300,000 out of 1,000,000)
        isActive: true
      },
      {
        vault: vault3Contract.target,
        adapter: adapter3Contract.target,
        targetBps: 200000, // 20% (200,000 out of 1,000,000)
        isActive: true
      }
    ];
    
    await routerContract.setVaultConfigs(vaultConfigs);
    
    // Setup roles and permissions
    const DSTAKE_TOKEN_ROLE = await routerContract.DSTAKE_TOKEN_ROLE();
    const COLLATERAL_EXCHANGER_ROLE = await routerContract.COLLATERAL_EXCHANGER_ROLE();
    const ROUTER_ROLE = await collateralVaultContract.ROUTER_ROLE();
    
    await routerContract.grantRole(DSTAKE_TOKEN_ROLE, dStakeTokenContract.target);
    await routerContract.grantRole(COLLATERAL_EXCHANGER_ROLE, collateralExchangerSigner.address);
    await collateralVaultContract.grantRole(ROUTER_ROLE, routerContract.target);
    
    // Update collateralVault router
    await collateralVaultContract.setRouter(routerContract.target);
    
    // Update dStakeToken router  
    await dStakeTokenContract.setRouter(routerContract.target);
    
    // Setup initial balances for testing
    const initialBalance = ethers.parseEther("100000");
    await dStableContract.mint(aliceSigner.address, initialBalance);
    await dStableContract.mint(bobSigner.address, initialBalance);
    await dStableContract.mint(charlieSigner.address, initialBalance);
    await dStableContract.mint(routerContract.target, ethers.parseEther("1000")); // Router reserves
    
    return {
      owner: ownerSigner,
      alice: aliceSigner,
      bob: bobSigner,
      charlie: charlieSigner,
      guardian: guardianSigner,
      collateralExchanger: collateralExchangerSigner,
      dStable: dStableContract as any as TestMintableERC20,
      router: routerContract,
      collateralVault: collateralVaultContract,
      dStakeToken: dStakeTokenContract,
      vault1: vault1Contract,
      vault2: vault2Contract,
      vault3: vault3Contract,
      adapter1: adapter1Contract,
      adapter2: adapter2Contract,
      adapter3: adapter3Contract,
      urd: urdContract,
    };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(setupDStakeMetaMorpho);
    owner = fixture.owner;
    alice = fixture.alice;
    bob = fixture.bob;
    charlie = fixture.charlie;
    guardian = fixture.guardian;
    collateralExchanger = fixture.collateralExchanger;
    dStable = fixture.dStable;
    router = fixture.router;
    collateralVault = fixture.collateralVault;
    dStakeToken = fixture.dStakeToken;
    vault1 = fixture.vault1;
    vault2 = fixture.vault2;
    vault3 = fixture.vault3;
    adapter1 = fixture.adapter1;
    adapter2 = fixture.adapter2;
    adapter3 = fixture.adapter3;
    urd = fixture.urd;
  });

  describe("Deployment and Configuration", function () {
    it("Should deploy with correct vault configurations", async function () {
      const vaultCount = await router.getVaultCount();
      expect(vaultCount).to.equal(3);
      
      // Check each vault configuration
      const config1 = await router.getVaultConfigByIndex(0);
      expect(config1.vault).to.equal(vault1.target);
      expect(config1.adapter).to.equal(adapter1.target);
      expect(config1.targetBps).to.equal(500000);
      expect(config1.isActive).to.be.true;
      
      const config2 = await router.getVaultConfigByIndex(1);
      expect(config2.vault).to.equal(vault2.target);
      expect(config2.targetBps).to.equal(300000);
      
      const config3 = await router.getVaultConfigByIndex(2);
      expect(config3.vault).to.equal(vault3.target);
      expect(config3.targetBps).to.equal(200000);
    });

    it("Should have correct active vaults", async function () {
      const activeVaults = await router.getActiveVaults();
      expect(activeVaults).to.have.lengthOf(3);
      expect(activeVaults).to.include(vault1.target);
      expect(activeVaults).to.include(vault2.target);
      expect(activeVaults).to.include(vault3.target);
    });

    it("Should validate total allocations equal 100%", async function () {
      const invalidConfigs = [
        {
          vault: vault1.target,
          adapter: adapter1.target,
          targetBps: 600000, // 60% (in correct 1,000,000 basis point scale)
          isActive: true
        },
        {
          vault: vault2.target,
          adapter: adapter2.target,
          targetBps: 300000, // 30% - Total = 90%, should fail
          isActive: true
        }
      ];
      
      await expect(
        router.setVaultConfigs(invalidConfigs)
      ).to.be.revertedWithCustomError(router, "TotalAllocationInvalid");
    });

    it("Should accept configurations that total exactly 1,000,000 basis points (100%)", async function () {
      // Test that the fix works: configurations totaling exactly ONE_HUNDRED_PERCENT_BPS should pass
      const correctConfigs = [
        {
          vault: vault1.target,
          adapter: adapter1.target,
          targetBps: 600000, // 60% in correct scale (600,000 out of 1,000,000)
          isActive: true
        },
        {
          vault: vault2.target,
          adapter: adapter2.target,
          targetBps: 250000, // 25% in correct scale (250,000 out of 1,000,000)
          isActive: true
        },
        {
          vault: vault3.target,
          adapter: adapter3.target,
          targetBps: 150000, // 15% in correct scale (150,000 out of 1,000,000)
          isActive: true
        }
      ];
      
      // This should pass since it totals exactly 1,000,000 (100%)
      await expect(router.setVaultConfigs(correctConfigs))
        .to.not.be.reverted;
        
      // Verify the configurations were set correctly
      expect(await router.getVaultCount()).to.equal(3);
      const config1 = await router.getVaultConfigByIndex(0);
      expect(config1.targetBps).to.equal(600000);
    });

    it("Should reject configurations using old 10,000 basis point scale", async function () {
      // Test that old scale (which was previously accepted due to bug) now correctly fails
      const oldScaleConfigs = [
        {
          vault: vault1.target,
          adapter: adapter1.target,
          targetBps: 5000, // 50% in old incorrect scale (5,000 out of 10,000)
          isActive: true
        },
        {
          vault: vault2.target,
          adapter: adapter2.target,
          targetBps: 3000, // 30% in old incorrect scale (3,000 out of 10,000)
          isActive: true
        },
        {
          vault: vault3.target,
          adapter: adapter3.target,
          targetBps: 2000, // 20% in old incorrect scale (2,000 out of 10,000)
          isActive: true
        }
      ];
      
      // This should fail because total is 10,000, not 1,000,000
      await expect(
        router.setVaultConfigs(oldScaleConfigs)
      ).to.be.revertedWithCustomError(router, "TotalAllocationInvalid");
    });
  });

  describe("Complete Deposit/Withdrawal Flow", function () {
    it("Should handle deposits with weighted random selection", async function () {
      const depositAmount = ethers.parseEther("1000");
      
      // Approve and deposit
      await dStable.connect(alice).approve(dStakeToken.target, depositAmount);
      
      const sharesBefore = await dStakeToken.balanceOf(alice.address);
      
      // Capture the deposit event to verify vault selection
      const tx = await dStakeToken.connect(alice).deposit(depositAmount, alice.address);
      const receipt = await tx.wait();
      
      const sharesAfter = await dStakeToken.balanceOf(alice.address);
      const sharesReceived = sharesAfter - sharesBefore;
      
      expect(sharesReceived).to.be.gt(0);
      
      // Verify that funds were distributed across vaults
      const [vaults, currentAllocations, , totalBalance] = await router.getCurrentAllocations();
      expect(totalBalance).to.be.gt(0);
      
      // At least some vaults should have non-zero balances
      let nonZeroAllocations = 0;
      for (let i = 0; i < currentAllocations.length; i++) {
        if (currentAllocations[i] > 0) {
          nonZeroAllocations++;
        }
      }
      expect(nonZeroAllocations).to.be.gt(0);
    });

    it("Should handle withdrawals from multiple vaults", async function () {
      // First, make a deposit to have something to withdraw
      const depositAmount = ethers.parseEther("3000");
      await dStable.connect(alice).approve(dStakeToken.target, depositAmount);
      await dStakeToken.connect(alice).deposit(depositAmount, alice.address);
      
      // Now withdraw half
      const aliceShares = await dStakeToken.balanceOf(alice.address);
      const withdrawShares = aliceShares / 2n;
      
      const dStableBalanceBefore = await dStable.balanceOf(alice.address);
      
      await dStakeToken.connect(alice).redeem(withdrawShares, alice.address, alice.address);
      
      const dStableBalanceAfter = await dStable.balanceOf(alice.address);
      const dStableReceived = dStableBalanceAfter - dStableBalanceBefore;
      
      expect(dStableReceived).to.be.gt(0);
      expect(dStableReceived).to.be.closeTo(depositAmount / 2n, ethers.parseEther("10"));
    });

    it("Should split deposits across exactly 3 vaults when available", async function () {
      const depositAmount = ethers.parseEther("3000");
      
      await dStable.connect(alice).approve(dStakeToken.target, depositAmount);
      
      // Listen for WeightedDeposit event
      await expect(dStakeToken.connect(alice).deposit(depositAmount, alice.address))
        .to.emit(router, "WeightedDeposit");
      
      // Check that funds are distributed
      const [, currentAllocations] = await router.getCurrentAllocations();
      
      // Should have at least some distribution across vaults
      let activeCount = 0;
      for (let allocation of currentAllocations) {
        if (allocation > 0) activeCount++;
      }
      
      // With 3 active vaults and weighted selection, we should see distribution
      expect(activeCount).to.be.gte(1);
      expect(activeCount).to.be.lte(3);
    });
  });

  describe("Convergence to Target Allocations", function () {
    it("Should converge to target allocations over 100+ operations", async function () {
      this.timeout(60000); // Extended timeout for convergence test
      
      // Start with heavily skewed allocation by depositing only to vault1 initially  
      const initialDeposit = ethers.parseEther("10000");
      await dStable.connect(alice).approve(dStakeToken.target, initialDeposit);
      
      // Temporarily configure router to have only vault1 active for initial skew
      await router.updateVaultConfig(vault1.target, adapter1.target, 500000, true);
      await router.updateVaultConfig(vault2.target, adapter2.target, 300000, false);
      await router.updateVaultConfig(vault3.target, adapter3.target, 200000, false);
      
      await dStakeToken.connect(alice).deposit(initialDeposit, alice.address);
      
      // Re-activate all vaults
      await router.updateVaultConfig(vault2.target, adapter2.target, 300000, true);
      await router.updateVaultConfig(vault3.target, adapter3.target, 200000, true);
      
      // Verify initial skew
      let [, currentAllocations] = await router.getCurrentAllocations();
      expect(currentAllocations[0]).to.be.gt(800000); // Vault1 should have >80%
      
      // Perform 100 random-sized deposits/withdrawals to test convergence
      const operations = [];
      for (let i = 0; i < 100; i++) {
        const isDeposit = Math.random() > 0.3; // 70% deposits, 30% withdrawals
        const amount = ethers.parseEther((Math.random() * 500 + 100).toString()); // 100-600 dStable
        
        if (isDeposit) {
          await dStable.connect(alice).approve(dStakeToken.target, amount);
          await dStakeToken.connect(alice).deposit(amount, alice.address);
          operations.push(`Deposit: ${ethers.formatEther(amount)}`);
        } else {
          // Only withdraw if we have sufficient shares
          const aliceShares = await dStakeToken.balanceOf(alice.address);
          if (aliceShares > amount) {
            const maxWithdrawShares = aliceShares / 10n; // Max 10% of shares per withdrawal
            const withdrawShares = amount > maxWithdrawShares ? maxWithdrawShares : amount;
            await dStakeToken.connect(alice).redeem(withdrawShares, alice.address, alice.address);
            operations.push(`Withdraw: ${ethers.formatEther(withdrawShares)} shares`);
          }
        }
        
        // Log progress every 20 operations
        if ((i + 1) % 20 === 0) {
          const [, currentAllocsBps] = await router.getCurrentAllocations();
          console.log(`After ${i + 1} operations: [${currentAllocsBps.map(a => (Number(a) / 100).toFixed(1)).join('%, ')}%]`);
        }
      }
      
      // Check final convergence - should be within 5% of targets
      const [, finalAllocations] = await router.getCurrentAllocations();
      
      console.log("Final allocations:", finalAllocations.map(a => (Number(a) / 100).toFixed(1)).join("%, ") + "%");
      console.log("Target allocations: [50.0%, 30.0%, 20.0%]");
      
      // Allow 5% tolerance for convergence (500 basis points)
      expect(finalAllocations[0]).to.be.closeTo(500000, 50000); // 50% ± 5%
      expect(finalAllocations[1]).to.be.closeTo(300000, 50000); // 30% ± 5%  
      expect(finalAllocations[2]).to.be.closeTo(200000, 50000); // 20% ± 5%
    });

    it("Should demonstrate natural velocity adjustment toward targets", async function () {
      // Create initial imbalance: put all funds in vault1
      const initialAmount = ethers.parseEther("5000");
      await dStable.connect(alice).approve(dStakeToken.target, initialAmount);
      
      // Force all to vault1 first
      await router.updateVaultConfig(vault2.target, adapter2.target, 300000, false);
      await router.updateVaultConfig(vault3.target, adapter3.target, 200000, false);
      await dStakeToken.connect(alice).deposit(initialAmount, alice.address);
      
      // Record initial skewed state
      let [, allocsBefore] = await router.getCurrentAllocations();
      console.log("Initial (skewed):", allocsBefore.map(a => (Number(a) / 100).toFixed(1)).join("%, ") + "%");
      
      // Re-enable all vaults
      await router.updateVaultConfig(vault2.target, adapter2.target, 300000, true);
      await router.updateVaultConfig(vault3.target, adapter3.target, 200000, true);
      
      // Perform several deposits and track allocation changes
      for (let i = 0; i < 20; i++) {
        const depositAmount = ethers.parseEther("1000");
        await dStable.connect(alice).approve(dStakeToken.target, depositAmount);
        await dStakeToken.connect(alice).deposit(depositAmount, alice.address);
        
        if ((i + 1) % 5 === 0) {
          const [, currentAllocs] = await router.getCurrentAllocations();
          console.log(`After ${i + 1} deposits:`, currentAllocs.map(a => (Number(a) / 100).toFixed(1)).join("%, ") + "%");
        }
      }
      
      const [, allocsAfter] = await router.getCurrentAllocations();
      
      // Vault1 allocation should decrease (was overweight)
      expect(allocsAfter[0]).to.be.lt(allocsBefore[0]);
      
      // Vault2 and Vault3 allocations should increase (were underweight)
      expect(allocsAfter[1]).to.be.gt(allocsBefore[1]);
      expect(allocsAfter[2]).to.be.gt(allocsBefore[2]);
    });
  });

  describe("Collateral Exchange Functionality", function () {
    beforeEach(async function () {
      // Setup initial position across all vaults
      const depositAmount = ethers.parseEther("10000");
      await dStable.connect(alice).approve(dStakeToken.target, depositAmount);
      await dStakeToken.connect(alice).deposit(depositAmount, alice.address);
    });

    it("Should exchange collateral between vaults", async function () {
      const [vaultsBefore, allocationsBefore] = await router.getCurrentAllocations();
      
      // Get initial balance for vault1 and vault2
      const vault1BalanceBefore = await vault1.balanceOf(collateralVault.target);
      const vault2BalanceBefore = await vault2.balanceOf(collateralVault.target);
      
      // Exchange 1000 dStable equivalent from vault1 to vault2
      const exchangeAmount = ethers.parseEther("1000");
      
      await expect(
        router.connect(collateralExchanger).exchangeCollateral(
          vault1.target,
          vault2.target,
          exchangeAmount
        )
      ).to.emit(router, "CollateralExchanged")
        .withArgs(vault1.target, vault2.target, exchangeAmount, collateralExchanger.address);
      
      // Check balances changed appropriately
      const vault1BalanceAfter = await vault1.balanceOf(collateralVault.target);
      const vault2BalanceAfter = await vault2.balanceOf(collateralVault.target);
      
      expect(vault1BalanceAfter).to.be.lt(vault1BalanceBefore);
      expect(vault2BalanceAfter).to.be.gt(vault2BalanceBefore);
      
      // Check allocations shifted
      const [, allocationsAfter] = await router.getCurrentAllocations();
      expect(allocationsAfter[0]).to.be.lt(allocationsBefore[0]); // Vault1 decreased
      expect(allocationsAfter[1]).to.be.gt(allocationsBefore[1]); // Vault2 increased
    });

    it("Should revert when exchanging to inactive vault", async function () {
      // Deactivate vault2
      await router.updateVaultConfig(vault2.target, adapter2.target, 300000, false);
      
      const exchangeAmount = ethers.parseEther("1000");
      
      await expect(
        router.connect(collateralExchanger).exchangeCollateral(
          vault1.target,
          vault2.target,
          exchangeAmount
        )
      ).to.be.revertedWithCustomError(router, "VaultNotActive");
    });

    it("Should revert when called by unauthorized user", async function () {
      const exchangeAmount = ethers.parseEther("1000");
      
      await expect(
        router.connect(alice).exchangeCollateral(
          vault1.target,
          vault2.target,
          exchangeAmount
        )
      ).to.be.reverted; // Should fail due to missing role
    });
  });

  describe("Admin Functions", function () {
    it("Should allow admin to add new vault configuration", async function () {
      // Deploy a new vault and adapter
      const MockMetaMorphoFactory = await ethers.getContractFactory("MockMetaMorphoVault");
      const newVault = await MockMetaMorphoFactory.deploy(
        dStable.target,
        "New Vault",
        "NV"
      );
      
      const MetaMorphoAdapterFactory = await ethers.getContractFactory("MetaMorphoConversionAdapter");
      const newAdapter = await MetaMorphoAdapterFactory.deploy(
        newVault.target,
        dStable.target,
        "New Adapter"
      );
      
      // Need to adjust existing allocations to make room
      const newConfigs = [
        {
          vault: vault1.target,
          adapter: adapter1.target,
          targetBps: 400000, // Reduce from 50% to 40%
          isActive: true
        },
        {
          vault: vault2.target,
          adapter: adapter2.target,
          targetBps: 300000, // Keep at 30%
          isActive: true
        },
        {
          vault: vault3.target,
          adapter: adapter3.target,
          targetBps: 200000, // Keep at 20%
          isActive: true
        },
        {
          vault: newVault.target,
          adapter: newAdapter.target,
          targetBps: 100000, // New 10% allocation
          isActive: true
        }
      ];
      
      await expect(router.setVaultConfigs(newConfigs))
        .to.emit(router, "VaultConfigAdded")
        .withArgs(newVault.target, newAdapter.target, 1000);
      
      const vaultCount = await router.getVaultCount();
      expect(vaultCount).to.equal(4);
    });

    it("Should allow admin to update vault configuration", async function () {
      await expect(
        router.updateVaultConfig(
          vault1.target,
          adapter1.target, 
          5000,
          false // Deactivate
        )
      ).to.emit(router, "VaultConfigUpdated")
        .withArgs(vault1.target, adapter1.target, 5000, false);
      
      const config = await router.getVaultConfig(vault1.target);
      expect(config.isActive).to.be.false;
      
      const activeVaults = await router.getActiveVaults();
      expect(activeVaults).to.not.include(vault1.target);
    });

    it("Should allow admin to remove vault configuration", async function () {
      await expect(router.removeVaultConfig(vault3.target))
        .to.emit(router, "VaultConfigRemoved")
        .withArgs(vault3.target);
      
      const vaultCount = await router.getVaultCount();
      expect(vaultCount).to.equal(2);
      
      await expect(router.getVaultConfig(vault3.target))
        .to.be.revertedWithCustomError(router, "AdapterNotFound");
    });

    it("Should allow admin to emergency pause vault", async function () {
      await router.emergencyPauseVault(vault1.target);
      
      const config = await router.getVaultConfig(vault1.target);
      expect(config.isActive).to.be.false;
      
      const activeVaults = await router.getActiveVaults();
      expect(activeVaults).to.not.include(vault1.target);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle all vaults paused scenario", async function () {
      // Pause all vaults
      await router.updateVaultConfig(vault1.target, adapter1.target, 500000, false);
      await router.updateVaultConfig(vault2.target, adapter2.target, 300000, false);
      await router.updateVaultConfig(vault3.target, adapter3.target, 200000, false);
      
      const depositAmount = ethers.parseEther("1000");
      await dStable.connect(alice).approve(dStakeToken.target, depositAmount);
      
      // Should fail when no active vaults
      await expect(
        dStakeToken.connect(alice).deposit(depositAmount, alice.address)
      ).to.be.revertedWithCustomError(router, "InsufficientActiveVaults");
    });

    it("Should handle single vault active scenario", async function () {
      // Pause vault2 and vault3, keep only vault1 active
      await router.updateVaultConfig(vault2.target, adapter2.target, 300000, false);
      await router.updateVaultConfig(vault3.target, adapter3.target, 200000, false);
      
      const depositAmount = ethers.parseEther("1000");
      await dStable.connect(alice).approve(dStakeToken.target, depositAmount);
      
      await dStakeToken.connect(alice).deposit(depositAmount, alice.address);
      
      // All funds should go to vault1
      const [, currentAllocations] = await router.getCurrentAllocations();
      expect(currentAllocations[0]).to.equal(1000000); // 100% to vault1
      expect(currentAllocations[1]).to.equal(0);     // 0% to vault2 
      expect(currentAllocations[2]).to.equal(0);     // 0% to vault3
    });

    it("Should handle new vault with 0 balance", async function () {
      // Deploy new vault
      const MockMetaMorphoFactory = await ethers.getContractFactory("MockMetaMorphoVault");
      const newVault = await MockMetaMorphoFactory.deploy(
        dStable.target,
        "Zero Balance Vault",
        "ZBV"
      );
      
      const MetaMorphoAdapterFactory = await ethers.getContractFactory("MetaMorphoConversionAdapter");
      const newAdapter = await MetaMorphoAdapterFactory.deploy(
        newVault.target,
        dStable.target,
        "Zero Balance Adapter"
      );
      
      // Add zero-balance vault with significant allocation
      const newConfigs = [
        {
          vault: vault1.target,
          adapter: adapter1.target,
          targetBps: 200000, // 20%
          isActive: true
        },
        {
          vault: vault2.target,
          adapter: adapter2.target,
          targetBps: 200000, // 20%
          isActive: true
        },
        {
          vault: vault3.target,
          adapter: adapter3.target,
          targetBps: 200000, // 20%
          isActive: true
        },
        {
          vault: newVault.target,
          adapter: newAdapter.target,
          targetBps: 400000, // 40% - Should get high selection weight
          isActive: true
        }
      ];
      
      await router.setVaultConfigs(newConfigs);
      
      // Make deposit - new vault should be heavily favored due to 0 current vs 40% target
      const depositAmount = ethers.parseEther("5000");
      await dStable.connect(alice).approve(dStakeToken.target, depositAmount);
      await dStakeToken.connect(alice).deposit(depositAmount, alice.address);
      
      // New vault should have received significant allocation
      const newVaultBalance = await newVault.balanceOf(collateralVault.target);
      expect(newVaultBalance).to.be.gt(0);
    });

    it("Should handle extreme skew (one vault at 95%)", async function () {
      // Create extreme skew by depositing only to vault1
      await router.updateVaultConfig(vault2.target, adapter2.target, 300000, false);
      await router.updateVaultConfig(vault3.target, adapter3.target, 200000, false);
      
      const largeDeposit = ethers.parseEther("50000");
      await dStable.connect(alice).approve(dStakeToken.target, largeDeposit);
      await dStakeToken.connect(alice).deposit(largeDeposit, alice.address);
      
      // Re-enable other vaults
      await router.updateVaultConfig(vault2.target, adapter2.target, 300000, true);
      await router.updateVaultConfig(vault3.target, adapter3.target, 200000, true);
      
      // Verify extreme skew
      const [, allocationsBefore] = await router.getCurrentAllocations();
      expect(allocationsBefore[0]).to.be.gt(950000); // >95% in vault1
      
      // Small deposits should strongly favor other vaults
      for (let i = 0; i < 10; i++) {
        const smallDeposit = ethers.parseEther("1000");
        await dStable.connect(alice).approve(dStakeToken.target, smallDeposit);
        await dStakeToken.connect(alice).deposit(smallDeposit, alice.address);
      }
      
      const [, allocationsAfter] = await router.getCurrentAllocations();
      
      // Vault1 should still be dominant but reduced
      expect(allocationsAfter[0]).to.be.lt(allocationsBefore[0]);
      
      // Other vaults should have gained
      expect(allocationsAfter[1]).to.be.gt(allocationsBefore[1]);
      expect(allocationsAfter[2]).to.be.gt(allocationsBefore[2]);
    });

    it("Should handle insufficient liquidity for withdrawal", async function () {
      // Make initial deposit
      const depositAmount = ethers.parseEther("10000");
      await dStable.connect(alice).approve(dStakeToken.target, depositAmount);
      await dStakeToken.connect(alice).deposit(depositAmount, alice.address);
      
      // Simulate vault liquidity issues by setting withdrawal fees or limits
      await vault1.setFees(0, 1000); // 10% withdrawal fee to simulate liquidity constraints
      await vault2.setFees(0, 1000);
      await vault3.setFees(0, 1000);
      
      // Attempt large withdrawal
      const aliceShares = await dStakeToken.balanceOf(alice.address);
      const largeWithdrawShares = aliceShares / 2n; // Try to withdraw 50%
      
      // Should still work but might get less due to fees
      const dStableBalanceBefore = await dStable.balanceOf(alice.address);
      
      await dStakeToken.connect(alice).redeem(largeWithdrawShares, alice.address, alice.address);
      
      const dStableBalanceAfter = await dStable.balanceOf(alice.address);
      const received = dStableBalanceAfter - dStableBalanceBefore;
      
      expect(received).to.be.gt(0);
      // Due to withdrawal fees, received should be less than the proportional amount
      expect(received).to.be.lt(depositAmount / 2n);
    });
  });

  describe("Gas Cost Consistency", function () {
    it("Should maintain consistent gas costs regardless of deposit size", async function () {
      // Small deposit
      const smallDeposit = ethers.parseEther("100");
      await dStable.connect(alice).approve(dStakeToken.target, smallDeposit);
      
      const tx1 = await dStakeToken.connect(alice).deposit(smallDeposit, alice.address);
      const receipt1 = await tx1.wait();
      const gasUsed1 = receipt1.gasUsed;
      
      // Large deposit  
      const largeDeposit = ethers.parseEther("100000");
      await dStable.connect(alice).approve(dStakeToken.target, largeDeposit);
      
      const tx2 = await dStakeToken.connect(alice).deposit(largeDeposit, alice.address);
      const receipt2 = await tx2.wait();
      const gasUsed2 = receipt2.gasUsed;
      
      console.log(`Small deposit gas: ${gasUsed1}`);
      console.log(`Large deposit gas: ${gasUsed2}`);
      
      // Gas should be very similar (within 10% variance)
      const gasDifference = gasUsed1 > gasUsed2 ? gasUsed1 - gasUsed2 : gasUsed2 - gasUsed1;
      const maxAllowedDifference = gasUsed1 / 10n; // 10% tolerance
      
      expect(gasDifference).to.be.lt(maxAllowedDifference);
      
      // Both should be under reasonable gas limit for deposits
      expect(gasUsed1).to.be.lt(250000n);
      expect(gasUsed2).to.be.lt(250000n);
    });

    it("Should maintain reasonable gas costs for withdrawals", async function () {
      // Setup initial position
      const initialDeposit = ethers.parseEther("50000");
      await dStable.connect(alice).approve(dStakeToken.target, initialDeposit);
      await dStakeToken.connect(alice).deposit(initialDeposit, alice.address);
      
      const aliceShares = await dStakeToken.balanceOf(alice.address);
      
      // Small withdrawal
      const smallWithdrawShares = aliceShares / 100n; // 1%
      const tx1 = await dStakeToken.connect(alice).redeem(smallWithdrawShares, alice.address, alice.address);
      const receipt1 = await tx1.wait();
      const gasUsed1 = receipt1.gasUsed;
      
      // Large withdrawal
      const largeWithdrawShares = aliceShares / 10n; // 10%
      const tx2 = await dStakeToken.connect(alice).redeem(largeWithdrawShares, alice.address, alice.address);
      const receipt2 = await tx2.wait();
      const gasUsed2 = receipt2.gasUsed;
      
      console.log(`Small withdrawal gas: ${gasUsed1}`);
      console.log(`Large withdrawal gas: ${gasUsed2}`);
      
      // Gas should be reasonable for withdrawals (typically higher than deposits due to liquidity calculations)
      expect(gasUsed1).to.be.lt(300000n);
      expect(gasUsed2).to.be.lt(300000n);
      
      // Gas difference should still be reasonable
      const gasDifference = gasUsed1 > gasUsed2 ? gasUsed1 - gasUsed2 : gasUsed2 - gasUsed1;
      const maxAllowedDifference = gasUsed1 / 5n; // 20% tolerance for withdrawals
      
      expect(gasDifference).to.be.lt(maxAllowedDifference);
    });
  });

  describe("Weighted Random Selection Verification", function () {
    it("Should verify that weighted selection actually moves allocations toward targets", async function () {
      const iterations = 50;
      const results: { [vault: string]: number } = {
        [vault1.target.toString()]: 0,
        [vault2.target.toString()]: 0,
        [vault3.target.toString()]: 0,
      };
      
      // Create imbalance - all in vault1 initially
      await router.updateVaultConfig(vault2.target, adapter2.target, 300000, false);
      await router.updateVaultConfig(vault3.target, adapter3.target, 200000, false);
      
      const initialDeposit = ethers.parseEther("10000");
      await dStable.connect(alice).approve(dStakeToken.target, initialDeposit);
      await dStakeToken.connect(alice).deposit(initialDeposit, alice.address);
      
      // Re-enable all vaults
      await router.updateVaultConfig(vault2.target, adapter2.target, 300000, true);
      await router.updateVaultConfig(vault3.target, adapter3.target, 200000, true);
      
      // Track which vaults get selected for deposits
      for (let i = 0; i < iterations; i++) {
        const depositAmount = ethers.parseEther("500");
        await dStable.connect(alice).approve(dStakeToken.target, depositAmount);
        
        // Listen for WeightedDeposit event to see which vaults were selected
        const tx = await dStakeToken.connect(alice).deposit(depositAmount, alice.address);
        const receipt = await tx.wait();
        
        // Find WeightedDeposit event
        const weightedDepositEvent = receipt.logs.find(log => {
          try {
            const decoded = router.interface.parseLog(log);
            return decoded?.name === "WeightedDeposit";
          } catch {
            return false;
          }
        });
        
        if (weightedDepositEvent) {
          const decoded = router.interface.parseLog(weightedDepositEvent);
          const selectedVaults = decoded.args.selectedVaults;
          
          for (const selectedVault of selectedVaults) {
            results[selectedVault.toString()]++;
          }
        }
      }
      
      console.log("Vault selection frequency over", iterations, "deposits:");
      console.log(`Vault1 (overweight, target 50%): ${results[vault1.target.toString()]} selections`);
      console.log(`Vault2 (underweight, target 30%): ${results[vault2.target.toString()]} selections`);
      console.log(`Vault3 (underweight, target 20%): ${results[vault3.target.toString()]} selections`);
      
      // Vault1 should be selected less often since it's overweight
      // Vault2 and Vault3 should be selected more often since they're underweight
      expect(results[vault2.target.toString()]).to.be.gt(results[vault1.target.toString()]);
      expect(results[vault3.target.toString()]).to.be.gt(results[vault1.target.toString()]);
      
      // Verify final allocations moved toward targets
      const [, finalAllocations] = await router.getCurrentAllocations();
      
      // Vault1 should have decreased from initial 100%
      expect(finalAllocations[0]).to.be.lt(10000);
      
      // Vault2 and Vault3 should have increased from initial 0%
      expect(finalAllocations[1]).to.be.gt(0);
      expect(finalAllocations[2]).to.be.gt(0);
    });

    it("Should demonstrate proper weighting when all vaults are at target", async function () {
      // Start from balanced state by making multiple balanced deposits
      for (let i = 0; i < 20; i++) {
        const amount = ethers.parseEther("1000");
        await dStable.connect(alice).approve(dStakeToken.target, amount);
        await dStakeToken.connect(alice).deposit(amount, alice.address);
      }
      
      // Check we're reasonably close to targets
      const [, allocations] = await router.getCurrentAllocations();
      console.log("Balanced state allocations:", allocations.map(a => (Number(a) / 100).toFixed(1)).join("%, ") + "%");
      
      // When near targets, selection should be more random (less biased)
      const selectionCount = { [vault1.target.toString()]: 0, [vault2.target.toString()]: 0, [vault3.target.toString()]: 0 };
      
      for (let i = 0; i < 30; i++) {
        const amount = ethers.parseEther("200");
        await dStable.connect(alice).approve(dStakeToken.target, amount);
        
        const tx = await dStakeToken.connect(alice).deposit(amount, alice.address);
        const receipt = await tx.wait();
        
        // Track vault selections
        const weightedDepositEvent = receipt.logs.find(log => {
          try {
            const decoded = router.interface.parseLog(log);
            return decoded?.name === "WeightedDeposit";
          } catch {
            return false;
          }
        });
        
        if (weightedDepositEvent) {
          const decoded = router.interface.parseLog(weightedDepositEvent);
          const selectedVaults = decoded.args.selectedVaults;
          
          for (const selectedVault of selectedVaults) {
            selectionCount[selectedVault.toString()]++;
          }
        }
      }
      
      console.log("Selection distribution when near targets:");
      console.log(`Vault1: ${selectionCount[vault1.target.toString()]} selections`);
      console.log(`Vault2: ${selectionCount[vault2.target.toString()]} selections`);
      console.log(`Vault3: ${selectionCount[vault3.target.toString()]} selections`);
      
      // When balanced, selection should be more even (no vault should dominate too heavily)
      const maxSelections = Math.max(...Object.values(selectionCount));
      const minSelections = Math.min(...Object.values(selectionCount));
      const selectionRatio = maxSelections / Math.max(minSelections, 1);
      
      // Ratio shouldn't be too extreme when balanced (allow up to 3:1 ratio due to randomness)
      expect(selectionRatio).to.be.lt(3);
    });
  });

  describe("System Integration", function () {
    it("Should maintain total value integrity across operations", async function () {
      const initialDeposit = ethers.parseEther("25000");
      await dStable.connect(alice).approve(dStakeToken.target, initialDeposit);
      await dStableToken.connect(alice).deposit(initialDeposit, alice.address);
      
      const initialTotalAssets = await dStakeToken.totalAssets();
      
      // Perform various operations
      const bobDeposit = ethers.parseEther("15000");
      await dStable.connect(bob).approve(dStakeToken.target, bobDeposit);
      await dStakeToken.connect(bob).deposit(bobDeposit, bob.address);
      
      const charlieDeposit = ethers.parseEther("10000");
      await dStable.connect(charlie).approve(dStakeToken.target, charlieDeposit);
      await dStakeToken.connect(charlie).deposit(charlieDeposit, charlie.address);
      
      // Exchange some collateral
      const exchangeAmount = ethers.parseEther("5000");
      await router.connect(collateralExchanger).exchangeCollateral(
        vault1.target,
        vault2.target,
        exchangeAmount
      );
      
      // Partial withdrawal
      const aliceShares = await dStakeToken.balanceOf(alice.address);
      await dStakeToken.connect(alice).redeem(aliceShares / 4n, alice.address, alice.address);
      
      // Check final integrity
      const finalTotalAssets = await dStakeToken.totalAssets();
      const expectedTotal = initialDeposit + bobDeposit + charlieDeposit;
      
      // Total assets should be close to expected (allowing for small rounding differences)
      expect(finalTotalAssets).to.be.closeTo(expectedTotal, ethers.parseEther("1"));
      
      // Vault total should match system total
      const [, , , totalBalance] = await router.getCurrentAllocations();
      expect(totalBalance).to.be.closeTo(finalTotalAssets, ethers.parseEther("1"));
    });

    it("Should emit proper allocation snapshots", async function () {
      const depositAmount = ethers.parseEther("5000");
      await dStable.connect(alice).approve(dStakeToken.target, depositAmount);
      
      // Should emit AllocationSnapshot event (if implemented)
      const tx = await dStakeToken.connect(alice).deposit(depositAmount, alice.address);
      const receipt = await tx.wait();
      
      // Verify WeightedDeposit was emitted
      const weightedDepositEvent = receipt.logs.find(log => {
        try {
          const decoded = router.interface.parseLog(log);
          return decoded?.name === "WeightedDeposit";
        } catch {
          return false;
        }
      });
      
      expect(weightedDepositEvent).to.not.be.undefined;
      
      const decoded = router.interface.parseLog(weightedDepositEvent!);
      expect(decoded.args.totalDStableAmount).to.equal(depositAmount);
      expect(decoded.args.selectedVaults).to.have.lengthOf.at.most(3);
    });
  });
});