import { expect } from "chai";
import { ethers, deployments, getNamedAccounts } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  DStakeRouterV2,
  MockMetaMorphoVault,
  MockUniversalRewardsDistributor,
  TestMintableERC20,
  DStakeCollateralVault,
  MetaMorphoConversionAdapter,
  DStakeToken
} from "../../typechain-types";
import { SDUSD_CONFIG, DStakeFixtureConfig } from "./fixture";
import { getTokenContractForSymbol } from "../../typescript/token/utils";

describe("DStake Solver Mode Tests", function () {
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
  let router: DStakeRouterV2;
  let collateralVault: DStakeCollateralVault;
  let dStakeToken: DStakeToken;

  // Multi-vault setup (3 vaults for comprehensive testing)
  let vault1: MockMetaMorphoVault;  // Target: 50% (500,000 bps)
  let vault2: MockMetaMorphoVault;  // Target: 30% (300,000 bps)
  let vault3: MockMetaMorphoVault;  // Target: 20% (200,000 bps)
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
   * - DStakeRouterV2 contract
   * - 3 MetaMorpho vaults with different target allocations
   * - All necessary adapters and configurations
   * - Proper role assignments and permissions
   */
  const setupDStakeSolverMode = deployments.createFixture(async ({ deployments, ethers, getNamedAccounts }) => {
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

    const routerDeployment = await deployments.deploy("Test_DStakeRouterV2_SolverMode", {
      contract: "DStakeRouterV2",
      from: deployer,
      args: [dStakeTokenAddress, collateralVaultAddress],
      log: false,
      skipIfAlreadyDeployed: false,
    });
    const routerContract = await ethers.getContractAt("DStakeRouterV2", routerDeployment.address);

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
      collateralVaultAddress,  // _collateralVault
      deployer             // _initialAdmin
    );
    await adapter1Contract.waitForDeployment();

    const adapter2Contract = await MetaMorphoAdapterFactory.deploy(
      dStableAddress,      // _dStable
      vault2Address,       // _metaMorphoVault
      collateralVaultAddress,  // _collateralVault
      deployer             // _initialAdmin
    );
    await adapter2Contract.waitForDeployment();

    const adapter3Contract = await MetaMorphoAdapterFactory.deploy(
      dStableAddress,      // _dStable
      vault3Address,       // _metaMorphoVault
      collateralVaultAddress,  // _collateralVault
      deployer             // _initialAdmin
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
    const fixture = await setupDStakeSolverMode();
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

  describe("Solver Mode: solverDepositAssets", function () {
    it("Should deposit assets into multiple vaults via DStakeToken", async function () {
      const vaults = [vault1Address, vault2Address, vault3Address];
      const assets = [
        ethers.parseEther("1000"), // 1000 to vault1
        ethers.parseEther("600"),  // 600 to vault2
        ethers.parseEther("400")   // 400 to vault3
      ];
      const totalAssets = ethers.parseEther("2000");
      const minShares = ethers.parseEther("1900"); // Allow 5% slippage

      // Approve dStable for dStakeToken
      await dStable.connect(alice).approve(dStakeToken.target, totalAssets);

      const sharesBefore = await dStakeToken.balanceOf(alice.address);
      const dStableBalanceBefore = await dStable.balanceOf(alice.address);

      // Execute solver deposit
      const tx = await dStakeToken.connect(alice).solverDepositAssets(
        vaults,
        assets,
        minShares,
        alice.address
      );

      const sharesAfter = await dStakeToken.balanceOf(alice.address);
      const dStableBalanceAfter = await dStable.balanceOf(alice.address);
      const sharesReceived = sharesAfter - sharesBefore;
      const dStableSpent = dStableBalanceBefore - dStableBalanceAfter;

      // Verify shares received
      expect(sharesReceived).to.be.gte(minShares);
      expect(dStableSpent).to.equal(totalAssets);

      // Verify assets were deposited to correct vaults
      expect(await vault1.balanceOf(collateralVault.target)).to.be.gt(0);
      expect(await vault2.balanceOf(collateralVault.target)).to.be.gt(0);
      expect(await vault3.balanceOf(collateralVault.target)).to.be.gt(0);

      // Verify Deposit event was emitted
      await expect(tx)
        .to.emit(dStakeToken, "Deposit")
        .withArgs(alice.address, alice.address, totalAssets, sharesReceived);
    });

    it("Should revert with slippage protection when minShares not met", async function () {
      const vaults = [vault1Address, vault2Address];
      const assets = [ethers.parseEther("1000"), ethers.parseEther("1000")];
      const totalAssets = ethers.parseEther("2000");
      const minShares = ethers.parseEther("2500"); // Too high, should fail

      await dStable.connect(alice).approve(dStakeToken.target, totalAssets);

      await expect(
        dStakeToken.connect(alice).solverDepositAssets(
          vaults,
          assets,
          minShares,
          alice.address
        )
      ).to.be.revertedWithCustomError(dStakeToken, "ERC4626ExceedsMaxWithdraw");
    });

    it("Should revert when vaults and assets arrays have mismatched lengths", async function () {
      const vaults = [vault1Address, vault2Address];
      const assets = [ethers.parseEther("1000")]; // Mismatched length
      const minShares = ethers.parseEther("900");

      await dStable.connect(alice).approve(dStakeToken.target, ethers.parseEther("1000"));

      await expect(
        dStakeToken.connect(alice).solverDepositAssets(
          vaults,
          assets,
          minShares,
          alice.address
        )
      ).to.be.revertedWithCustomError(router, "ArrayLengthMismatch");
    });

    it("Should revert when empty arrays provided", async function () {
      const vaults: string[] = [];
      const assets: bigint[] = [];
      const minShares = ethers.parseEther("0");

      await expect(
        dStakeToken.connect(alice).solverDepositAssets(
          vaults,
          assets,
          minShares,
          alice.address
        )
      ).to.be.revertedWithCustomError(dStakeToken, "ZeroShares");
    });

    it("Should revert when total assets is zero", async function () {
      const vaults = [vault1Address, vault2Address];
      const assets = [0, 0]; // Zero assets
      const minShares = 0;

      await expect(
        dStakeToken.connect(alice).solverDepositAssets(
          vaults,
          assets,
          minShares,
          alice.address
        )
      ).to.be.revertedWithCustomError(dStakeToken, "ZeroShares");
    });
  });

  describe("Solver Mode: solverDepositShares", function () {
    it("Should deposit shares into multiple vaults via DStakeToken", async function () {
      const vaults = [vault1Address, vault2Address];
      const shares = [ethers.parseEther("500"), ethers.parseEther("300")]; // 500 and 300 shares
      const minShares = ethers.parseEther("700"); // Allow some slippage

      // Calculate expected total assets based on vault previewMint
      const expectedAssets1 = await vault1.previewMint(shares[0]);
      const expectedAssets2 = await vault2.previewMint(shares[1]);
      const totalExpectedAssets = expectedAssets1 + expectedAssets2;

      // Approve dStable for dStakeToken
      await dStable.connect(alice).approve(dStakeToken.target, totalExpectedAssets);

      const sharesBefore = await dStakeToken.balanceOf(alice.address);

      // Execute solver deposit shares
      const tx = await dStakeToken.connect(alice).solverDepositShares(
        vaults,
        shares,
        minShares,
        alice.address
      );

      const sharesAfter = await dStakeToken.balanceOf(alice.address);
      const sharesReceived = sharesAfter - sharesBefore;

      // Verify shares received meets minimum
      expect(sharesReceived).to.be.gte(minShares);

      // Verify assets were deposited to correct vaults
      expect(await vault1.balanceOf(collateralVault.target)).to.be.gt(0);
      expect(await vault2.balanceOf(collateralVault.target)).to.be.gt(0);

      // Verify Deposit event was emitted
      await expect(tx)
        .to.emit(dStakeToken, "Deposit")
        .withArgs(alice.address, alice.address, totalExpectedAssets, sharesReceived);
    });

    it("Should handle zero shares correctly", async function () {
      const vaults = [vault1Address, vault2Address, vault3Address];
      const shares = [ethers.parseEther("1000"), 0, ethers.parseEther("500")]; // Middle vault gets 0
      const minShares = ethers.parseEther("1400");

      // Calculate expected total assets
      const expectedAssets1 = await vault1.previewMint(shares[0]);
      const expectedAssets3 = await vault3.previewMint(shares[2]);
      const totalExpectedAssets = expectedAssets1 + expectedAssets3;

      await dStable.connect(alice).approve(dStakeToken.target, totalExpectedAssets);

      await dStakeToken.connect(alice).solverDepositShares(
        vaults,
        shares,
        minShares,
        alice.address
      );

      // Verify only vault1 and vault3 received deposits
      expect(await vault1.balanceOf(collateralVault.target)).to.be.gt(0);
      expect(await vault2.balanceOf(collateralVault.target)).to.equal(0);
      expect(await vault3.balanceOf(collateralVault.target)).to.be.gt(0);
    });
  });

  describe("Solver Mode: solverWithdrawAssets", function () {
    beforeEach(async function () {
      // Setup initial position by depositing into multiple vaults
      const vaults = [vault1Address, vault2Address, vault3Address];
      const assets = [
        ethers.parseEther("2000"), // 2000 to vault1
        ethers.parseEther("1200"), // 1200 to vault2
        ethers.parseEther("800")   // 800 to vault3
      ];
      const totalAssets = ethers.parseEther("4000");
      const minShares = ethers.parseEther("3800");

      await dStable.connect(alice).approve(dStakeToken.target, totalAssets);
      await dStakeToken.connect(alice).solverDepositAssets(
        vaults,
        assets,
        minShares,
        alice.address
      );
    });

    it("Should withdraw assets from multiple vaults via DStakeToken", async function () {
      const vaults = [vault1Address, vault2Address, vault3Address];
      const assets = [
        ethers.parseEther("500"),  // 500 from vault1
        ethers.parseEther("300"),  // 300 from vault2
        ethers.parseEther("200")   // 200 from vault3
      ];
      const totalAssets = ethers.parseEther("1000");
      const maxShares = ethers.parseEther("1200"); // Allow some slippage

      const sharesBefore = await dStakeToken.balanceOf(alice.address);
      const dStableBalanceBefore = await dStable.balanceOf(alice.address);

      // Execute solver withdrawal
      const tx = await dStakeToken.connect(alice).solverWithdrawAssets(
        vaults,
        assets,
        maxShares,
        alice.address,
        alice.address
      );

      const sharesAfter = await dStakeToken.balanceOf(alice.address);
      const dStableBalanceAfter = await dStable.balanceOf(alice.address);
      const sharesBurned = sharesBefore - sharesAfter;
      const dStableReceived = dStableBalanceAfter - dStableBalanceBefore;

      // Verify shares burned is within max
      expect(sharesBurned).to.be.lte(maxShares);

      // Verify assets received (net amount after fees)
      expect(dStableReceived).to.be.gt(0);
      // Allow for rounding differences and fees - assets received may be slightly more than requested due to vault mechanics
      expect(dStableReceived).to.be.closeTo(totalAssets, ethers.parseEther("50")); // Within reasonable tolerance

      // Verify Withdraw event was emitted
      await expect(tx)
        .to.emit(dStakeToken, "Withdraw");
    });

    it("Should revert when maxShares exceeded", async function () {
      const vaults = [vault1Address, vault2Address];
      const assets = [ethers.parseEther("1000"), ethers.parseEther("1000")];
      const maxShares = ethers.parseEther("100"); // Too low, should fail

      await expect(
        dStakeToken.connect(alice).solverWithdrawAssets(
          vaults,
          assets,
          maxShares,
          alice.address,
          alice.address
        )
      ).to.be.revertedWithCustomError(dStakeToken, "ERC4626ExceedsMaxRedeem");
    });

    it("Should handle partial withdrawals correctly", async function () {
      const vaults = [vault1Address];
      const assets = [ethers.parseEther("100")]; // Small withdrawal
      const maxShares = ethers.parseEther("200");

      const vault1BalanceBefore = await vault1.balanceOf(collateralVault.target);

      await dStakeToken.connect(alice).solverWithdrawAssets(
        vaults,
        assets,
        maxShares,
        alice.address,
        alice.address
      );

      const vault1BalanceAfter = await vault1.balanceOf(collateralVault.target);

      // Verify vault balance decreased
      expect(vault1BalanceAfter).to.be.lt(vault1BalanceBefore);
    });
  });

  describe("Solver Mode: solverWithdrawShares", function () {
    beforeEach(async function () {
      // Setup initial position by depositing into multiple vaults
      const vaults = [vault1Address, vault2Address, vault3Address];
      const assets = [
        ethers.parseEther("2000"),
        ethers.parseEther("1200"),
        ethers.parseEther("800")
      ];
      const totalAssets = ethers.parseEther("4000");
      const minShares = ethers.parseEther("3800");

      await dStable.connect(alice).approve(dStakeToken.target, totalAssets);
      await dStakeToken.connect(alice).solverDepositAssets(
        vaults,
        assets,
        minShares,
        alice.address
      );
    });

    it("Should withdraw shares from multiple vaults via DStakeToken", async function () {
      const vaults = [vault1Address, vault2Address];

      // Get current vault balances to calculate reasonable withdrawal amounts
      const vault1Balance = await vault1.balanceOf(collateralVault.target);
      const vault2Balance = await vault2.balanceOf(collateralVault.target);

      // Withdraw 25% from each vault
      const vaultShares = [vault1Balance / 4n, vault2Balance / 4n];
      const maxShares = ethers.parseEther("1200");

      const sharesBefore = await dStakeToken.balanceOf(alice.address);
      const dStableBalanceBefore = await dStable.balanceOf(alice.address);

      // Execute solver withdrawal by shares
      const tx = await dStakeToken.connect(alice).solverWithdrawShares(
        vaults,
        vaultShares,
        maxShares,
        alice.address,
        alice.address
      );

      const sharesAfter = await dStakeToken.balanceOf(alice.address);
      const dStableBalanceAfter = await dStable.balanceOf(alice.address);
      const sharesBurned = sharesBefore - sharesAfter;
      const dStableReceived = dStableBalanceAfter - dStableBalanceBefore;

      // Verify shares burned is within max
      expect(sharesBurned).to.be.lte(maxShares);

      // Verify assets received
      expect(dStableReceived).to.be.gt(0);

      // Verify vault balances decreased
      expect(await vault1.balanceOf(collateralVault.target)).to.be.lt(vault1Balance);
      expect(await vault2.balanceOf(collateralVault.target)).to.be.lt(vault2Balance);

      // Verify Withdraw event was emitted
      await expect(tx)
        .to.emit(dStakeToken, "Withdraw");
    });

    it("Should handle zero vault shares correctly", async function () {
      const vaults = [vault1Address, vault2Address, vault3Address];

      const vault1Balance = await vault1.balanceOf(collateralVault.target);
      const vaultShares = [vault1Balance / 4n, 0, 0]; // Only withdraw from vault1
      const maxShares = ethers.parseEther("800");

      const vault2BalanceBefore = await vault2.balanceOf(collateralVault.target);
      const vault3BalanceBefore = await vault3.balanceOf(collateralVault.target);

      await dStakeToken.connect(alice).solverWithdrawShares(
        vaults,
        vaultShares,
        maxShares,
        alice.address,
        alice.address
      );

      // Verify only vault1 balance changed
      expect(await vault1.balanceOf(collateralVault.target)).to.be.lt(vault1Balance);
      expect(await vault2.balanceOf(collateralVault.target)).to.equal(vault2BalanceBefore);
      expect(await vault3.balanceOf(collateralVault.target)).to.equal(vault3BalanceBefore);
    });
  });

  describe("Solver Mode: Atomic Failure Behavior", function () {
    it("Should revert entire solverDepositAssets transaction if one vault fails", async function () {
      const vaults = [vault1Address, vault2Address, ethers.ZeroAddress]; // Invalid vault
      const assets = [ethers.parseEther("1000"), ethers.parseEther("500"), ethers.parseEther("300")];
      const totalAssets = ethers.parseEther("1800");
      const minShares = ethers.parseEther("1700");

      await dStable.connect(alice).approve(dStakeToken.target, totalAssets);

      // Should revert due to invalid vault
      await expect(
        dStakeToken.connect(alice).solverDepositAssets(
          vaults,
          assets,
          minShares,
          alice.address
        )
      ).to.be.reverted;

      // Verify no assets were deposited to any vault
      expect(await vault1.balanceOf(collateralVault.target)).to.equal(0);
      expect(await vault2.balanceOf(collateralVault.target)).to.equal(0);
    });

    it("Should revert entire solverWithdrawAssets transaction if one vault fails", async function () {
      // Setup initial position
      const setupVaults = [vault1Address, vault2Address];
      const setupAssets = [ethers.parseEther("2000"), ethers.parseEther("1000")];
      const totalSetupAssets = ethers.parseEther("3000");
      const minShares = ethers.parseEther("2900");

      await dStable.connect(alice).approve(dStakeToken.target, totalSetupAssets);
      await dStakeToken.connect(alice).solverDepositAssets(
        setupVaults,
        setupAssets,
        minShares,
        alice.address
      );

      const vault1BalanceBefore = await vault1.balanceOf(collateralVault.target);
      const vault2BalanceBefore = await vault2.balanceOf(collateralVault.target);

      // Try to withdraw with one invalid vault
      const vaults = [vault1Address, ethers.ZeroAddress]; // Invalid vault
      const assets = [ethers.parseEther("500"), ethers.parseEther("500")];
      const maxShares = ethers.parseEther("1200");

      await expect(
        dStakeToken.connect(alice).solverWithdrawAssets(
          vaults,
          assets,
          maxShares,
          alice.address,
          alice.address
        )
      ).to.be.reverted;

      // Verify no assets were withdrawn from any vault
      expect(await vault1.balanceOf(collateralVault.target)).to.equal(vault1BalanceBefore);
      expect(await vault2.balanceOf(collateralVault.target)).to.equal(vault2BalanceBefore);
    });
  });

  describe("Solver Mode: Direct Router Calls", function () {
    let DSTAKE_TOKEN_ROLE: string;

    beforeEach(async function () {
      DSTAKE_TOKEN_ROLE = await router.DSTAKE_TOKEN_ROLE();
      // Grant DSTAKE_TOKEN_ROLE to alice for direct router testing
      await router.grantRole(DSTAKE_TOKEN_ROLE, alice.address);
    });

    it("Should allow direct solverDepositAssets call with proper role", async function () {
      const vaults = [vault1Address, vault2Address];
      const assets = [ethers.parseEther("1000"), ethers.parseEther("500")];
      const totalAssets = ethers.parseEther("1500");

      // Approve router to spend dStable
      await dStable.connect(alice).approve(router.target, totalAssets);

      const tx = await router.connect(alice).solverDepositAssets(vaults, assets);

      // Verify assets were deposited
      expect(await vault1.balanceOf(collateralVault.target)).to.be.gt(0);
      expect(await vault2.balanceOf(collateralVault.target)).to.be.gt(0);

      // Verify WeightedDeposit event was emitted
      await expect(tx)
        .to.emit(router, "WeightedDeposit")
        .withArgs(vaults, assets, totalAssets, 0);
    });

    it("Should revert direct router call without proper role", async function () {
      const vaults = [vault1Address];
      const assets = [ethers.parseEther("1000")];

      await dStable.connect(bob).approve(router.target, assets[0]);

      await expect(
        router.connect(bob).solverDepositAssets(vaults, assets)
      ).to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
    });

    it("Should allow direct solverWithdrawAssets call with proper role", async function () {
      // Setup initial position via dStakeToken
      const setupVaults = [vault1Address, vault2Address];
      const setupAssets = [ethers.parseEther("2000"), ethers.parseEther("1000")];
      const totalSetupAssets = ethers.parseEther("3000");
      const minShares = ethers.parseEther("2900");

      await dStable.connect(alice).approve(dStakeToken.target, totalSetupAssets);
      await dStakeToken.connect(alice).solverDepositAssets(
        setupVaults,
        setupAssets,
        minShares,
        alice.address
      );

      // Now test direct router withdrawal
      const vaults = [vault1Address];
      const assets = [ethers.parseEther("500")];

      const bobBalanceBefore = await dStable.balanceOf(bob.address);

      const tx = await router.connect(alice).solverWithdrawAssets(
        vaults,
        assets,
        bob.address, // Different receiver
        alice.address
      );

      const bobBalanceAfter = await dStable.balanceOf(bob.address);

      // Verify assets were transferred to bob
      expect(bobBalanceAfter).to.be.gt(bobBalanceBefore);

      // Verify WeightedWithdrawal event was emitted
      await expect(tx)
        .to.emit(router, "WeightedWithdrawal");
    });
  });

  describe("Solver Mode: Event Emissions", function () {
    it("Should emit proper events for solverDepositAssets", async function () {
      const vaults = [vault1Address, vault2Address];
      const assets = [ethers.parseEther("1000"), ethers.parseEther("500")];
      const totalAssets = ethers.parseEther("1500");
      const minShares = ethers.parseEther("1400");

      await dStable.connect(alice).approve(dStakeToken.target, totalAssets);

      const tx = await dStakeToken.connect(alice).solverDepositAssets(
        vaults,
        assets,
        minShares,
        alice.address
      );

      // Verify ERC4626 Deposit event
      await expect(tx)
        .to.emit(dStakeToken, "Deposit");

      // Verify router WeightedDeposit event
      await expect(tx)
        .to.emit(router, "WeightedDeposit")
        .withArgs(vaults, assets, totalAssets, 0);
    });

    it("Should emit proper events for solverWithdrawShares with fees", async function () {
      // Setup with fees - alice needs FEE_MANAGER_ROLE to set fees
      const FEE_MANAGER_ROLE = await dStakeToken.FEE_MANAGER_ROLE();
      await dStakeToken.grantRole(FEE_MANAGER_ROLE, alice.address);
      await dStakeToken.connect(alice).setWithdrawalFee(500); // 0.05% fee

      // Setup initial position
      const setupVaults = [vault1Address];
      const setupAssets = [ethers.parseEther("2000")];
      const totalSetupAssets = ethers.parseEther("2000");
      const minShares = ethers.parseEther("1900");

      await dStable.connect(alice).approve(dStakeToken.target, totalSetupAssets);
      await dStakeToken.connect(alice).solverDepositAssets(
        setupVaults,
        setupAssets,
        minShares,
        alice.address
      );

      // Withdraw
      const vault1Balance = await vault1.balanceOf(collateralVault.target);
      const vaultShares = [vault1Balance / 2n]; // Withdraw half
      const maxShares = ethers.parseEther("1200");

      const tx = await dStakeToken.connect(alice).solverWithdrawShares(
        setupVaults,
        vaultShares,
        maxShares,
        alice.address,
        alice.address
      );

      // Verify Withdraw event
      await expect(tx)
        .to.emit(dStakeToken, "Withdraw");

      // Verify WithdrawalFee event
      await expect(tx)
        .to.emit(dStakeToken, "WithdrawalFee");

      // Verify router WeightedWithdrawal event
      await expect(tx)
        .to.emit(router, "WeightedWithdrawal");
    });
  });

  describe("Solver Mode: Share Accounting Correctness", function () {
    it("Should maintain correct share accounting across multiple solver deposits", async function () {
      const totalAssetsBefore = await dStakeToken.totalAssets();
      const totalSharesBefore = await dStakeToken.totalSupply();

      // First deposit
      const vaults1 = [vault1Address, vault2Address];
      const assets1 = [ethers.parseEther("1000"), ethers.parseEther("500")];
      const totalAssets1 = ethers.parseEther("1500");
      const minShares1 = ethers.parseEther("1400");

      await dStable.connect(alice).approve(dStakeToken.target, totalAssets1);
      await dStakeToken.connect(alice).solverDepositAssets(
        vaults1,
        assets1,
        minShares1,
        alice.address
      );

      const aliceShares1 = await dStakeToken.balanceOf(alice.address);
      const totalAssetsAfter1 = await dStakeToken.totalAssets();
      const totalSharesAfter1 = await dStakeToken.totalSupply();

      // Second deposit by different user
      const vaults2 = [vault2Address, vault3Address];
      const assets2 = [ethers.parseEther("800"), ethers.parseEther("200")];
      const totalAssets2 = ethers.parseEther("1000");
      const minShares2 = ethers.parseEther("950");

      await dStable.connect(bob).approve(dStakeToken.target, totalAssets2);
      await dStakeToken.connect(bob).solverDepositAssets(
        vaults2,
        assets2,
        minShares2,
        bob.address
      );

      const bobShares = await dStakeToken.balanceOf(bob.address);
      const totalAssetsAfter2 = await dStakeToken.totalAssets();
      const totalSharesAfter2 = await dStakeToken.totalSupply();

      // Verify accounting correctness
      expect(totalSharesAfter2).to.equal(aliceShares1 + bobShares);
      expect(totalAssetsAfter2).to.be.closeTo(
        totalAssetsAfter1 + totalAssets2,
        ethers.parseEther("10") // Allow small rounding differences
      );

      // Verify share price is reasonable
      const sharePrice = totalAssetsAfter2 * ethers.parseEther("1") / totalSharesAfter2;
      expect(sharePrice).to.be.closeTo(ethers.parseEther("1"), ethers.parseEther("0.1"));
    });

    it("Should maintain correct accounting during solver withdrawals", async function () {
      // Setup initial positions
      const vaults = [vault1Address, vault2Address, vault3Address];
      const aliceAssets = [ethers.parseEther("1000"), ethers.parseEther("600"), ethers.parseEther("400")];
      const bobAssets = [ethers.parseEther("500"), ethers.parseEther("300"), ethers.parseEther("200")];

      const aliceTotalAssets = ethers.parseEther("2000");
      const bobTotalAssets = ethers.parseEther("1000");

      // Alice deposits
      await dStable.connect(alice).approve(dStakeToken.target, aliceTotalAssets);
      await dStakeToken.connect(alice).solverDepositAssets(
        vaults,
        aliceAssets,
        ethers.parseEther("1900"),
        alice.address
      );

      // Bob deposits
      await dStable.connect(bob).approve(dStakeToken.target, bobTotalAssets);
      await dStakeToken.connect(bob).solverDepositAssets(
        vaults,
        bobAssets,
        ethers.parseEther("950"),
        bob.address
      );

      const totalAssetsBeforeWithdraw = await dStakeToken.totalAssets();
      const totalSharesBeforeWithdraw = await dStakeToken.totalSupply();
      const aliceSharesBeforeWithdraw = await dStakeToken.balanceOf(alice.address);

      // Alice withdraws from specific vaults
      const withdrawVaults = [vault1Address, vault3Address];
      const withdrawAssets = [ethers.parseEther("300"), ethers.parseEther("200")];
      const maxShares = ethers.parseEther("600");

      await dStakeToken.connect(alice).solverWithdrawAssets(
        withdrawVaults,
        withdrawAssets,
        maxShares,
        alice.address,
        alice.address
      );

      const totalAssetsAfterWithdraw = await dStakeToken.totalAssets();
      const totalSharesAfterWithdraw = await dStakeToken.totalSupply();
      const aliceSharesAfterWithdraw = await dStakeToken.balanceOf(alice.address);

      // Verify accounting
      const sharesBurned = aliceSharesBeforeWithdraw - aliceSharesAfterWithdraw;
      const totalSharesChange = totalSharesBeforeWithdraw - totalSharesAfterWithdraw;

      expect(sharesBurned).to.equal(totalSharesChange);
      expect(sharesBurned).to.be.lte(maxShares);

      // Verify assets decreased appropriately (accounting for fees)
      expect(totalAssetsAfterWithdraw).to.be.lt(totalAssetsBeforeWithdraw);

      // Share price should remain reasonable
      const sharePriceAfter = totalAssetsAfterWithdraw * ethers.parseEther("1") / totalSharesAfterWithdraw;
      expect(sharePriceAfter).to.be.closeTo(ethers.parseEther("1"), ethers.parseEther("0.2"));
    });
  });

  describe("Solver Mode: Complex Multi-User Scenarios", function () {
    it("Should handle concurrent solver operations correctly", async function () {
      // Multiple users perform solver operations with different vault combinations

      // Alice: Focus on vault1 and vault2
      const aliceVaults = [vault1Address, vault2Address];
      const aliceAssets = [ethers.parseEther("1500"), ethers.parseEther("500")];
      const aliceTotalAssets = ethers.parseEther("2000");

      await dStable.connect(alice).approve(dStakeToken.target, aliceTotalAssets);
      await dStakeToken.connect(alice).solverDepositAssets(
        aliceVaults,
        aliceAssets,
        ethers.parseEther("1900"),
        alice.address
      );

      // Bob: Focus on vault2 and vault3
      const bobVaults = [vault2Address, vault3Address];
      const bobAssets = [ethers.parseEther("800"), ethers.parseEther("700")];
      const bobTotalAssets = ethers.parseEther("1500");

      await dStable.connect(bob).approve(dStakeToken.target, bobTotalAssets);
      await dStakeToken.connect(bob).solverDepositAssets(
        bobVaults,
        bobAssets,
        ethers.parseEther("1400"),
        bob.address
      );

      // Charlie: All vaults with different distribution
      const charlieVaults = [vault1Address, vault2Address, vault3Address];
      const charlieAssets = [ethers.parseEther("300"), ethers.parseEther("400"), ethers.parseEther("300")];
      const charlieTotalAssets = ethers.parseEther("1000");

      await dStable.connect(charlie).approve(dStakeToken.target, charlieTotalAssets);
      await dStakeToken.connect(charlie).solverDepositAssets(
        charlieVaults,
        charlieAssets,
        ethers.parseEther("950"),
        charlie.address
      );

      // Verify all users received appropriate shares
      const aliceShares = await dStakeToken.balanceOf(alice.address);
      const bobShares = await dStakeToken.balanceOf(bob.address);
      const charlieShares = await dStakeToken.balanceOf(charlie.address);

      expect(aliceShares).to.be.gt(ethers.parseEther("1900"));
      expect(bobShares).to.be.gt(ethers.parseEther("1400"));
      expect(charlieShares).to.be.gt(ethers.parseEther("950"));

      // Verify vault balances reflect deposits
      const vault1Balance = await vault1.balanceOf(collateralVault.target);
      const vault2Balance = await vault2.balanceOf(collateralVault.target);
      const vault3Balance = await vault3.balanceOf(collateralVault.target);

      expect(vault1Balance).to.be.gt(0);
      expect(vault2Balance).to.be.gt(0);
      expect(vault3Balance).to.be.gt(0);

      // Now perform mixed withdrawals

      // Alice withdraws using shares
      const aliceWithdrawShares = [vault1Balance / 8n]; // 12.5% of vault1
      await dStakeToken.connect(alice).solverWithdrawShares(
        [vault1Address],
        aliceWithdrawShares,
        ethers.parseEther("300"),
        alice.address,
        alice.address
      );

      // Bob withdraws using assets
      const bobWithdrawAssets = [ethers.parseEther("200"), ethers.parseEther("150")];
      await dStakeToken.connect(bob).solverWithdrawAssets(
        [vault2Address, vault3Address],
        bobWithdrawAssets,
        ethers.parseEther("400"),
        bob.address,
        bob.address
      );

      // Verify system integrity after mixed operations
      const finalTotalAssets = await dStakeToken.totalAssets();
      const finalTotalShares = await dStakeToken.totalSupply();

      expect(finalTotalAssets).to.be.gt(0);
      expect(finalTotalShares).to.be.gt(0);

      // Verify share price remains reasonable
      const finalSharePrice = finalTotalAssets * ethers.parseEther("1") / finalTotalShares;
      expect(finalSharePrice).to.be.closeTo(ethers.parseEther("1"), ethers.parseEther("0.2"));
    });
  });
});