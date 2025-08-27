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
  
  // Address strings to avoid ethers resolveName issues
  let vault1Address: string;
  let vault2Address: string;
  let vault3Address: string;
  let adapter1Address: string;
  let adapter2Address: string;
  let adapter3Address: string;

  /**
   * Comprehensive deployment fixture that sets up:
   * - DStakeRouterMorpho contract 
   * - 3 MetaMorpho vaults with different target allocations
   * - All necessary adapters and configurations
   * - Proper role assignments and permissions
   */
  const setupDStakeMetaMorpho = deployments.createFixture(async ({ deployments, ethers, getNamedAccounts }) => {
    // Start from a fresh deployment state to ensure test isolation
    await deployments.fixture();
    
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
    
    const dStableAddress = await dStableBaseContract.getAddress();
    const dStableContract = await ethers.getContractAt(
      "ERC20StablecoinUpgradeable",
      dStableAddress
    );
    
    // Deploy DStakeRouterMorpho contract (libraries are inlined by compiler)
    const DStakeRouterMorphoFactory = await ethers.getContractFactory("DStakeRouterMorpho");
    
    let dStakeTokenDeployment, collateralVaultDeployment;
    try {
      dStakeTokenDeployment = await deployments.get(config.DStakeTokenContractId);
      collateralVaultDeployment = await deployments.get(config.collateralVaultContractId);
    } catch (error) {
      throw new Error(`Failed to get deployments: ${error.message}. DStake contracts may not be deployed properly.`);
    }
    
    // Ensure we have valid addresses before deployment
    const dStakeTokenAddress = dStakeTokenDeployment?.address;
    const collateralVaultAddress = collateralVaultDeployment?.address;
    
    if (!dStakeTokenAddress || !ethers.isAddress(dStakeTokenAddress)) {
      throw new Error(`Invalid dStakeToken address: ${dStakeTokenAddress}. Contract may not be deployed.`);
    }
    if (!collateralVaultAddress || !ethers.isAddress(collateralVaultAddress)) {
      throw new Error(`Invalid collateralVault address: ${collateralVaultAddress}. Contract may not be deployed.`);
    }
    
    const routerContract = await DStakeRouterMorphoFactory.deploy(
      dStakeTokenAddress,
      collateralVaultAddress
    );
    await routerContract.waitForDeployment();
    
    const dStakeTokenContract = await ethers.getContractAt("DStakeToken", dStakeTokenDeployment.address);
    const collateralVaultContract = await ethers.getContractAt(
      "DStakeCollateralVault",
      collateralVaultDeployment.address
    );
    
    // Deploy 3 MetaMorpho vaults for multi-vault testing
    const MockMetaMorphoFactory = await ethers.getContractFactory("MockMetaMorphoVault");
    const vault1Contract = await MockMetaMorphoFactory.deploy(
      dStableAddress,
      "MetaMorpho Vault 1",
      "MM1"
    );
    await vault1Contract.waitForDeployment();
    
    const vault2Contract = await MockMetaMorphoFactory.deploy(
      dStableAddress,
      "MetaMorpho Vault 2", 
      "MM2"
    );
    await vault2Contract.waitForDeployment();
    
    const vault3Contract = await MockMetaMorphoFactory.deploy(
      dStableAddress,
      "MetaMorpho Vault 3",
      "MM3"
    );
    await vault3Contract.waitForDeployment();
    
    // Get vault addresses before using them
    const vault1Address = await vault1Contract.getAddress();
    const vault2Address = await vault2Contract.getAddress();
    const vault3Address = await vault3Contract.getAddress();
    
    // Deploy adapters for each vault
    const MetaMorphoAdapterFactory = await ethers.getContractFactory("MetaMorphoConversionAdapter");
    const adapter1Contract = await MetaMorphoAdapterFactory.deploy(
      dStableAddress,      // _dStable
      vault1Address,       // _metaMorphoVault
      collateralVaultAddress  // _collateralVault
    );
    await adapter1Contract.waitForDeployment();
    
    const adapter2Contract = await MetaMorphoAdapterFactory.deploy(
      dStableAddress,      // _dStable
      vault2Address,       // _metaMorphoVault
      collateralVaultAddress  // _collateralVault
    );
    await adapter2Contract.waitForDeployment();
    
    const adapter3Contract = await MetaMorphoAdapterFactory.deploy(
      dStableAddress,      // _dStable
      vault3Address,       // _metaMorphoVault
      collateralVaultAddress  // _collateralVault
    );
    await adapter3Contract.waitForDeployment();
    
    // Get adapter addresses
    const adapter1Address = await adapter1Contract.getAddress();
    const adapter2Address = await adapter2Contract.getAddress();
    const adapter3Address = await adapter3Contract.getAddress();
    
    // Get URD
    const urdDeployment = await deployments.get("MockUniversalRewardsDistributor");
    const urdContract = await ethers.getContractAt(
      "MockUniversalRewardsDistributor",
      urdDeployment.address
    );
    
    // Setup vault configurations with target allocations
    
    const vaultConfigs = [
      {
        vault: vault1Address,
        adapter: adapter1Address,
        targetBps: 500000, // 50% (500,000 out of 1,000,000)
        isActive: true
      },
      {
        vault: vault2Address,
        adapter: adapter2Address,
        targetBps: 300000, // 30% (300,000 out of 1,000,000)
        isActive: true
      },
      {
        vault: vault3Address,
        adapter: adapter3Address,
        targetBps: 200000, // 20% (200,000 out of 1,000,000)
        isActive: true
      }
    ];
    
    // Grant necessary roles before setting vault configs  
    const DEFAULT_ADMIN_ROLE = await routerContract.DEFAULT_ADMIN_ROLE();
    const VAULT_MANAGER_ROLE = await routerContract.VAULT_MANAGER_ROLE();
    const ADAPTER_MANAGER_ROLE = await routerContract.ADAPTER_MANAGER_ROLE();
    const routerContractAddress = await routerContract.getAddress();
    
    // Grant admin role first if not already granted
    const hasAdminRole = await routerContract.hasRole(DEFAULT_ADMIN_ROLE, ownerSigner.address);
    if (!hasAdminRole) {
      await routerContract.grantRole(DEFAULT_ADMIN_ROLE, ownerSigner.address);
    }
    
    // Grant vault manager role
    const hasVaultManagerRole = await routerContract.hasRole(VAULT_MANAGER_ROLE, ownerSigner.address);
    if (!hasVaultManagerRole) {
      await routerContract.grantRole(VAULT_MANAGER_ROLE, ownerSigner.address);
    }
    
    // Grant adapter manager role to owner
    const hasAdapterManagerRole = await routerContract.hasRole(ADAPTER_MANAGER_ROLE, ownerSigner.address);
    if (!hasAdapterManagerRole) {
      await routerContract.grantRole(ADAPTER_MANAGER_ROLE, ownerSigner.address);
    }
    
    // Grant ADAPTER_MANAGER_ROLE to the router contract itself for internal calls
    const routerHasAdapterManagerRole = await routerContract.hasRole(ADAPTER_MANAGER_ROLE, routerContractAddress);
    if (!routerHasAdapterManagerRole) {
      await routerContract.grantRole(ADAPTER_MANAGER_ROLE, routerContractAddress);
    }
    
    console.log("✅ Granted all necessary roles to router contract");
    
    // Setup additional roles and permissions
    const DSTAKE_TOKEN_ROLE = await routerContract.DSTAKE_TOKEN_ROLE();
    const COLLATERAL_EXCHANGER_ROLE = await routerContract.COLLATERAL_EXCHANGER_ROLE();
    const PAUSER_ROLE = await routerContract.PAUSER_ROLE();
    const ROUTER_ROLE = await collateralVaultContract.ROUTER_ROLE();
    
    const dStakeTokenContractAddress = await dStakeTokenContract.getAddress();
    const routerAddress = await routerContract.getAddress();
    
    // Grant roles to appropriate addresses
    await routerContract.grantRole(DSTAKE_TOKEN_ROLE, dStakeTokenContractAddress);
    await routerContract.grantRole(COLLATERAL_EXCHANGER_ROLE, collateralExchangerSigner.address);
    // Grant COLLATERAL_EXCHANGER_ROLE to the router contract itself for internal calls
    await routerContract.grantRole(COLLATERAL_EXCHANGER_ROLE, routerAddress);
    await routerContract.grantRole(PAUSER_ROLE, ownerSigner.address);
    
    console.log("✅ Granted additional roles for testing");
    
    // Properly configure collateralVault with router BEFORE setting vault configs
    const DEFAULT_ADMIN_ROLE_VAULT = await collateralVaultContract.DEFAULT_ADMIN_ROLE();
    const hasVaultAdminRole = await collateralVaultContract.hasRole(DEFAULT_ADMIN_ROLE_VAULT, ownerSigner.address);
    
    if (hasVaultAdminRole) {
      // Set the router on collateralVault - this automatically grants ROUTER_ROLE
      await collateralVaultContract.setRouter(routerAddress);
      console.log("✅ Set router and granted ROUTER_ROLE on collateralVault");
    } else {
      // If no admin role, check if router is already configured
      const currentRouter = await collateralVaultContract.router();
      
      // If there's already a router configured and it's not our router, we need to handle this
      if (currentRouter !== ethers.ZeroAddress && currentRouter !== routerAddress) {
        console.log(`⚠️ CollateralVault already has a different router configured: ${currentRouter}`);
        
        // Try to grant ROUTER_ROLE to our router if we have permission
        try {
          const hasAdminOnVault = await collateralVaultContract.hasRole(DEFAULT_ADMIN_ROLE_VAULT, ownerSigner.address);
          if (hasAdminOnVault) {
            await collateralVaultContract.grantRole(ROUTER_ROLE, routerAddress);
            console.log("✅ Granted ROUTER_ROLE to our router on collateralVault");
          } else {
            // Try using governance signer (index 1) which should have admin role
            const [, governanceSigner] = await ethers.getSigners();
            const hasGovernanceAdminOnVault = await collateralVaultContract.hasRole(DEFAULT_ADMIN_ROLE_VAULT, governanceSigner.address);
            
            if (hasGovernanceAdminOnVault) {
              await collateralVaultContract.connect(governanceSigner).setRouter(routerAddress);
              console.log("✅ Set router on collateralVault using governance signer");
            }
          }
        } catch (e) {
          console.log("Note: Could not grant ROUTER_ROLE - may already be configured");
        }
      } else if (currentRouter === routerAddress) {
        console.log("✅ CollateralVault router already configured correctly");
      } else {
        // No router configured, try to set it if we can
        try {
          await collateralVaultContract.setRouter(routerAddress);
          console.log("✅ Set router on collateralVault");
        } catch (e) {
          console.log("⚠️ Could not set router on collateralVault - continuing anyway");
        }
      }
      
      // Verify router has ROUTER_ROLE regardless of how it was set
      const hasRouterRole = await collateralVaultContract.hasRole(ROUTER_ROLE, routerAddress);
      if (!hasRouterRole) {
        console.log("⚠️ Warning: Router does not have ROUTER_ROLE on collateralVault - some operations may fail");
      }
    }
    
    // NOW set vault configurations - this will automatically call addAdapter and add supported assets
    await routerContract.setVaultConfigs(vaultConfigs);
    console.log("✅ Set vault configurations and added supported assets to collateralVault");
    
    // Verify that vault assets are properly added to supportedAssets and fix if needed
    let supportedAssets = await collateralVaultContract.getSupportedAssets();
    console.log("✅ Supported assets in collateralVault:", supportedAssets);
    
    // Manually ensure each vault asset is supported by calling addAdapter on the router if needed
    for (let i = 0; i < vaultConfigs.length; i++) {
      const vaultAsset = vaultConfigs[i].vault;
      const adapter = vaultConfigs[i].adapter;
      
      if (!supportedAssets.includes(vaultAsset)) {
        console.log(`⚠️ Vault asset ${vaultAsset} not in supported assets, calling addAdapter...`);
        // Call addAdapter to ensure the vault asset is added to supported assets
        await routerContract.addAdapter(vaultAsset, adapter);
        console.log(`✅ Called addAdapter for ${vaultAsset} -> ${adapter}`);
      }
    }
    
    // Verify all assets are now supported
    supportedAssets = await collateralVaultContract.getSupportedAssets();
    console.log("✅ Final supported assets in collateralVault:", supportedAssets);
    
    // Configure dStakeToken router
    const DEFAULT_ADMIN_ROLE_TOKEN = await dStakeTokenContract.DEFAULT_ADMIN_ROLE();
    const hasTokenAdminRole = await dStakeTokenContract.hasRole(DEFAULT_ADMIN_ROLE_TOKEN, ownerSigner.address);
    
    if (hasTokenAdminRole) {
      const currentDStakeRouter = await dStakeTokenContract.router();
      if (currentDStakeRouter !== routerAddress) {
        await dStakeTokenContract.setRouter(routerAddress);
        console.log("✅ Set router on dStakeToken");
      } else {
        console.log("✅ DStakeToken router already configured");
      }
    } else {
      // Check if router is already configured
      const currentDStakeRouter = await dStakeTokenContract.router();
      
      // If there's already a router configured and it's not our router, we may need to handle this
      if (currentDStakeRouter !== ethers.ZeroAddress && currentDStakeRouter !== routerAddress) {
        console.log(`⚠️ DStakeToken already has a different router configured: ${currentDStakeRouter}`);
        
        // Try using governance signer (index 1) which should have admin role
        const [, governanceSigner] = await ethers.getSigners();
        const hasGovernanceAdminRole = await dStakeTokenContract.hasRole(DEFAULT_ADMIN_ROLE_TOKEN, governanceSigner.address);
        
        if (hasGovernanceAdminRole) {
          try {
            await dStakeTokenContract.connect(governanceSigner).setRouter(routerAddress);
            console.log("✅ Set router on dStakeToken using governance signer");
          } catch (e) {
            console.log("⚠️ Could not set router using governance signer - continuing with deployment router");
          }
        } else {
          console.log("⚠️ Governance signer does not have admin role - continuing with deployment router");
        }
      } else if (currentDStakeRouter === routerAddress) {
        console.log("✅ DStakeToken router already configured correctly");
      } else {
        // No router configured, try to set it if we can
        try {
          await dStakeTokenContract.setRouter(routerAddress);
          console.log("✅ Set router on dStakeToken");
        } catch (e) {
          console.log("⚠️ Could not set router on dStakeToken - continuing with deployment router");
        }
      }
    }
    
    // Setup initial balances for testing
    const initialBalance = ethers.parseEther("100000");
    await dStableContract.mint(aliceSigner.address, initialBalance);
    await dStableContract.mint(bobSigner.address, initialBalance);
    await dStableContract.mint(charlieSigner.address, initialBalance);
    
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
      // Add address strings for easier access
      vault1Address,
      vault2Address,
      vault3Address,
      adapter1Address,
      adapter2Address,
      adapter3Address,
    };
  });

  beforeEach(async function () {
    const fixture = await setupDStakeMetaMorpho();
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
    // Assign address strings
    vault1Address = fixture.vault1Address;
    vault2Address = fixture.vault2Address;
    vault3Address = fixture.vault3Address;
    adapter1Address = fixture.adapter1Address;
    adapter2Address = fixture.adapter2Address;
    adapter3Address = fixture.adapter3Address;
  });

  describe("Deployment and Configuration", function () {
    it("Should deploy with correct vault configurations", async function () {
      const vaultCount = await router.getVaultCount();
      expect(vaultCount).to.equal(3);
      
      // Check each vault configuration
      const config1 = await router.getVaultConfigByIndex(0);
      expect(config1.vault).to.equal(vault1Address);
      expect(config1.adapter).to.equal(adapter1Address);
      expect(config1.targetBps).to.equal(500000);
      expect(config1.isActive).to.be.true;
      
      const config2 = await router.getVaultConfigByIndex(1);
      expect(config2.vault).to.equal(vault2Address);
      expect(config2.targetBps).to.equal(300000);
      
      const config3 = await router.getVaultConfigByIndex(2);
      expect(config3.vault).to.equal(vault3Address);
      expect(config3.targetBps).to.equal(200000);
    });

    it("Should have correct active vaults", async function () {
      const activeVaults = await router.getActiveVaults();
      expect(activeVaults).to.have.lengthOf(3);
      expect(activeVaults).to.include(vault1Address);
      expect(activeVaults).to.include(vault2Address);
      expect(activeVaults).to.include(vault3Address);
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

    it("Should select exactly 1 vault per deposit with maxVaultsPerOperation=1", async function () {
      const depositAmount = ethers.parseEther("3000");
      
      await dStable.connect(alice).approve(dStakeToken.target, depositAmount);
      
      // Listen for WeightedDeposit event and verify only 1 vault is selected
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
      
      expect(weightedDepositEvent).to.not.be.undefined;
      const decoded = router.interface.parseLog(weightedDepositEvent!);
      
      // With maxVaultsPerOperation=1 and 3 active vaults, exactly 1 vault should be selected
      expect(decoded.args.selectedVaults).to.have.lengthOf(1);
      
      // Check that funds went to exactly one vault
      const [, currentAllocations] = await router.getCurrentAllocations();
      
      // Should have at least some distribution across vaults over time,
      // but for a single deposit, only one vault gets funds
      let activeCount = 0;
      for (let allocation of currentAllocations) {
        if (allocation > 0) activeCount++;
      }
      
      // Should have exactly 1 vault with funds after first deposit
      expect(activeCount).to.equal(1);
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
      // Ensure all vaults are active (in case previous tests deactivated them)
      await router.updateVaultConfig(vault1.target, adapter1.target, 500000, true);
      await router.updateVaultConfig(vault2.target, adapter2.target, 300000, true);
      await router.updateVaultConfig(vault3.target, adapter3.target, 200000, true);
      
      // Ensure vault1 has some balance by making an additional deposit
      // The initial deposit in beforeEach might not have allocated to vault1
      const vault1BalanceInitial = await vault1.balanceOf(collateralVault.target);
      if (vault1BalanceInitial == 0n) {
        // Make another deposit to ensure vault1 gets some allocation
        const additionalAmount = ethers.parseEther("5000");
        await dStable.connect(alice).approve(dStakeToken.target, additionalAmount);
        await dStakeToken.connect(alice).deposit(additionalAmount, alice.address);
      }
      
      const [vaultsBefore, allocationsBefore] = await router.getCurrentAllocations();
      
      // Get initial balance for vault1 and vault2
      const vault1BalanceBefore = await vault1.balanceOf(collateralVault.target);
      const vault2BalanceBefore = await vault2.balanceOf(collateralVault.target);
      
      // Ensure vault1 has sufficient balance for the exchange
      expect(vault1BalanceBefore).to.be.gt(0, "Vault1 should have balance for exchange");
      
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
        dStable.target,      // _dStable
        newVault.target,     // _metaMorphoVault
        collateralVault.target  // _collateralVault
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
        .withArgs(newVault.target, newAdapter.target, 100000);
      
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
      // First configure to make vault3 inactive and zero allocation, but keep it in the list
      await router.updateVaultConfig(vault3.target, adapter3.target, 0, false);
      
      // Redistribute allocations to remaining vaults to ensure total = 100%
      const newConfigs = [
        {
          vault: vault1.target,
          adapter: adapter1.target,
          targetBps: 700000, // 70%
          isActive: true
        },
        {
          vault: vault2.target,
          adapter: adapter2.target,
          targetBps: 300000, // 30%
          isActive: true
        },
        {
          vault: vault3.target,
          adapter: adapter3.target,
          targetBps: 0, // 0% - must be zero before removal
          isActive: false
        }
      ];
      
      await router.setVaultConfigs(newConfigs);
      
      // Now remove vault3
      await expect(router.removeVaultConfig(vault3.target))
        .to.emit(router, "VaultConfigRemoved")
        .withArgs(vault3.target);
      
      const vaultCount = await router.getVaultCount();
      expect(vaultCount).to.equal(2);
      
      await expect(router.getVaultConfig(vault3.target))
        .to.be.revertedWithCustomError(router, "AdapterNotFound");
    });

    it("Should be idempotent - calling removeVaultConfig twice should not revert", async function () {
      // First configure to make vault3 inactive and zero allocation
      await router.updateVaultConfig(vault3.target, adapter3.target, 0, false);
      
      // Redistribute allocations to remaining vaults to ensure total = 100%
      const newConfigs = [
        {
          vault: vault1.target,
          adapter: adapter1.target,
          targetBps: 700000, // 70%
          isActive: true
        },
        {
          vault: vault2.target,
          adapter: adapter2.target,
          targetBps: 300000, // 30%
          isActive: true
        },
        {
          vault: vault3.target,
          adapter: adapter3.target,
          targetBps: 0, // 0% - must be zero before removal
          isActive: false
        }
      ];
      
      await router.setVaultConfigs(newConfigs);
      
      // First removal - should emit event
      await expect(router.removeVaultConfig(vault3.target))
        .to.emit(router, "VaultConfigRemoved")
        .withArgs(vault3.target);
      
      // Second removal - should not revert and should not emit event (idempotent)
      await expect(router.removeVaultConfig(vault3.target))
        .to.not.emit(router, "VaultConfigRemoved");
      
      // Third removal - still should not revert (truly idempotent)
      await expect(router.removeVaultConfig(vault3.target))
        .to.not.emit(router, "VaultConfigRemoved");
      
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

  describe("MaxVaultsPerOperation Constraints", function () {
    it("Should validate maxVaultsPerOperation with 3 active vaults (max allowed = 1)", async function () {
      // With 3 active vaults, max allowed is max(1, 3/2) = 1
      const maxVaultsPerOperationBefore = await router.maxVaultsPerOperation();
      expect(maxVaultsPerOperationBefore).to.equal(1);
      
      // Setting to 1 should work
      await expect(router.setMaxVaultsPerOperation(1))
        .to.emit(router, "MaxVaultsPerOperationUpdated")
        .withArgs(1, 1);
      
      // Setting to 2 should fail with 3 active vaults
      await expect(router.setMaxVaultsPerOperation(2))
        .to.be.revertedWithCustomError(router, "MaxVaultsPerOperationTooHigh")
        .withArgs(2, 1);
      
      // Setting to 3 should fail with 3 active vaults
      await expect(router.setMaxVaultsPerOperation(3))
        .to.be.revertedWithCustomError(router, "MaxVaultsPerOperationTooHigh")
        .withArgs(3, 1);
    });
    
    it("Should validate maxVaultsPerOperation with 4 active vaults (max allowed = 2)", async function () {
      // Add a fourth vault to test different constraint
      const MockMetaMorphoFactory = await ethers.getContractFactory("MockMetaMorphoVault");
      const vault4 = await MockMetaMorphoFactory.deploy(
        dStable.target,
        "MetaMorpho Vault 4",
        "MM4"
      );
      
      const MetaMorphoAdapterFactory = await ethers.getContractFactory("MetaMorphoConversionAdapter");
      const adapter4 = await MetaMorphoAdapterFactory.deploy(
        dStable.target,      // _dStable
        vault4.target,       // _metaMorphoVault
        collateralVault.target  // _collateralVault
      );
      
      // Add fourth vault with balanced allocations (25% each)
      const newConfigs = [
        {
          vault: vault1.target,
          adapter: adapter1.target,
          targetBps: 250000, // 25%
          isActive: true
        },
        {
          vault: vault2.target,
          adapter: adapter2.target,
          targetBps: 250000, // 25%
          isActive: true
        },
        {
          vault: vault3.target,
          adapter: adapter3.target,
          targetBps: 250000, // 25%
          isActive: true
        },
        {
          vault: vault4.target,
          adapter: adapter4.target,
          targetBps: 250000, // 25%
          isActive: true
        }
      ];
      
      await router.setVaultConfigs(newConfigs);
      
      // With 4 active vaults, max allowed is 4/2 = 2
      await expect(router.setMaxVaultsPerOperation(1))
        .to.emit(router, "MaxVaultsPerOperationUpdated");
      
      await expect(router.setMaxVaultsPerOperation(2))
        .to.emit(router, "MaxVaultsPerOperationUpdated");
      
      // Setting to 3 should fail with 4 active vaults (max allowed = 2)
      await expect(router.setMaxVaultsPerOperation(3))
        .to.be.revertedWithCustomError(router, "MaxVaultsPerOperationTooHigh")
        .withArgs(3, 2);
    });
    
    it("Should validate maxVaultsPerOperation with 5 active vaults (max allowed = 2)", async function () {
      // Add fourth and fifth vaults
      const MockMetaMorphoFactory = await ethers.getContractFactory("MockMetaMorphoVault");
      const vault4 = await MockMetaMorphoFactory.deploy(dStable.target, "Vault 4", "V4");
      const vault5 = await MockMetaMorphoFactory.deploy(dStable.target, "Vault 5", "V5");
      
      const MetaMorphoAdapterFactory = await ethers.getContractFactory("MetaMorphoConversionAdapter");
      const adapter4 = await MetaMorphoAdapterFactory.deploy(dStable.target, vault4.target, collateralVault.target);
      const adapter5 = await MetaMorphoAdapterFactory.deploy(dStable.target, vault5.target, collateralVault.target);
      
      // Configure 5 vaults (20% each)
      const newConfigs = [
        { vault: vault1.target, adapter: adapter1.target, targetBps: 200000, isActive: true },
        { vault: vault2.target, adapter: adapter2.target, targetBps: 200000, isActive: true },
        { vault: vault3.target, adapter: adapter3.target, targetBps: 200000, isActive: true },
        { vault: vault4.target, adapter: adapter4.target, targetBps: 200000, isActive: true },
        { vault: vault5.target, adapter: adapter5.target, targetBps: 200000, isActive: true }
      ];
      
      await router.setVaultConfigs(newConfigs);
      
      // With 5 active vaults, max allowed is 5/2 = 2 (integer division)
      await expect(router.setMaxVaultsPerOperation(2))
        .to.emit(router, "MaxVaultsPerOperationUpdated");
      
      // Setting to 3 should fail
      await expect(router.setMaxVaultsPerOperation(3))
        .to.be.revertedWithCustomError(router, "MaxVaultsPerOperationTooHigh")
        .withArgs(3, 2);
    });
    
    it("Should validate maxVaultsPerOperation with 2 active vaults (max allowed = 1)", async function () {
      // Deactivate vault3, leaving only 2 active vaults
      await router.updateVaultConfig(vault3.target, adapter3.target, 200000, false);
      
      // Update allocations for remaining 2 vaults
      await router.updateVaultConfig(vault1.target, adapter1.target, 600000, true); // 60%
      await router.updateVaultConfig(vault2.target, adapter2.target, 400000, true); // 40%
      
      // With 2 active vaults, max allowed is max(1, 2/2) = 1
      await expect(router.setMaxVaultsPerOperation(1))
        .to.emit(router, "MaxVaultsPerOperationUpdated");
      
      // Setting to 2 should fail
      await expect(router.setMaxVaultsPerOperation(2))
        .to.be.revertedWithCustomError(router, "MaxVaultsPerOperationTooHigh")
        .withArgs(2, 1);
    });
    
    it("Should validate maxVaultsPerOperation with 1 active vault (max allowed = 1)", async function () {
      // Deactivate all but vault1
      await router.updateVaultConfig(vault1.target, adapter1.target, 1000000, true); // 100%
      await router.updateVaultConfig(vault2.target, adapter2.target, 0, false);
      await router.updateVaultConfig(vault3.target, adapter3.target, 0, false);
      
      // With 1 active vault, max allowed is max(1, 1/2) = 1
      await expect(router.setMaxVaultsPerOperation(1))
        .to.emit(router, "MaxVaultsPerOperationUpdated");
      
      // Setting to 2 should fail
      await expect(router.setMaxVaultsPerOperation(2))
        .to.be.revertedWithCustomError(router, "MaxVaultsPerOperationTooHigh")
        .withArgs(2, 1);
    });
    
    it("Should reject maxVaultsPerOperation of 0", async function () {
      await expect(router.setMaxVaultsPerOperation(0))
        .to.be.revertedWithCustomError(router, "InvalidMaxVaultsPerOperation")
        .withArgs(0);
    });
    
    it("Should enforce maxVaultsPerOperation in weighted selection", async function () {
      // Ensure maxVaultsPerOperation is 1
      await router.setMaxVaultsPerOperation(1);
      
      const depositAmount = ethers.parseEther("5000");
      await dStable.connect(alice).approve(dStakeToken.target, depositAmount);
      
      // Make several deposits and verify only 1 vault is selected each time
      for (let i = 0; i < 5; i++) {
        const tx = await dStakeToken.connect(alice).deposit(ethers.parseEther("1000"), alice.address);
        const receipt = await tx.wait();
        
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
        
        // Should always select exactly 1 vault
        expect(decoded.args.selectedVaults).to.have.lengthOf(1);
      }
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
        dStable.target,      // _dStable
        newVault.target,     // _metaMorphoVault
        collateralVault.target  // _collateralVault
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
      
      // Make multiple deposits - new vault should be heavily favored due to 0 current vs 40% target
      let newVaultReceiveDeposit = false;
      
      for (let i = 0; i < 10; i++) {
        const depositAmount = ethers.parseEther("1000");
        await dStable.connect(alice).approve(dStakeToken.target, depositAmount);
        await dStakeToken.connect(alice).deposit(depositAmount, alice.address);
        
        const newVaultBalance = await newVault.balanceOf(collateralVault.target);
        if (newVaultBalance > 0) {
          newVaultReceiveDeposit = true;
          break;
        }
      }
      
      // New vault should have received at least one deposit due to high target allocation (40%) vs current (0%)
      expect(newVaultReceiveDeposit).to.be.true;
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

    it("Should handle large withdrawals across multiple vaults", async function () {
      // Make initial deposit
      const depositAmount = ethers.parseEther("10000");
      await dStable.connect(alice).approve(dStakeToken.target, depositAmount);
      await dStakeToken.connect(alice).deposit(depositAmount, alice.address);
      
      // Test that the system can handle large withdrawals even when there are minor inefficiencies
      // Remove any fees to avoid slippage protection issues
      await vault1.setFees(0, 0); 
      await vault2.setFees(0, 0);
      await vault3.setFees(0, 0);
      
      // Attempt large withdrawal
      const aliceShares = await dStakeToken.balanceOf(alice.address);
      const largeWithdrawShares = aliceShares / 2n; // Try to withdraw 50%
      
      // Should still work but might get less due to fees
      const dStableBalanceBefore = await dStable.balanceOf(alice.address);
      
      await dStakeToken.connect(alice).redeem(largeWithdrawShares, alice.address, alice.address);
      
      const dStableBalanceAfter = await dStable.balanceOf(alice.address);
      const received = dStableBalanceAfter - dStableBalanceBefore;
      
      expect(received).to.be.gt(0);
      // Without fees, received should be very close to the proportional amount
      expect(received).to.be.closeTo(depositAmount / 2n, ethers.parseEther("10"));
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
      
      // Large deposit (reduced to avoid balance issues in tests)
      const largeDeposit = ethers.parseEther("50000");
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
      
      // Both should be under reasonable gas limit for deposits (lower with maxVaultsPerOperation=1)
      expect(gasUsed1).to.be.lt(500000n);
      expect(gasUsed2).to.be.lt(500000n);
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
      expect(gasUsed1).to.be.lt(350000n); // Increased limit to account for new weighted selection logic
      expect(gasUsed2).to.be.lt(350000n);
      
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
      // Allow some tolerance for randomness in weighted selection
      expect(results[vault2.target.toString()]).to.be.gte(results[vault1.target.toString()] - 2);
      expect(results[vault3.target.toString()]).to.be.gte(results[vault1.target.toString()] - 2);
      
      // Combined, vault2 + vault3 should be selected more than vault1
      expect(results[vault2.target.toString()] + results[vault3.target.toString()])
        .to.be.gt(results[vault1.target.toString()]);
      
      // Verify final allocations moved toward targets
      const [, finalAllocations] = await router.getCurrentAllocations();
      
      // Vault1 should have decreased from initial 100% (1000000 bps)
      expect(finalAllocations[0]).to.be.lt(1000000); // Less than 100%
      
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
      await dStakeToken.connect(alice).deposit(initialDeposit, alice.address);
      
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
      const withdrawnShares = aliceShares / 4n;
      const withdrawnAssets = await dStakeToken.previewRedeem(withdrawnShares);
      await dStakeToken.connect(alice).redeem(withdrawnShares, alice.address, alice.address);
      
      // Check final integrity
      const finalTotalAssets = await dStakeToken.totalAssets();
      const expectedTotal = initialDeposit + bobDeposit + charlieDeposit - withdrawnAssets;
      
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
      // With maxVaultsPerOperation=1 and 3 active vaults, exactly 1 vault should be selected
      expect(decoded.args.selectedVaults).to.have.lengthOf(1);
    });
  });
});