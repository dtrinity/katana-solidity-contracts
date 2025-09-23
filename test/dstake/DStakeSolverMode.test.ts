import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  DStakeRouterV2,
  MockMetaMorphoVault,
  TestMintableERC20,
  DStakeCollateralVaultV2,
  MetaMorphoConversionAdapter,
  DStakeTokenV2,
} from "../../typechain-types";
import { SDUSD_CONFIG } from "./fixture";
import { createDStakeRouterV2Fixture } from "./routerFixture";

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
  let collateralVault: DStakeCollateralVaultV2;
  let dStakeToken: DStakeTokenV2;

  // Multi-vault setup (3 vaults for comprehensive testing)
  let vault1: MockMetaMorphoVault; // Target: 50% (500,000 bps)
  let vault2: MockMetaMorphoVault; // Target: 30% (300,000 bps)
  let vault3: MockMetaMorphoVault; // Target: 20% (200,000 bps)
  let adapter1: MetaMorphoConversionAdapter;
  let adapter2: MetaMorphoConversionAdapter;
  let adapter3: MetaMorphoConversionAdapter;

  // Address strings to avoid ethers resolveName issues
  let vault1Address: string;
  let vault2Address: string;
  let vault3Address: string;
  let adapter1Address: string;
  let adapter2Address: string;
  let adapter3Address: string;

  const setupDStakeSolverMode = createDStakeRouterV2Fixture(config);

  async function bootstrapHighSharePrice(donation: bigint) {
    const initialDeposit = ethers.parseEther("1");
    await dStable.connect(alice).approve(dStakeToken.target, initialDeposit);
    await dStakeToken.connect(alice).deposit(initialDeposit, alice.address);

    await dStable.connect(owner).mint(owner.address, donation);
    await dStable.connect(owner).transfer(dStakeToken.target, donation);
  }

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
    // Assign address strings
    vault1Address = fixture.vault1Address;
    vault2Address = fixture.vault2Address;
    vault3Address = fixture.vault3Address;
    adapter1Address = fixture.adapter1Address;
    adapter2Address = fixture.adapter2Address;
    adapter3Address = fixture.adapter3Address;
  });

  describe("Solver Mode: solverDepositAssets", function () {
    it("Should deposit assets into multiple vaults via DStakeTokenV2", async function () {
      const vaults = [vault1Address, vault2Address, vault3Address];
      const assets = [
        ethers.parseEther("1000"), // 1000 to vault1
        ethers.parseEther("600"), // 600 to vault2
        ethers.parseEther("400"), // 400 to vault3
      ];
      const totalAssets = ethers.parseEther("2000");
      const minShares = ethers.parseEther("1900"); // Allow 5% slippage

      // Approve dStable for dStakeToken
      await dStable.connect(alice).approve(dStakeToken.target, totalAssets);

      const sharesBefore = await dStakeToken.balanceOf(alice.address);
      const dStableBalanceBefore = await dStable.balanceOf(alice.address);

      // Execute solver deposit
      const tx = await dStakeToken.connect(alice).solverDepositAssets(vaults, assets, minShares, alice.address);

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
      await expect(tx).to.emit(dStakeToken, "Deposit").withArgs(alice.address, alice.address, totalAssets, sharesReceived);
    });

    it("Should revert with slippage protection when minShares not met", async function () {
      const vaults = [vault1Address, vault2Address];
      const assets = [ethers.parseEther("1000"), ethers.parseEther("1000")];
      const totalAssets = ethers.parseEther("2000");
      const minShares = ethers.parseEther("2500"); // Too high, should fail

      await dStable.connect(alice).approve(dStakeToken.target, totalAssets);

      await expect(dStakeToken.connect(alice).solverDepositAssets(vaults, assets, minShares, alice.address)).to.be.revertedWithCustomError(
        dStakeToken,
        "ERC4626ExceedsMaxWithdraw"
      );
    });

    it("Should revert when vaults and assets arrays have mismatched lengths", async function () {
      const vaults = [vault1Address, vault2Address];
      const assets = [ethers.parseEther("1000")]; // Mismatched length
      const minShares = ethers.parseEther("900");

      await dStable.connect(alice).approve(dStakeToken.target, ethers.parseEther("1000"));

      await expect(dStakeToken.connect(alice).solverDepositAssets(vaults, assets, minShares, alice.address)).to.be.revertedWithCustomError(
        router,
        "ArrayLengthMismatch"
      );
    });

    it("Should revert when empty arrays provided", async function () {
      const vaults: string[] = [];
      const assets: bigint[] = [];
      const minShares = ethers.parseEther("0");

      await expect(dStakeToken.connect(alice).solverDepositAssets(vaults, assets, minShares, alice.address)).to.be.revertedWithCustomError(
        dStakeToken,
        "ZeroShares"
      );
    });

    it("Should revert when total assets is zero", async function () {
      const vaults = [vault1Address, vault2Address];
      const assets = [0, 0]; // Zero assets
      const minShares = 0;

      await expect(dStakeToken.connect(alice).solverDepositAssets(vaults, assets, minShares, alice.address)).to.be.revertedWithCustomError(
        dStakeToken,
        "ZeroShares"
      );
    });

    it("reverts when previewDeposit mints zero shares due to inflated NAV", async function () {
      const donation = ethers.parseUnits("1000000", 18);
      await bootstrapHighSharePrice(donation);

      expect(await dStakeToken.previewDeposit(1n)).to.equal(0n);

      const tinyDeposit = 1n;
      await dStable.connect(bob).approve(dStakeToken.target, tinyDeposit);

      await expect(
        dStakeToken.connect(bob).solverDepositAssets([vault1Address], [tinyDeposit], 0n, bob.address)
      ).to.be.revertedWithCustomError(dStakeToken, "ZeroShares");
    });
  });

  describe("Solver Mode: solverDepositShares", function () {
    it("Should deposit shares into multiple vaults via DStakeTokenV2", async function () {
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
      const tx = await dStakeToken.connect(alice).solverDepositShares(vaults, shares, minShares, alice.address);

      const sharesAfter = await dStakeToken.balanceOf(alice.address);
      const sharesReceived = sharesAfter - sharesBefore;

      // Verify shares received meets minimum
      expect(sharesReceived).to.be.gte(minShares);

      // Verify assets were deposited to correct vaults
      expect(await vault1.balanceOf(collateralVault.target)).to.be.gt(0);
      expect(await vault2.balanceOf(collateralVault.target)).to.be.gt(0);

      // Verify Deposit event was emitted
      await expect(tx).to.emit(dStakeToken, "Deposit").withArgs(alice.address, alice.address, totalExpectedAssets, sharesReceived);
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

      await dStakeToken.connect(alice).solverDepositShares(vaults, shares, minShares, alice.address);

      // Verify only vault1 and vault3 received deposits
      expect(await vault1.balanceOf(collateralVault.target)).to.be.gt(0);
      expect(await vault2.balanceOf(collateralVault.target)).to.equal(0);
      expect(await vault3.balanceOf(collateralVault.target)).to.be.gt(0);
    });

    it("reverts when adapter mints fewer shares than requested", async function () {
      // Configure a 5% deposit fee so the vault mints fewer shares than requested
      await vault1.setFees(500, 0);
      // Loosen adapter slippage guard to tolerate the shortfall
      await adapter1.setMaxSlippage(200_000); // 20%

      const requestedShares = ethers.parseEther("100");
      const expectedAssets = await vault1.previewMint(requestedShares);
      const depositFee = (expectedAssets * 500n) / 10_000n;
      const assetsAfterFee = expectedAssets - depositFee;
      const expectedMintedShares = await vault1.previewDeposit(assetsAfterFee);

      await dStable.connect(alice).approve(dStakeToken.target, expectedAssets);

      await expect(
        dStakeToken.connect(alice).solverDepositShares([vault1Address], [requestedShares], 0, alice.address)
      )
        .to.be.revertedWithCustomError(router, "SolverShareDepositShortfall")
        .withArgs(vault1Address, requestedShares, expectedMintedShares);
    });

    it("reverts when previewDeposit mints zero shares", async function () {
      const donation = ethers.parseUnits("1000000", 18);
      await bootstrapHighSharePrice(donation);

      const requestedShares = 1n;
      const requiredAssets = await vault1.previewMint(requestedShares);
      expect(requiredAssets).to.be.gt(0n);
      expect(await dStakeToken.previewDeposit(requiredAssets)).to.equal(0n);

      await dStable.connect(bob).approve(dStakeToken.target, requiredAssets);

      await expect(
        dStakeToken.connect(bob).solverDepositShares([vault1Address], [requestedShares], 0n, bob.address)
      ).to.be.revertedWithCustomError(dStakeToken, "ZeroShares");
    });
  });

  describe("Solver Mode: solverWithdrawAssets", function () {
    beforeEach(async function () {
      // Setup initial position by depositing into multiple vaults
      const vaults = [vault1Address, vault2Address, vault3Address];
      const assets = [
        ethers.parseEther("2000"), // 2000 to vault1
        ethers.parseEther("1200"), // 1200 to vault2
        ethers.parseEther("800"), // 800 to vault3
      ];
      const totalAssets = ethers.parseEther("4000");
      const minShares = ethers.parseEther("3800");

      await dStable.connect(alice).approve(dStakeToken.target, totalAssets);
      await dStakeToken.connect(alice).solverDepositAssets(vaults, assets, minShares, alice.address);
    });

    it("Should withdraw assets from multiple vaults via DStakeTokenV2", async function () {
      const vaults = [vault1Address, vault2Address, vault3Address];
      const assets = [
        ethers.parseEther("500"), // 500 from vault1
        ethers.parseEther("300"), // 300 from vault2
        ethers.parseEther("200"), // 200 from vault3
      ];
      const totalAssets = ethers.parseEther("1000");
      const maxShares = ethers.parseEther("1200"); // Allow some slippage

      const sharesBefore = await dStakeToken.balanceOf(alice.address);
      const dStableBalanceBefore = await dStable.balanceOf(alice.address);

      // Execute solver withdrawal
      const tx = await dStakeToken.connect(alice).solverWithdrawAssets(vaults, assets, maxShares, alice.address, alice.address);

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
      await expect(tx).to.emit(dStakeToken, "Withdraw");
    });

    it("Should revert when maxShares exceeded", async function () {
      const vaults = [vault1Address, vault2Address];
      const assets = [ethers.parseEther("1000"), ethers.parseEther("1000")];
      const maxShares = ethers.parseEther("100"); // Too low, should fail

      await expect(
        dStakeToken.connect(alice).solverWithdrawAssets(vaults, assets, maxShares, alice.address, alice.address)
      ).to.be.revertedWithCustomError(dStakeToken, "ERC4626ExceedsMaxRedeem");
    });

    it("Should handle partial withdrawals correctly", async function () {
      const vaults = [vault1Address];
      const assets = [ethers.parseEther("100")]; // Small withdrawal
      const maxShares = ethers.parseEther("200");

      const vault1BalanceBefore = await vault1.balanceOf(collateralVault.target);

      await dStakeToken.connect(alice).solverWithdrawAssets(vaults, assets, maxShares, alice.address, alice.address);

      const vault1BalanceAfter = await vault1.balanceOf(collateralVault.target);

      // Verify vault balance decreased
      expect(vault1BalanceAfter).to.be.lt(vault1BalanceBefore);
    });
  });

  describe("Solver Mode: solverWithdrawShares", function () {
    beforeEach(async function () {
      // Setup initial position by depositing into multiple vaults
      const vaults = [vault1Address, vault2Address, vault3Address];
      const assets = [ethers.parseEther("2000"), ethers.parseEther("1200"), ethers.parseEther("800")];
      const totalAssets = ethers.parseEther("4000");
      const minShares = ethers.parseEther("3800");

      await dStable.connect(alice).approve(dStakeToken.target, totalAssets);
      await dStakeToken.connect(alice).solverDepositAssets(vaults, assets, minShares, alice.address);
    });

    it("Should withdraw shares from multiple vaults via DStakeTokenV2", async function () {
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
      const tx = await dStakeToken.connect(alice).solverWithdrawShares(vaults, vaultShares, maxShares, alice.address, alice.address);

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
      await expect(tx).to.emit(dStakeToken, "Withdraw");
    });

    it("Should handle zero vault shares correctly", async function () {
      const vaults = [vault1Address, vault2Address, vault3Address];

      const vault1Balance = await vault1.balanceOf(collateralVault.target);
      const vaultShares = [vault1Balance / 4n, 0, 0]; // Only withdraw from vault1
      const maxShares = ethers.parseEther("800");

      const vault2BalanceBefore = await vault2.balanceOf(collateralVault.target);
      const vault3BalanceBefore = await vault3.balanceOf(collateralVault.target);

      await dStakeToken.connect(alice).solverWithdrawShares(vaults, vaultShares, maxShares, alice.address, alice.address);

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
      await expect(dStakeToken.connect(alice).solverDepositAssets(vaults, assets, minShares, alice.address)).to.be.reverted;

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
      await dStakeToken.connect(alice).solverDepositAssets(setupVaults, setupAssets, minShares, alice.address);

      const vault1BalanceBefore = await vault1.balanceOf(collateralVault.target);
      const vault2BalanceBefore = await vault2.balanceOf(collateralVault.target);

      // Try to withdraw with one invalid vault
      const vaults = [vault1Address, ethers.ZeroAddress]; // Invalid vault
      const assets = [ethers.parseEther("500"), ethers.parseEther("500")];
      const maxShares = ethers.parseEther("1200");

      await expect(dStakeToken.connect(alice).solverWithdrawAssets(vaults, assets, maxShares, alice.address, alice.address)).to.be.reverted;

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

      // Verify StrategyDepositRouted event was emitted
      await expect(tx).to.emit(router, "StrategyDepositRouted").withArgs(vaults, assets, totalAssets);
    });

    it("Should revert direct router call without proper role", async function () {
      const vaults = [vault1Address];
      const assets = [ethers.parseEther("1000")];

      await dStable.connect(bob).approve(router.target, assets[0]);

      await expect(router.connect(bob).solverDepositAssets(vaults, assets)).to.be.revertedWithCustomError(
        router,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("Should allow direct solverWithdrawAssets call with proper role", async function () {
      // Setup initial position via dStakeToken
      const setupVaults = [vault1Address, vault2Address];
      const setupAssets = [ethers.parseEther("2000"), ethers.parseEther("1000")];
      const totalSetupAssets = ethers.parseEther("3000");
      const minShares = ethers.parseEther("2900");

      await dStable.connect(alice).approve(dStakeToken.target, totalSetupAssets);
      await dStakeToken.connect(alice).solverDepositAssets(setupVaults, setupAssets, minShares, alice.address);

      // Now test direct router withdrawal
      const vaults = [vault1Address];
      const assets = [ethers.parseEther("500")];

      // Direct router calls return assets to msg.sender (alice) for fee handling
      const aliceBalanceBefore = await dStable.balanceOf(alice.address);

      const tx = await router.connect(alice).solverWithdrawAssets(vaults, assets);

      const aliceBalanceAfter = await dStable.balanceOf(alice.address);

      // Verify assets were returned to msg.sender (alice) for fee handling
      expect(aliceBalanceAfter).to.be.gt(aliceBalanceBefore);

      // Verify StrategyWithdrawalRouted event was emitted
      await expect(tx).to.emit(router, "StrategyWithdrawalRouted");
    });
  });

  describe("Solver Mode: Event Emissions", function () {
    it("Should emit proper events for solverDepositAssets", async function () {
      const vaults = [vault1Address, vault2Address];
      const assets = [ethers.parseEther("1000"), ethers.parseEther("500")];
      const totalAssets = ethers.parseEther("1500");
      const minShares = ethers.parseEther("1400");

      await dStable.connect(alice).approve(dStakeToken.target, totalAssets);

      const tx = await dStakeToken.connect(alice).solverDepositAssets(vaults, assets, minShares, alice.address);

      // Verify ERC4626 Deposit event
      await expect(tx).to.emit(dStakeToken, "Deposit");

      // Verify router StrategyDepositRouted event
      await expect(tx).to.emit(router, "StrategyDepositRouted").withArgs(vaults, assets, totalAssets);
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
      await dStakeToken.connect(alice).solverDepositAssets(setupVaults, setupAssets, minShares, alice.address);

      // Withdraw
      const vault1Balance = await vault1.balanceOf(collateralVault.target);
      const vaultShares = [vault1Balance / 2n]; // Withdraw half
      const maxShares = ethers.parseEther("1200");

      const tx = await dStakeToken.connect(alice).solverWithdrawShares(setupVaults, vaultShares, maxShares, alice.address, alice.address);

      // Verify Withdraw event
      await expect(tx).to.emit(dStakeToken, "Withdraw");

      // Verify WithdrawalFee event
      await expect(tx).to.emit(dStakeToken, "WithdrawalFee");

      // Verify router StrategyWithdrawalRouted event
      await expect(tx).to.emit(router, "StrategyWithdrawalRouted");
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
      await dStakeToken.connect(alice).solverDepositAssets(vaults1, assets1, minShares1, alice.address);

      const aliceShares1 = await dStakeToken.balanceOf(alice.address);
      const totalAssetsAfter1 = await dStakeToken.totalAssets();
      const totalSharesAfter1 = await dStakeToken.totalSupply();

      // Second deposit by different user
      const vaults2 = [vault2Address, vault3Address];
      const assets2 = [ethers.parseEther("800"), ethers.parseEther("200")];
      const totalAssets2 = ethers.parseEther("1000");
      const minShares2 = ethers.parseEther("950");

      await dStable.connect(bob).approve(dStakeToken.target, totalAssets2);
      await dStakeToken.connect(bob).solverDepositAssets(vaults2, assets2, minShares2, bob.address);

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
      const sharePrice = (totalAssetsAfter2 * ethers.parseEther("1")) / totalSharesAfter2;
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
      await dStakeToken.connect(alice).solverDepositAssets(vaults, aliceAssets, ethers.parseEther("1900"), alice.address);

      // Bob deposits
      await dStable.connect(bob).approve(dStakeToken.target, bobTotalAssets);
      await dStakeToken.connect(bob).solverDepositAssets(vaults, bobAssets, ethers.parseEther("950"), bob.address);

      const totalAssetsBeforeWithdraw = await dStakeToken.totalAssets();
      const totalSharesBeforeWithdraw = await dStakeToken.totalSupply();
      const aliceSharesBeforeWithdraw = await dStakeToken.balanceOf(alice.address);

      // Alice withdraws from specific vaults
      const withdrawVaults = [vault1Address, vault3Address];
      const withdrawAssets = [ethers.parseEther("300"), ethers.parseEther("200")];

      const feeBpsForPreview = await dStakeToken.withdrawalFeeBps();
      const grossRequests = withdrawAssets.map((netAmount) => {
        if (netAmount === 0n) return 0n;
        const denominator = 1_000_000n - BigInt(feeBpsForPreview);
        const numerator = netAmount * 1_000_000n;
        return (numerator + denominator - 1n) / denominator;
      });
      const totalGrossRequested = grossRequests.reduce((acc, amount) => acc + amount, 0n);
      const expectedShares = (totalGrossRequested * totalSharesBeforeWithdraw + totalAssetsBeforeWithdraw - 1n) / totalAssetsBeforeWithdraw;
      const maxShares = expectedShares;

      await dStakeToken.connect(alice).solverWithdrawAssets(withdrawVaults, withdrawAssets, maxShares, alice.address, alice.address);

      const totalAssetsAfterWithdraw = await dStakeToken.totalAssets();
      const totalSharesAfterWithdraw = await dStakeToken.totalSupply();
      const aliceSharesAfterWithdraw = await dStakeToken.balanceOf(alice.address);

      // Verify accounting
      const sharesBurned = aliceSharesBeforeWithdraw - aliceSharesAfterWithdraw;
      const totalSharesChange = totalSharesBeforeWithdraw - totalSharesAfterWithdraw;

      expect(sharesBurned).to.equal(totalSharesChange);
      expect(sharesBurned).to.equal(expectedShares);

      // Verify assets decreased appropriately (accounting for fees)
      expect(totalAssetsAfterWithdraw).to.be.lt(totalAssetsBeforeWithdraw);

      // Share price should remain reasonable
      const sharePriceAfter = (totalAssetsAfterWithdraw * ethers.parseEther("1")) / totalSharesAfterWithdraw;
      expect(sharePriceAfter).to.be.closeTo(ethers.parseEther("1"), ethers.parseEther("0.2"));
    });
  });

  describe("Solver Mode: Fee Application Tests", function () {
    beforeEach(async function () {
      // Setup initial position for fee testing
      const vaults = [vault1Address, vault2Address, vault3Address];
      const assets = [
        ethers.parseEther("3000"), // 3000 to vault1
        ethers.parseEther("2000"), // 2000 to vault2
        ethers.parseEther("1000"), // 1000 to vault3
      ];
      const totalAssets = ethers.parseEther("6000");
      const minShares = ethers.parseEther("5800");

      await dStable.connect(alice).approve(dStakeToken.target, totalAssets);
      await dStakeToken.connect(alice).solverDepositAssets(vaults, assets, minShares, alice.address);

      // Setup withdrawal fees - alice needs FEE_MANAGER_ROLE
      const FEE_MANAGER_ROLE = await dStakeToken.FEE_MANAGER_ROLE();
      await dStakeToken.grantRole(FEE_MANAGER_ROLE, alice.address);
      await dStakeToken.connect(alice).setWithdrawalFee(1000); // 0.1% withdrawal fee
    });

    it("Should apply withdrawal fees exactly once in solverWithdrawAssets", async function () {
      const withdrawalFeeBps = await dStakeToken.withdrawalFeeBps();
      expect(withdrawalFeeBps).to.equal(1000); // 0.1%
      const BASIS_POINTS = 1_000_000n;

      const vaults = [vault1Address, vault2Address];
      const requestedAssets = [
        ethers.parseEther("500"), // Request 500 from vault1
        ethers.parseEther("300"), // Request 300 from vault2
      ];
      const totalRequestedAssets = ethers.parseEther("800");

      const totalAssetsBefore = await dStakeToken.totalAssets();
      const totalSharesBefore = await dStakeToken.totalSupply();

      const dStakeTokenBalanceBefore = await dStable.balanceOf(dStakeToken.target);
      const aliceBalanceBefore = await dStable.balanceOf(alice.address);
      const sharesBefore = await dStakeToken.balanceOf(alice.address);

      const grossRequests = requestedAssets.map((netAmount) => {
        if (netAmount === 0n) return 0n;
        const denominator = BASIS_POINTS - BigInt(withdrawalFeeBps);
        const numerator = netAmount * BASIS_POINTS;
        return (numerator + denominator - 1n) / denominator;
      });
      const totalGrossRequested = grossRequests.reduce((acc, amount) => acc + amount, 0n);
      const expectedShares = (totalGrossRequested * totalSharesBefore + totalAssetsBefore - 1n) / totalAssetsBefore;
      const maxShares = expectedShares;

      // Execute solver withdrawal by assets
      const tx = await dStakeToken.connect(alice).solverWithdrawAssets(vaults, requestedAssets, maxShares, alice.address, alice.address);

      const dStakeTokenBalanceAfter = await dStable.balanceOf(dStakeToken.target);
      const aliceBalanceAfter = await dStable.balanceOf(alice.address);
      const sharesAfter = await dStakeToken.balanceOf(alice.address);

      const sharesBurned = sharesBefore - sharesAfter;
      const aliceReceived = aliceBalanceAfter - aliceBalanceBefore;
      const feesRetained = dStakeTokenBalanceAfter - dStakeTokenBalanceBefore;

      const feeBps = withdrawalFeeBps;
      const grossWithdrawn = aliceReceived + feesRetained;

      const expectedGross = grossRequests.reduce((acc, amount) => acc + amount, 0n);
      const expectedFee = (expectedGross * BigInt(feeBps)) / BASIS_POINTS;
      const expectedNet = expectedGross - expectedFee;
      const minTolerance = ethers.parseUnits("0.000001", 18); // 1e-6 dStable for downward rounding
      const maxPositiveTolerance = ethers.parseUnits("0.0006", 18); // Tight (≪0.1%) tolerance for rounding surplus

      // Fee should be deducted exactly once from the gross amount (allowing for rounding noise)
      expect(feesRetained).to.be.gte(expectedFee - minTolerance);
      const feeDiff = feesRetained >= expectedFee ? feesRetained - expectedFee : expectedFee - feesRetained;
      expect(feeDiff).to.be.lte(maxPositiveTolerance);

      expect(grossWithdrawn).to.be.gte(expectedGross - minTolerance);
      const grossDiff = grossWithdrawn >= expectedGross ? grossWithdrawn - expectedGross : expectedGross - grossWithdrawn;
      expect(grossDiff).to.be.lte(maxPositiveTolerance);

      expect(aliceReceived).to.be.gte(expectedNet - minTolerance);
      const netDiff = aliceReceived >= expectedNet ? aliceReceived - expectedNet : expectedNet - aliceReceived;
      expect(netDiff).to.be.lte(maxPositiveTolerance);

      // Verify shares were burned appropriately
      expect(sharesBurned).to.equal(expectedShares);

      // Verify WithdrawalFee event was emitted
      await expect(tx).to.emit(dStakeToken, "WithdrawalFee").withArgs(alice.address, alice.address, feesRetained);

      // With single-fee charging the user receives exactly the net assets they requested
      expect(aliceReceived).to.be.gte(totalRequestedAssets - minTolerance);
      const netVsRequestDiff =
        aliceReceived >= totalRequestedAssets ? aliceReceived - totalRequestedAssets : totalRequestedAssets - aliceReceived;
      expect(netVsRequestDiff).to.be.lte(maxPositiveTolerance);
    });

    it("Should apply withdrawal fees exactly once in standard withdraw", async function () {
      const BASIS_POINTS = 1_000_000n;
      const withdrawalFeeBps = BigInt(await dStakeToken.withdrawalFeeBps());

      const maxWithdrawNet = await dStakeToken.maxWithdraw(alice.address);
      expect(maxWithdrawNet).to.be.gt(0n);

      const withdrawalAmount = maxWithdrawNet < ethers.parseEther("500") ? maxWithdrawNet : ethers.parseEther("500");
      expect(withdrawalAmount).to.be.gt(0n);

      const expectedShares = await dStakeToken.previewWithdraw(withdrawalAmount);
      expect(expectedShares).to.be.gt(0n);

      const aliceSharesBefore = await dStakeToken.balanceOf(alice.address);
      const aliceBalanceBefore = await dStable.balanceOf(alice.address);
      const tokenBalanceBefore = await dStable.balanceOf(dStakeToken.target);
      const totalAssetsBefore = await dStakeToken.totalAssets();

      await dStakeToken.connect(alice).withdraw(withdrawalAmount, alice.address, alice.address);

      const aliceSharesAfter = await dStakeToken.balanceOf(alice.address);
      const aliceBalanceAfter = await dStable.balanceOf(alice.address);
      const tokenBalanceAfter = await dStable.balanceOf(dStakeToken.target);
      const totalAssetsAfter = await dStakeToken.totalAssets();

      const sharesBurned = aliceSharesBefore - aliceSharesAfter;
      expect(sharesBurned).to.equal(expectedShares);

      const netReceived = aliceBalanceAfter - aliceBalanceBefore;
      const tolerance = ethers.parseUnits("0.005", 18); // share price drift can cause small surplus
      const netDiff = netReceived >= withdrawalAmount ? netReceived - withdrawalAmount : withdrawalAmount - netReceived;
      expect(netDiff).to.be.lte(tolerance);

      const feeCollected = tokenBalanceAfter - tokenBalanceBefore;
      const grossWithdrawn = netReceived + feeCollected;

      // Fee should match the configured rate (rounded down, matching Math.mulDiv behaviour)
      const expectedFee = (grossWithdrawn * withdrawalFeeBps) / BASIS_POINTS;
      expect(feeCollected).to.be.closeTo(expectedFee, 1n);

      // Gross minus fee must equal the net we requested (no double charging)
      expect(grossWithdrawn - feeCollected).to.equal(netReceived);

      // totalAssets should fall by the gross amount withdrawn
      const totalAssetsDelta = totalAssetsBefore - totalAssetsAfter;
      const assetsDeltaDiff = totalAssetsDelta >= netReceived ? totalAssetsDelta - netReceived : netReceived - totalAssetsDelta;
      expect(assetsDeltaDiff).to.be.lte(tolerance);
    });

    it("Should apply withdrawal fees exactly once in solverWithdrawShares", async function () {
      const withdrawalFeeBps = await dStakeToken.withdrawalFeeBps();
      expect(withdrawalFeeBps).to.equal(1000); // 0.1%

      // Get current vault balances to calculate withdrawal amounts
      const vault1Balance = await vault1.balanceOf(collateralVault.target);
      const vault2Balance = await vault2.balanceOf(collateralVault.target);

      const vaults = [vault1Address, vault2Address];
      const sharesToWithdraw = [
        vault1Balance / 5n, // 20% of vault1 shares
        vault2Balance / 10n, // 10% of vault2 shares
      ];
      // Calculate expected gross assets from vault previews
      const expectedGrossFromVault1 = await vault1.previewRedeem(sharesToWithdraw[0]);
      const expectedGrossFromVault2 = await vault2.previewRedeem(sharesToWithdraw[1]);
      const totalExpectedGross = expectedGrossFromVault1 + expectedGrossFromVault2;

      const totalAssetsBefore = await dStakeToken.totalAssets();
      const totalSharesBefore = await dStakeToken.totalSupply();
      const expectedShares = (totalExpectedGross * totalSharesBefore + totalAssetsBefore - 1n) / totalAssetsBefore;
      const maxShares = expectedShares;

      const dStakeTokenBalanceBefore = await dStable.balanceOf(dStakeToken.target);
      const aliceBalanceBefore = await dStable.balanceOf(alice.address);
      const sharesBefore = await dStakeToken.balanceOf(alice.address);

      // Execute solver withdrawal by shares
      const tx = await dStakeToken.connect(alice).solverWithdrawShares(vaults, sharesToWithdraw, maxShares, alice.address, alice.address);

      const dStakeTokenBalanceAfter = await dStable.balanceOf(dStakeToken.target);
      const aliceBalanceAfter = await dStable.balanceOf(alice.address);
      const sharesAfter = await dStakeToken.balanceOf(alice.address);

      const sharesBurned = sharesBefore - sharesAfter;
      const aliceReceived = aliceBalanceAfter - aliceBalanceBefore;
      const feesRetained = dStakeTokenBalanceAfter - dStakeTokenBalanceBefore;

      // Calculate actual gross withdrawn and expected fee
      const grossWithdrawn = aliceReceived + feesRetained;
      const expectedFee = (grossWithdrawn * withdrawalFeeBps) / 1000000n; // 0.1% of gross

      // Verify fee calculation is correct (within 1 wei tolerance for rounding)
      expect(feesRetained).to.be.closeTo(expectedFee, 1);

      // Verify alice received net amount after fee
      expect(aliceReceived).to.equal(grossWithdrawn - feesRetained);

      // Verify shares were burned appropriately
      expect(sharesBurned).to.equal(expectedShares);

      // Verify WithdrawalFee event was emitted
      await expect(tx).to.emit(dStakeToken, "WithdrawalFee").withArgs(alice.address, alice.address, feesRetained);

      // Critical assertion: The gross amount should match vault preview calculations
      // If fees were double-charged, grossWithdrawn would be significantly different
      expect(grossWithdrawn).to.be.closeTo(totalExpectedGross, ethers.parseEther("20"));

      // Additional verification: The actual vault balances should have decreased by the withdrawn shares
      const vault1BalanceAfter = await vault1.balanceOf(collateralVault.target);
      const vault2BalanceAfter = await vault2.balanceOf(collateralVault.target);

      expect(vault1BalanceAfter).to.equal(vault1Balance - sharesToWithdraw[0]);
      expect(vault2BalanceAfter).to.equal(vault2Balance - sharesToWithdraw[1]);
    });

    it("Should demonstrate fee consistency between normal and solver withdrawals", async function () {
      // This test compares fees applied in normal withdrawals vs solver withdrawals
      // to ensure consistency and prove no double-charging

      const withdrawalAmount = ethers.parseEther("500");
      const withdrawalFeeBps = await dStakeToken.withdrawalFeeBps();

      // Test 1: Normal withdrawal fee calculation
      const grossForNormalWithdrawal = (withdrawalAmount * 1000000n) / (1000000n - withdrawalFeeBps);
      const expectedNormalFee = grossForNormalWithdrawal - withdrawalAmount;

      // Test 2: Simulate solver withdrawal to compare fee behavior
      const vaults = [vault1Address];
      const assets = [withdrawalAmount];
      const maxShares = ethers.parseEther("600");

      const dStakeTokenBalanceBefore = await dStable.balanceOf(dStakeToken.target);
      const aliceBalanceBefore = await dStable.balanceOf(alice.address);

      // Execute solver withdrawal
      await dStakeToken.connect(alice).solverWithdrawAssets(vaults, assets, maxShares, alice.address, alice.address);

      const dStakeTokenBalanceAfter = await dStable.balanceOf(dStakeToken.target);
      const aliceBalanceAfter = await dStable.balanceOf(alice.address);

      const aliceReceived = aliceBalanceAfter - aliceBalanceBefore;
      const solverFeesRetained = dStakeTokenBalanceAfter - dStakeTokenBalanceBefore;
      const solverGrossWithdrawn = aliceReceived + solverFeesRetained;

      // Calculate solver fee as percentage of gross
      const solverFeeRate = (solverFeesRetained * 1000000n) / solverGrossWithdrawn;

      // Verify solver fee rate matches expected withdrawal fee rate
      expect(solverFeeRate).to.be.closeTo(withdrawalFeeBps, 100); // Within 0.01% tolerance

      // Verify alice received the expected net amount
      expect(aliceReceived).to.be.closeTo(withdrawalAmount, ethers.parseEther("10"));

      // The key assertion: solver withdrawal applies fees at the same rate as normal withdrawals
      // This proves fees are not being double-charged in solver mode
      console.log(`Normal withdrawal fee rate: ${withdrawalFeeBps} bps`);
      console.log(`Solver withdrawal fee rate: ${solverFeeRate} bps`);
      console.log(
        `Difference: ${solverFeeRate > withdrawalFeeBps ? solverFeeRate - withdrawalFeeBps : withdrawalFeeBps - solverFeeRate} bps`
      );
    });

    it("Should handle zero fee scenarios correctly in solver withdrawals", async function () {
      // Set withdrawal fee to zero
      await dStakeToken.connect(alice).setWithdrawalFee(0);

      const vaults = [vault1Address, vault2Address];
      const assets = [ethers.parseEther("400"), ethers.parseEther("600")];
      const totalAssets = ethers.parseEther("1000");
      const maxShares = ethers.parseEther("1200");

      const dStakeTokenBalanceBefore = await dStable.balanceOf(dStakeToken.target);
      const aliceBalanceBefore = await dStable.balanceOf(alice.address);

      // Execute solver withdrawal with zero fees
      const tx = await dStakeToken.connect(alice).solverWithdrawAssets(vaults, assets, maxShares, alice.address, alice.address);

      const dStakeTokenBalanceAfter = await dStable.balanceOf(dStakeToken.target);
      const aliceBalanceAfter = await dStable.balanceOf(alice.address);

      const feesRetained = dStakeTokenBalanceAfter - dStakeTokenBalanceBefore;
      const aliceReceived = aliceBalanceAfter - aliceBalanceBefore;

      // With zero fees, no fees should be retained
      expect(feesRetained).to.equal(0);

      // Alice should receive approximately the full gross amount
      expect(aliceReceived).to.be.closeTo(totalAssets, ethers.parseEther("50"));

      // WithdrawalFee event should NOT be emitted when fee is zero
      await expect(tx).to.not.emit(dStakeToken, "WithdrawalFee");
    });

    it("Should handle maximum fee scenarios correctly in solver withdrawals", async function () {
      // Set withdrawal fee to maximum allowed (1%)
      const maxFee = await dStakeToken.maxWithdrawalFeeBps(); // Should be 10000 (1%)
      await dStakeToken.connect(alice).setWithdrawalFee(maxFee);

      const vaults = [vault1Address];
      const assets = [ethers.parseEther("1000")];
      const maxShares = ethers.parseEther("1200");

      const dStakeTokenBalanceBefore = await dStable.balanceOf(dStakeToken.target);
      const aliceBalanceBefore = await dStable.balanceOf(alice.address);

      // Execute solver withdrawal with maximum fees
      await dStakeToken.connect(alice).solverWithdrawAssets(vaults, assets, maxShares, alice.address, alice.address);

      const dStakeTokenBalanceAfter = await dStable.balanceOf(dStakeToken.target);
      const aliceBalanceAfter = await dStable.balanceOf(alice.address);

      const feesRetained = dStakeTokenBalanceAfter - dStakeTokenBalanceBefore;
      const aliceReceived = aliceBalanceAfter - aliceBalanceBefore;
      const grossWithdrawn = aliceReceived + feesRetained;

      // Calculate expected fee at maximum rate
      const expectedFeeRate = maxFee; // 10000 bps = 1%
      const calculatedFeeRate = (feesRetained * 1000000n) / grossWithdrawn;

      // Verify fee is applied at maximum rate
      expect(calculatedFeeRate).to.be.closeTo(expectedFeeRate, 100);

      // Verify fee amount is reasonable (1% of gross)
      const expectedFeeAmount = (grossWithdrawn * expectedFeeRate) / 1000000n;
      expect(feesRetained).to.be.closeTo(expectedFeeAmount, 1);

      // Verify the withdrawal still functions correctly even with maximum fees
      expect(aliceReceived).to.be.gt(0);
      expect(grossWithdrawn).to.be.closeTo(ethers.parseEther("1000"), ethers.parseEther("50"));
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
      await dStakeToken.connect(alice).solverDepositAssets(aliceVaults, aliceAssets, ethers.parseEther("1900"), alice.address);

      // Bob: Focus on vault2 and vault3
      const bobVaults = [vault2Address, vault3Address];
      const bobAssets = [ethers.parseEther("800"), ethers.parseEther("700")];
      const bobTotalAssets = ethers.parseEther("1500");

      await dStable.connect(bob).approve(dStakeToken.target, bobTotalAssets);
      await dStakeToken.connect(bob).solverDepositAssets(bobVaults, bobAssets, ethers.parseEther("1400"), bob.address);

      // Charlie: All vaults with different distribution
      const charlieVaults = [vault1Address, vault2Address, vault3Address];
      const charlieAssets = [ethers.parseEther("300"), ethers.parseEther("400"), ethers.parseEther("300")];
      const charlieTotalAssets = ethers.parseEther("1000");

      await dStable.connect(charlie).approve(dStakeToken.target, charlieTotalAssets);
      await dStakeToken.connect(charlie).solverDepositAssets(charlieVaults, charlieAssets, ethers.parseEther("950"), charlie.address);

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
      await dStakeToken
        .connect(alice)
        .solverWithdrawShares([vault1Address], aliceWithdrawShares, ethers.parseEther("300"), alice.address, alice.address);

      // Bob withdraws using assets
      const bobWithdrawAssets = [ethers.parseEther("200"), ethers.parseEther("150")];
      await dStakeToken
        .connect(bob)
        .solverWithdrawAssets([vault2Address, vault3Address], bobWithdrawAssets, ethers.parseEther("400"), bob.address, bob.address);

      // Verify system integrity after mixed operations
      const finalTotalAssets = await dStakeToken.totalAssets();
      const finalTotalShares = await dStakeToken.totalSupply();

      expect(finalTotalAssets).to.be.gt(0);
      expect(finalTotalShares).to.be.gt(0);

      // Verify share price remains reasonable
      const finalSharePrice = (finalTotalAssets * ethers.parseEther("1")) / finalTotalShares;
      expect(finalSharePrice).to.be.closeTo(ethers.parseEther("1"), ethers.parseEther("0.2"));
    });
  });
});
