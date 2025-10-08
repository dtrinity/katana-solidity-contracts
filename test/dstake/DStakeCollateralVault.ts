import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ZeroAddress } from "ethers"; // Import ZeroAddress
import { deployments, ethers, getNamedAccounts } from "hardhat";

import { DStakeCollateralVaultV2, DStakeRouterV2, DStakeTokenV2, ERC20, IDStableConversionAdapterV2, IERC20 } from "../../typechain-types";
import { ERC20StablecoinUpgradeable } from "../../typechain-types/contracts/dstable/ERC20StablecoinUpgradeable";
import { createDStakeFixture, DSTAKE_CONFIGS, DStakeFixtureConfig } from "./fixture"; // Use the specific fixture and import DSTAKE_CONFIGS
import { resolveRoleSigner } from "./utils/roleHelpers";

// Helper function to parse units
const parseUnits = (value: string | number, decimals: number | bigint) => ethers.parseUnits(value.toString(), decimals);
const ONE_HUNDRED_PERCENT_BPS = 1_000_000n;

const COLLATERAL_TEST_CONFIGS = DSTAKE_CONFIGS.filter(
  (cfg: DStakeFixtureConfig) => cfg.dStableSymbol === "dUSD",
);

COLLATERAL_TEST_CONFIGS.forEach((config: DStakeFixtureConfig) => {
  describe(`DStakeCollateralVaultV2 for ${config.DStakeTokenV2Symbol}`, () => {
    // Create fixture function once per suite for snapshot caching
    const fixture = createDStakeFixture(config);

    let deployer: SignerWithAddress;
    let stable: ERC20StablecoinUpgradeable;
    let user1: SignerWithAddress;
    let user2: SignerWithAddress;
    let adminRole: string;
    let routerRole: string;

    // Fixture types
    let DStakeTokenV2: DStakeTokenV2;
    let collateralVault: DStakeCollateralVaultV2;
    let router: DStakeRouterV2;
    let dStableToken: ERC20;
    let dStableDecimals: number;
    let strategyShareToken: IERC20;
    let strategyShareAddress: string;
    let strategyShareDecimals: number;
    let adapter: IDStableConversionAdapterV2 | null; // Adapter can be null
    let adapterAddress: string;
    let initialTargetBps: bigint | null;
    let initialVaultStatus: number | null;

    let DStakeTokenV2Address: string;
    let dStableTokenAddress: string;
    let collateralVaultAddress: string;
    let routerAddress: string;
    // routerSigner will be an EOA (likely deployer) with ROUTER_ROLE
    let routerSigner: SignerWithAddress;
    let amountToSend: bigint;

    // Load fixture before each test
    beforeEach(async function () {
      const namedAccounts = await getNamedAccounts();
      deployer = await ethers.getSigner(namedAccounts.deployer);
      user1 = await ethers.getSigner(namedAccounts.user1);
      user2 = await ethers.getSigner(namedAccounts.user2);

      // Revert to snapshot instead of redeploying
      const out = await fixture();

      DStakeTokenV2 = out.DStakeTokenV2 as unknown as DStakeTokenV2;
      collateralVault = out.collateralVault as unknown as DStakeCollateralVaultV2;
      router = out.router as unknown as DStakeRouterV2;
      dStableToken = out.dStableToken;
      dStableDecimals = Number(await dStableToken.decimals());
      strategyShareToken = out.strategyShareToken;
      strategyShareAddress = out.strategyShareAddress;
      adapter = out.adapter as unknown as IDStableConversionAdapterV2 | null;
      adapterAddress = out.adapterAddress;
      initialTargetBps = null;
      initialVaultStatus = null;

      DStakeTokenV2Address = await DStakeTokenV2.getAddress();
      dStableTokenAddress = await dStableToken.getAddress();
      // Get the native stablecoin contract to grant mint role
      stable = (await ethers.getContractAt("ERC20StablecoinUpgradeable", dStableTokenAddress, deployer)) as ERC20StablecoinUpgradeable;
      // Grant MINTER_ROLE to deployer so tests can mint dStable
      const minterRole = await stable.MINTER_ROLE();
      await stable.grantRole(minterRole, deployer.address);
      collateralVaultAddress = await collateralVault.getAddress();
      routerAddress = await router.getAddress();

      if (strategyShareAddress !== ZeroAddress && strategyShareToken) {
        const tempStrategyShare = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/ERC20.sol:ERC20", strategyShareAddress);
        strategyShareDecimals = Number(await tempStrategyShare.decimals());
      } else {
        strategyShareDecimals = 18;
      }

      amountToSend = parseUnits(1, strategyShareDecimals);

      adminRole = await collateralVault.DEFAULT_ADMIN_ROLE();
      routerRole = await collateralVault.ROUTER_ROLE();

      const routerAdminRole = await router.DEFAULT_ADMIN_ROLE();
      const routerDeployment = await deployments.get(config.routerContractId);
      const routerAdminSigner = await resolveRoleSigner(
        router,
        routerAdminRole,
        [
          user1.address,
          deployer.address,
          routerDeployment.receipt?.from,
        ],
        deployer,
      );

      const adapterManagerRole = await router.ADAPTER_MANAGER_ROLE();
      if (!(await router.hasRole(adapterManagerRole, user1.address))) {
        await router.connect(routerAdminSigner).grantRole(adapterManagerRole, user1.address);
      }
      const vaultManagerRole = await router.VAULT_MANAGER_ROLE();
      if (!(await router.hasRole(vaultManagerRole, user1.address))) {
        await router.connect(routerAdminSigner).grantRole(vaultManagerRole, user1.address);
      }
      routerSigner = user1;

      if (await router.vaultExists(strategyShareAddress)) {
        const configStruct = await router.getVaultConfig(strategyShareAddress);
        initialTargetBps = BigInt(configStruct.targetBps);
        initialVaultStatus = Number(configStruct.status);
      }

      const collateralDeployment = await deployments.get(config.collateralVaultContractId);
      const adminSignerForVault = await resolveRoleSigner(
        collateralVault,
        adminRole,
        [
          user1.address,
          deployer.address,
          collateralDeployment.receipt?.from,
        ],
        deployer,
      );

      if (!(await collateralVault.hasRole(adminRole, user1.address))) {
        await collateralVault.connect(adminSignerForVault).grantRole(adminRole, user1.address);
      }
      if (
        (await collateralVault.hasRole(adminRole, deployer.address)) &&
        deployer.address.toLowerCase() !== user1.address.toLowerCase()
      ) {
        await collateralVault.connect(adminSignerForVault).revokeRole(adminRole, deployer.address);
      }

      if ((await collateralVault.router()) !== routerAddress) {
        await collateralVault.connect(user1).setRouter(routerAddress);
      }

      if (!(await collateralVault.hasRole(routerRole, user1.address))) {
        await collateralVault.connect(user1).grantRole(routerRole, user1.address);
      }
      if (!(await collateralVault.hasRole(routerRole, routerAddress))) {
        await collateralVault.connect(user1).grantRole(routerRole, routerAddress);
      }

      // Note: ADAPTER_MANAGER_ROLE is granted via deployment scripts, not in test fixtures

      expect(await collateralVault.dStakeToken()).to.equal(DStakeTokenV2Address);
      expect(await collateralVault.dStable()).to.equal(dStableTokenAddress);
      expect(await collateralVault.hasRole(adminRole, user1.address)).to.be.true;
      expect(await collateralVault.hasRole(adminRole, deployer.address)).to.be.false;

      if (adapter) {
        expect(adapterAddress).to.not.equal(ZeroAddress);
        expect(await adapter.strategyShare()).to.equal(strategyShareAddress);
      } else {
        expect(await router.strategyShareToAdapter(strategyShareAddress)).to.equal(ZeroAddress);
      }
    });

    const ensureAdapterRegistered = async (): Promise<IDStableConversionAdapterV2> => {
      const registeredAdapter = await router.strategyShareToAdapter(strategyShareAddress);

      if (registeredAdapter === ZeroAddress) {
        expect(adapterAddress, "Fixture missing adapter for strategy share").to.not.equal(ZeroAddress);
        await router.connect(routerSigner).addAdapter(strategyShareAddress, adapterAddress);
      }

      adapterAddress = await router.strategyShareToAdapter(strategyShareAddress);

      if (!adapter || (await adapter.getAddress()) !== adapterAddress) {
        adapter = (await ethers.getContractAt("IDStableConversionAdapterV2", adapterAddress)) as IDStableConversionAdapterV2;
      }

      if (await router.vaultExists(strategyShareAddress)) {
        const configStruct = await router.getVaultConfig(strategyShareAddress);
        const desiredTarget = Number(initialTargetBps ?? BigInt(configStruct.targetBps));
        const desiredStatus = initialVaultStatus ?? Number(configStruct.status);
        const adapterMismatch = configStruct.adapter.toLowerCase() !== adapterAddress.toLowerCase();
        const targetMismatch = BigInt(configStruct.targetBps) !== BigInt(desiredTarget);
        const statusMismatch = configStruct.status !== desiredStatus;

        if (adapterMismatch || targetMismatch || statusMismatch) {
          await router
            .connect(routerSigner)
            .updateVaultConfig(strategyShareAddress, adapterAddress, desiredTarget, desiredStatus);
        }
        if (initialTargetBps === null) {
          initialTargetBps = BigInt(desiredTarget);
        }
        if (initialVaultStatus === null) {
          initialVaultStatus = desiredStatus;
        }
      } else {
        const desiredTarget = Number(initialTargetBps ?? ONE_HUNDRED_PERCENT_BPS);
        const desiredStatus = initialVaultStatus ?? 0;
        await router
          .connect(routerSigner)
          .addVaultConfig(strategyShareAddress, adapterAddress, desiredTarget, desiredStatus);
        if (initialTargetBps === null) {
          initialTargetBps = BigInt(desiredTarget);
        }
        if (initialVaultStatus === null) {
          initialVaultStatus = desiredStatus;
        }
      }

      return adapter;
    };

    const suspendVaultIfConfigured = async (strategyShare: string) => {
      try {
        await router.connect(routerSigner).suspendVaultForRemoval(strategyShare);
      } catch (error: unknown) {
        const message = (error as Error).message ?? "";
        if (!message.includes("VaultNotFound")) {
          throw error;
        }
      }
    };

    const mintAndDepositDStable = async (amount: bigint, depositor: SignerWithAddress = deployer) => {
      await stable.mint(depositor.address, amount);
      await dStableToken.connect(depositor).approve(DStakeTokenV2Address, amount);
      await DStakeTokenV2.connect(depositor).deposit(amount, depositor.address);
    };

    const ensureVaultHasStrategyShares = async (minimumBalance: bigint): Promise<bigint> => {
      await ensureAdapterRegistered();
      let currentBalance = await strategyShareToken.balanceOf(collateralVaultAddress);

      if (currentBalance >= minimumBalance) {
        return currentBalance;
      }

      const depositChunk = parseUnits(1_000, dStableDecimals);
      await stable.mint(user1.address, depositChunk);
      await stable.connect(user1).approve(routerAddress, depositChunk);
      await router
        .connect(user1)
        .solverDepositAssets([strategyShareAddress], [depositChunk], 0n, user1.address);
      currentBalance = await strategyShareToken.balanceOf(collateralVaultAddress);

      expect(currentBalance, "Unable to seed collateral vault balance").to.be.gte(minimumBalance);
      return currentBalance;
    };

    describe("Initialization & Deployment State (from fixture)", () => {
      it("Should have deployed the vault correctly", async function () {
        expect(collateralVaultAddress).to.not.equal(ZeroAddress);
      });

      it("Should have set immutable state correctly (DStakeTokenV2, dStable)", async function () {
        expect(await collateralVault.dStakeToken()).to.equal(DStakeTokenV2Address);
        expect(await collateralVault.dStable()).to.equal(dStableTokenAddress);
      });

      it("Should grant DEFAULT_ADMIN_ROLE to initialAdmin", async function () {
        expect(await collateralVault.hasRole(adminRole, user1.address)).to.be.true;
        expect(await collateralVault.hasRole(adminRole, deployer.address)).to.be.false;
      });

      it("Router should be set as per beforeEach setup", async function () {
        expect(await collateralVault.router()).to.equal(routerAddress);
        expect(await collateralVault.hasRole(routerRole, routerAddress)).to.be.true;
      });
    });

    describe("Router Management (setRouter)", () => {
      it("Should only allow admin to set router", async function () {
        await expect(collateralVault.connect(user2).setRouter(routerAddress)).to.be.revertedWithCustomError(
          collateralVault,
          "AccessControlUnauthorizedAccount"
        );

        await expect(collateralVault.connect(user1).setRouter(routerAddress)).to.not.be.reverted;
      });

      it("Should revert if setting router to zero address", async function () {
        await expect(collateralVault.connect(user1).setRouter(ZeroAddress)).to.be.revertedWithCustomError(collateralVault, "ZeroAddress");
      });

      it("Should set and replace the router correctly, managing ROUTER_ROLE", async function () {
        const newRouterAddress = user1.address;

        await expect(collateralVault.connect(user1).setRouter(newRouterAddress))
          .to.emit(collateralVault, "RouterSet")
          .withArgs(newRouterAddress);
        expect(await collateralVault.router()).to.equal(newRouterAddress);
        expect(await collateralVault.hasRole(routerRole, newRouterAddress)).to.be.true;
        expect(await collateralVault.hasRole(routerRole, routerAddress)).to.be.false;

        await expect(collateralVault.connect(user1).setRouter(routerAddress)).to.emit(collateralVault, "RouterSet").withArgs(routerAddress);
        expect(await collateralVault.router()).to.equal(routerAddress);
        expect(await collateralVault.hasRole(routerRole, routerAddress)).to.be.true;
        expect(await collateralVault.hasRole(routerRole, newRouterAddress)).to.be.false;
      });
    });

    describe("Strategy Share Transfers", function () {
      beforeEach(async function () {
        await ensureVaultHasStrategyShares(amountToSend);
      });

      it("Should only allow router (via routerSigner) to send assets", async function () {
        await ensureAdapterRegistered();
        const recipient = user1.address;
        await expect(
          collateralVault.connect(user2).transferStrategyShares(strategyShareAddress, amountToSend, recipient)
        ).to.be.revertedWithCustomError(
          collateralVault,
          "AccessControlUnauthorizedAccount"
        );

        await expect(
          collateralVault.connect(routerSigner).transferStrategyShares(strategyShareAddress, amountToSend, recipient)
        ).to.not.be.reverted;
      });

      it("Should transfer asset correctly", async function () {
        const recipient = user1.address;
        const initialVaultBalance = await strategyShareToken.balanceOf(collateralVaultAddress);
        const initialRecipientBalance = await strategyShareToken.balanceOf(recipient);

        await collateralVault
          .connect(routerSigner)
          .transferStrategyShares(strategyShareAddress, amountToSend, recipient);

        const finalVaultBalance = await strategyShareToken.balanceOf(collateralVaultAddress);
        const finalRecipientBalance = await strategyShareToken.balanceOf(recipient);

        expect(finalVaultBalance).to.equal(initialVaultBalance - amountToSend);
        expect(finalRecipientBalance).to.equal(initialRecipientBalance + amountToSend);
      });

      it("Should revert on insufficient balance", async function () {
        const recipient = user1.address;
        const vaultBalance = await strategyShareToken.balanceOf(collateralVaultAddress);
        const attemptToSend = vaultBalance + parseUnits("1", strategyShareDecimals);

        await expect(
          collateralVault.connect(routerSigner).transferStrategyShares(strategyShareAddress, attemptToSend, recipient)
        ).to.be.reverted;
      });

      it("Should revert if asset is not supported", async function () {
        const nonSupportedAsset = dStableTokenAddress;
        const recipient = user1.address;
        await expect(collateralVault.connect(routerSigner).transferStrategyShares(nonSupportedAsset, amountToSend, recipient))
          .to.be.revertedWithCustomError(collateralVault, "StrategyShareNotSupported")
          .withArgs(nonSupportedAsset);
      });
    });

    describe("Value Calculation (totalValueInDStable)", function () {
      beforeEach(async function () {
        const currentAdapter = await router.strategyShareToAdapter(strategyShareAddress);

        if (currentAdapter !== ZeroAddress) {
          const balance = await strategyShareToken.balanceOf(collateralVaultAddress);

          if (balance > 0n) {
            await collateralVault
              .connect(routerSigner)
              .transferStrategyShares(strategyShareAddress, balance, deployer.address);
          }
          await suspendVaultIfConfigured(strategyShareAddress);
          await router.connect(routerSigner).removeAdapter(strategyShareAddress);
        }
      });

      it("Should return 0 if no assets are supported", async function () {
        expect(await collateralVault.totalValueInDStable()).to.equal(0);
      });

      it("Should return 0 if supported asset has zero balance", async function () {
        await ensureAdapterRegistered();
        expect(await strategyShareToken.balanceOf(collateralVaultAddress)).to.equal(0);
        expect(await collateralVault.totalValueInDStable()).to.equal(0);
      });

      it("Should return correct value for a single asset with balance", async function () {
        const registeredAdapter = await ensureAdapterRegistered();
        const targetBalance = parseUnits(100, strategyShareDecimals);
        await ensureVaultHasStrategyShares(targetBalance);
        const vaultBalance = await strategyShareToken.balanceOf(collateralVaultAddress);
        expect(vaultBalance).to.be.gt(0);

        const expectedValue = await registeredAdapter.strategyShareValueInDStable(strategyShareAddress, vaultBalance);
        const actualValue = await collateralVault.totalValueInDStable();
        expect(actualValue).to.equal(expectedValue);

        await suspendVaultIfConfigured(strategyShareAddress);
        await router.connect(routerSigner).removeAdapter(strategyShareAddress);
      });

      it("Should sum values correctly for multiple supported assets (if possible to set up)", async function () {
        const primaryAdapter = await ensureAdapterRegistered();
        const primaryTarget = parseUnits(50, strategyShareDecimals);
        await ensureVaultHasStrategyShares(primaryTarget);

        const MockAdapterFactory = await ethers.getContractFactory("MockAdapterPositiveSlippage");
        const additionalAdapter = (await MockAdapterFactory.deploy(dStableTokenAddress, collateralVaultAddress)) as IDStableConversionAdapterV2;
        const additionalAdapterAddress = await additionalAdapter.getAddress();
        const additionalStrategyShare = await additionalAdapter.strategyShare();

        await router.connect(routerSigner).addAdapter(additionalStrategyShare, additionalAdapterAddress);

        const additionalDepositAmount = parseUnits(150, dStableDecimals);
        await stable.mint(routerSigner.address, additionalDepositAmount);
        await dStableToken.connect(routerSigner).approve(additionalAdapterAddress, additionalDepositAmount);
        await additionalAdapter.connect(routerSigner).depositIntoStrategy(additionalDepositAmount);

        const primaryBalance = await strategyShareToken.balanceOf(collateralVaultAddress);
        const additionalShareToken = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", additionalStrategyShare);
        const secondaryBalance = await additionalShareToken.balanceOf(collateralVaultAddress);

        const primaryValue = await primaryAdapter.strategyShareValueInDStable(strategyShareAddress, primaryBalance);
        const secondaryValue = await additionalAdapter.strategyShareValueInDStable(additionalStrategyShare, secondaryBalance);

        const totalValue = await collateralVault.totalValueInDStable();
        expect(totalValue).to.equal(primaryValue + secondaryValue);
      });

      it("Should return 0 after asset balance is removed and adapter is removed", async function () {
        await ensureAdapterRegistered();
        const seeded = await ensureVaultHasStrategyShares(parseUnits(50, strategyShareDecimals));

        expect(await collateralVault.totalValueInDStable()).to.be.gt(0);

        // Send all vault asset back to deployer
        await collateralVault
          .connect(routerSigner)
          .transferStrategyShares(strategyShareAddress, seeded, deployer.address);
        expect(await collateralVault.totalValueInDStable()).to.equal(0);

        await suspendVaultIfConfigured(strategyShareAddress);
        await router.connect(routerSigner).removeAdapter(strategyShareAddress);
        expect(await collateralVault.totalValueInDStable()).to.equal(0);
      });
    });

    describe("Supported Strategy Share Removal without Zero Balance", function () {
      beforeEach(async function () {
        await ensureVaultHasStrategyShares(parseUnits(100, strategyShareDecimals));
      });

      it("Should allow removeSupportedStrategyShare even when balance > 0", async function () {
        // Verify balance > 0
        const balBefore = await strategyShareToken.balanceOf(collateralVaultAddress);
        expect(balBefore).to.be.gt(0n);

        // Remove supported asset via routerSigner
        await expect(collateralVault.connect(routerSigner).removeSupportedStrategyShare(strategyShareAddress))
          .to.emit(collateralVault, "StrategyShareRemoved")
          .withArgs(strategyShareAddress);

        // Asset should no longer be in supported list
        const supported = await collateralVault.getSupportedStrategyShares();
        expect(supported).to.not.include(strategyShareAddress);
      });

      it("Should block transfers after asset is removed but balance remains", async function () {
        // Remove asset first
        await collateralVault.connect(routerSigner).removeSupportedStrategyShare(strategyShareAddress);

        // Attempt to send should revert due to StrategyShareNotSupported
        await expect(collateralVault.connect(routerSigner).transferStrategyShares(strategyShareAddress, 1n, deployer.address))
          .to.be.revertedWithCustomError(collateralVault, "StrategyShareNotSupported")
          .withArgs(strategyShareAddress);
      });
    });

    describe("Recovery Functions", function () {
      let mockToken: ERC20;
      let mockTokenAddress: string;
      const testAmount = parseUnits("100", 18);

      beforeEach(async function () {
        // Deploy a mock ERC20 token for testing rescue functionality
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        mockToken = (await MockERC20.deploy("Mock Token", "MOCK", parseUnits("1000000", 18))) as ERC20;
        mockTokenAddress = await mockToken.getAddress();

        // Send some mock tokens to the vault to test rescue
        await mockToken.connect(deployer).transfer(collateralVaultAddress, testAmount);
      });

      describe("rescueToken", function () {
        it("Should successfully rescue non-restricted tokens", async function () {
          const receiverInitialBalance = await mockToken.balanceOf(user1.address);
          const vaultInitialBalance = await mockToken.balanceOf(collateralVaultAddress);

          await expect(collateralVault.connect(user1).rescueToken(mockTokenAddress, user1.address, testAmount))
            .to.emit(collateralVault, "TokenRescued")
            .withArgs(mockTokenAddress, user1.address, testAmount);

          expect(await mockToken.balanceOf(user1.address)).to.equal(receiverInitialBalance + testAmount);
          expect(await mockToken.balanceOf(collateralVaultAddress)).to.equal(vaultInitialBalance - testAmount);
        });

        it("Should rescue partial balance", async function () {
          const partialAmount = testAmount / 2n;

          await expect(collateralVault.connect(user1).rescueToken(mockTokenAddress, user1.address, partialAmount))
            .to.emit(collateralVault, "TokenRescued")
            .withArgs(mockTokenAddress, user1.address, partialAmount);

          expect(await mockToken.balanceOf(collateralVaultAddress)).to.equal(testAmount - partialAmount);
        });

        it("Should revert when trying to rescue supported vault assets", async function () {
          await ensureVaultHasStrategyShares(parseUnits(10, strategyShareDecimals));

          await expect(collateralVault.connect(user1).rescueToken(strategyShareAddress, user1.address, 1n))
            .to.be.revertedWithCustomError(collateralVault, "CannotRescueRestrictedToken")
            .withArgs(strategyShareAddress);
        });

        it("Should revert when trying to rescue dStable token", async function () {
          // Send some dStable to the vault
          await stable.mint(collateralVaultAddress, testAmount);

          await expect(collateralVault.connect(user1).rescueToken(dStableTokenAddress, user1.address, testAmount))
            .to.be.revertedWithCustomError(collateralVault, "CannotRescueRestrictedToken")
            .withArgs(dStableTokenAddress);
        });

        it("Should only allow DEFAULT_ADMIN_ROLE to call rescueToken", async function () {
          await expect(
            collateralVault.connect(user2).rescueToken(mockTokenAddress, user1.address, testAmount)
          ).to.be.revertedWithCustomError(collateralVault, "AccessControlUnauthorizedAccount");
        });

        it("Should revert with zero address receiver", async function () {
          await expect(collateralVault.connect(user1).rescueToken(mockTokenAddress, ZeroAddress, testAmount)).to.be.revertedWithCustomError(
            collateralVault,
            "ZeroAddress"
          );
        });

        it("Should handle rescue when token balance is insufficient", async function () {
          const excessiveAmount = testAmount * 2n;
          await expect(collateralVault.connect(user1).rescueToken(mockTokenAddress, user1.address, excessiveAmount)).to.be.reverted;
        });
      });

      describe("rescueETH", function () {
        const ethAmount = parseUnits("1", 18);

        beforeEach(async function () {
          // Send ETH to the vault
          await deployer.sendTransaction({
            to: collateralVaultAddress,
            value: ethAmount,
          });
        });

        it("Should successfully rescue ETH", async function () {
          // Use user2 as receiver to avoid gas cost complications with user1 (admin)
          const receiverInitialBalance = await ethers.provider.getBalance(user2.address);
          const vaultInitialBalance = await ethers.provider.getBalance(collateralVaultAddress);

          await expect(collateralVault.connect(user1).rescueETH(user2.address, ethAmount))
            .to.emit(collateralVault, "ETHRescued")
            .withArgs(user2.address, ethAmount);

          // Check receiver got the exact amount (no gas costs for receiver)
          expect(await ethers.provider.getBalance(user2.address)).to.equal(receiverInitialBalance + ethAmount);
          // Check vault balance decreased by exactly the rescued amount
          expect(await ethers.provider.getBalance(collateralVaultAddress)).to.equal(vaultInitialBalance - ethAmount);
        });

        it("Should only allow DEFAULT_ADMIN_ROLE to call rescueETH", async function () {
          await expect(collateralVault.connect(user2).rescueETH(user2.address, ethAmount)).to.be.revertedWithCustomError(
            collateralVault,
            "AccessControlUnauthorizedAccount"
          );
        });

        it("Should revert with zero address receiver", async function () {
          await expect(collateralVault.connect(user1).rescueETH(ZeroAddress, ethAmount)).to.be.revertedWithCustomError(
            collateralVault,
            "ZeroAddress"
          );
        });

        it("Should revert when contract has insufficient ETH", async function () {
          const excessiveAmount = ethAmount * 2n;
          await expect(collateralVault.connect(user1).rescueETH(user2.address, excessiveAmount))
            .to.be.revertedWithCustomError(collateralVault, "ETHTransferFailed")
            .withArgs(user2.address, excessiveAmount);
        });

        it("Should handle rescue when contract has no ETH", async function () {
          // First rescue all ETH
          await collateralVault.connect(user1).rescueETH(user2.address, ethAmount);

          // Try to rescue again when balance is 0
          await expect(collateralVault.connect(user1).rescueETH(user2.address, 1n))
            .to.be.revertedWithCustomError(collateralVault, "ETHTransferFailed")
            .withArgs(user2.address, 1n);
        });
      });

      // getRestrictedRescueTokens tests removed because function no longer exists

      describe("Integration tests", function () {
        it("Should rescue multiple different tokens", async function () {
          // Deploy another mock token
          const MockERC20 = await ethers.getContractFactory("MockERC20");
          const mockToken2 = (await MockERC20.deploy("Mock Token 2", "MOCK2", parseUnits("1000000", 18))) as ERC20;
          const mockToken2Address = await mockToken2.getAddress();

          // Send both tokens to vault
          await mockToken2.connect(deployer).transfer(collateralVaultAddress, testAmount);

          // Rescue first token
          await expect(collateralVault.connect(user1).rescueToken(mockTokenAddress, user1.address, testAmount))
            .to.emit(collateralVault, "TokenRescued")
            .withArgs(mockTokenAddress, user1.address, testAmount);

          // Rescue second token
          await expect(collateralVault.connect(user1).rescueToken(mockToken2Address, user1.address, testAmount))
            .to.emit(collateralVault, "TokenRescued")
            .withArgs(mockToken2Address, user1.address, testAmount);

          expect(await mockToken.balanceOf(user1.address)).to.equal(testAmount);
          expect(await mockToken2.balanceOf(user1.address)).to.equal(testAmount);
        });

        it("Should prevent rescue of newly added supported assets", async function () {
          const registeredAdapter = await ensureAdapterRegistered();

          const existingBalance = await strategyShareToken.balanceOf(collateralVaultAddress);
          if (existingBalance > 0n) {
            await collateralVault
              .connect(routerSigner)
              .transferStrategyShares(strategyShareAddress, existingBalance, deployer.address);
          }

        await suspendVaultIfConfigured(strategyShareAddress);
        await router.connect(routerSigner).removeAdapter(strategyShareAddress);
          expect(await router.strategyShareToAdapter(strategyShareAddress)).to.equal(ZeroAddress);

          const seedAmount = parseUnits(25, dStableDecimals);
          await stable.mint(routerSigner.address, seedAmount);
          await dStableToken.connect(routerSigner).approve(adapterAddress, seedAmount);
          await registeredAdapter.connect(routerSigner).depositIntoStrategy(seedAmount);

          const vaultBalance = await strategyShareToken.balanceOf(collateralVaultAddress);
          expect(vaultBalance).to.be.gt(0n);

          await expect(collateralVault.connect(user1).rescueToken(strategyShareAddress, user1.address, 1n)).to.not.be.reverted;

          await router.connect(routerSigner).addAdapter(strategyShareAddress, adapterAddress);

          await expect(collateralVault.connect(user1).rescueToken(strategyShareAddress, user1.address, 1n))
            .to.be.revertedWithCustomError(collateralVault, "CannotRescueRestrictedToken")
            .withArgs(strategyShareAddress);
        });
      });
    });
  });
});
