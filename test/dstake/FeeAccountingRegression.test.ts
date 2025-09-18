import { expect } from "chai";
import { ethers, deployments } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  DStakeRouterV2,
  MockMetaMorphoVault,
  ERC20StablecoinUpgradeable,
  DStakeCollateralVault,
  MetaMorphoConversionAdapter,
  DStakeToken
} from "../../typechain-types";

const ONE_HUNDRED_PERCENT_BPS = 1_000_000n;

describe("Fee Accounting Regression Test", function () {
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let charlie: SignerWithAddress;
  let solver: SignerWithAddress;

  let dStable: ERC20StablecoinUpgradeable;
  let router: DStakeRouterV2;
  let collateralVault: DStakeCollateralVault;
  let dStakeToken: DStakeToken;
  let vault: MockMetaMorphoVault;
  let adapter: MetaMorphoConversionAdapter;
  let reinvestIncentiveBps: bigint;

  beforeEach(async function () {
    // Deploy fresh contracts
    await deployments.fixture(["dusd", "dStake", "mock-metamorpho-vaults", "metamorpho-adapters", "test-permissions"]);

    [owner, alice, bob, charlie, solver] = await ethers.getSigners();

    // Get deployed contracts with error checking
    const dStableDeployment = await deployments.get("dUSD");
    const dStakeTokenDeployment = await deployments.get("DStakeToken_sdUSD");
    const collateralVaultDeployment = await deployments.get("DStakeCollateralVault_sdUSD");
    const routerDeployment = await deployments.get("DStakeRouterV2_sdUSD");
    const vaultDeployment = await deployments.get("MockMetaMorphoVault_dUSD");
    const adapterDeployment = await deployments.get("MetaMorphoConversionAdapter_dUSD");

    // Verify all deployments exist
    if (!dStableDeployment?.address) throw new Error("dUSD deployment not found");
    if (!dStakeTokenDeployment?.address) throw new Error("DStakeToken_sdUSD deployment not found");
    if (!collateralVaultDeployment?.address) throw new Error("DStakeCollateralVault_sdUSD deployment not found");
    if (!routerDeployment?.address) throw new Error("DStakeRouterV2_sdUSD deployment not found");
    if (!vaultDeployment?.address) throw new Error("MockMetaMorphoVault_dUSD deployment not found");
    if (!adapterDeployment?.address) throw new Error("MetaMorphoConversionAdapter_dUSD deployment not found");

    dStable = await ethers.getContractAt("ERC20StablecoinUpgradeable", dStableDeployment.address);
    dStakeToken = await ethers.getContractAt("DStakeToken", dStakeTokenDeployment.address);
    collateralVault = await ethers.getContractAt("DStakeCollateralVault", collateralVaultDeployment.address);
    router = await ethers.getContractAt("DStakeRouterV2", routerDeployment.address);
    vault = await ethers.getContractAt("MockMetaMorphoVault", vaultDeployment.address);
    adapter = await ethers.getContractAt("MetaMorphoConversionAdapter", adapterDeployment.address);

    reinvestIncentiveBps = await dStakeToken.reinvestIncentiveBps();

    // Setup permissions and configuration
    const MINTER_ROLE = await dStable.MINTER_ROLE();
    await dStable.connect(owner).grantRole(MINTER_ROLE, owner.address);

    // Configure router with vault
    const VAULT_MANAGER_ROLE = await router.VAULT_MANAGER_ROLE();
    const hasRole = await router.hasRole(VAULT_MANAGER_ROLE, owner.address);
    if (!hasRole) {
      // Get governance account to grant role
      const DEFAULT_ADMIN_ROLE = await router.DEFAULT_ADMIN_ROLE();
      const adminCount = await router.getRoleMemberCount(DEFAULT_ADMIN_ROLE);
      if (adminCount > 0) {
        const admin = await router.getRoleMember(DEFAULT_ADMIN_ROLE, 0);
        const adminSigner = await ethers.getImpersonatedSigner(admin);
        await owner.sendTransaction({ to: admin, value: ethers.parseEther("1") });
        await router.connect(adminSigner).grantRole(VAULT_MANAGER_ROLE, owner.address);
      }
    }

    // Add vault configuration if not already configured
    const vaultCount = await router.getVaultCount();
    if (vaultCount === 0n) {
      await router.connect(owner).addVaultConfig(
        await vault.getAddress(),
        await adapter.getAddress(),
        10000, // 100% allocation
        true
      );
    }

    // Set withdrawal fee for testing
    const FEE_MANAGER_ROLE = await dStakeToken.FEE_MANAGER_ROLE();
    await dStakeToken.grantRole(FEE_MANAGER_ROLE, owner.address);
    await dStakeToken.connect(owner).setWithdrawalFee(5000); // 0.05% fee (with 2 decimal precision)

    // Setup initial balances
    await dStable.mint(alice.address, ethers.parseEther("10000"));
    await dStable.mint(bob.address, ethers.parseEther("10000"));
    await dStable.mint(charlie.address, ethers.parseEther("10000"));
    await dStable.mint(solver.address, ethers.parseEther("10000"));

    // Set router and collateral vault on DStakeToken (critical for deposit/withdraw to work)
    const DEFAULT_ADMIN_ROLE = await dStakeToken.DEFAULT_ADMIN_ROLE();
    await dStakeToken.connect(owner).grantRole(DEFAULT_ADMIN_ROLE, owner.address);
    await dStakeToken.connect(owner).setRouter(await router.getAddress());
    await dStakeToken.connect(owner).setCollateralVault(await collateralVault.getAddress());

    // Ensure collateral vault has vault shares for withdrawals
    // The vault mint function requires the caller to provide assets, so give the owner the assets
    // Reduced from 20000 to 100 to fix ZeroShares error - large pre-funding causes dilution
    await dStable.mint(owner.address, ethers.parseEther("100"));
    await dStable.connect(owner).approve(await vault.getAddress(), ethers.parseEther("100"));
    // Then mint vault shares to the collateral vault
    await vault.mint(ethers.parseEther("100"), await collateralVault.getAddress());

    // Approve spending
    await dStable.connect(alice).approve(await dStakeToken.getAddress(), ethers.MaxUint256);
    await dStable.connect(bob).approve(await dStakeToken.getAddress(), ethers.MaxUint256);
    await dStable.connect(charlie).approve(await dStakeToken.getAddress(), ethers.MaxUint256);
    await dStable.connect(solver).approve(await dStakeToken.getAddress(), ethers.MaxUint256);
  });

  describe("Fee Accounting in totalAssets()", function () {
    it("Should include dStable balance held by DStakeToken contract in totalAssets()", async function () {
      // Initial deposit to establish vault
      await dStakeToken.connect(alice).deposit(ethers.parseEther("1000"), alice.address);

      const initialTotalAssets = await dStakeToken.totalAssets();
      const initialContractBalance = await dStable.balanceOf(await dStakeToken.getAddress());

      // Manually send some dStable to the contract (simulating fees)
      const feeAmount = ethers.parseEther("100");
      await dStable.mint(await dStakeToken.getAddress(), feeAmount);

      const newTotalAssets = await dStakeToken.totalAssets();
      const newContractBalance = await dStable.balanceOf(await dStakeToken.getAddress());

      // Verify that totalAssets increased by the fee amount
      expect(newTotalAssets).to.equal(initialTotalAssets + feeAmount);
      expect(newContractBalance).to.equal(initialContractBalance + feeAmount);
    });

    it("Should properly account for accumulated fees from multiple solver withdrawals", async function () {
      // Setup initial position
      await dStakeToken.connect(alice).deposit(ethers.parseEther("2000"), alice.address);

      const initialTotalAssets = await dStakeToken.totalAssets();

      // Perform multiple solver withdrawals that generate fees
      const maxShares = ethers.parseEther("150");

      // First withdrawal
      const vaultBalance1 = await vault.balanceOf(await collateralVault.getAddress());
      await dStakeToken.connect(alice).solverWithdrawShares(
        [await vault.getAddress()],
        [vaultBalance1 / 10n], // 10% withdrawal
        maxShares,
        alice.address,
        alice.address
      );

      const feeBalanceAfterFirst = await dStable.balanceOf(await dStakeToken.getAddress());
      const totalAssetsAfterFirst = await dStakeToken.totalAssets();

      // Second withdrawal
      const vaultBalance2 = await vault.balanceOf(await collateralVault.getAddress());
      await dStakeToken.connect(alice).solverWithdrawShares(
        [await vault.getAddress()],
        [vaultBalance2 / 10n], // Another 10% withdrawal
        maxShares,
        alice.address,
        alice.address
      );

      const feeBalanceAfterSecond = await dStable.balanceOf(await dStakeToken.getAddress());
      const totalAssetsAfterSecond = await dStakeToken.totalAssets();

      // Verify fees accumulated and are included in totalAssets
      expect(feeBalanceAfterSecond).to.be.gt(feeBalanceAfterFirst);
      expect(totalAssetsAfterSecond).to.be.gt(0);

      // Verify that totalAssets includes the accumulated fees
      const vaultValue = await collateralVault.totalValueInDStable();
      const expectedTotalAssets = vaultValue + feeBalanceAfterSecond;
      expect(totalAssetsAfterSecond).to.equal(expectedTotalAssets);
    });

    it("Should maintain accurate share pricing with accumulated fees", async function () {
      // Initial deposits from multiple users
      await dStakeToken.connect(alice).deposit(ethers.parseEther("1000"), alice.address);
      await dStakeToken.connect(bob).deposit(ethers.parseEther("1000"), bob.address);

      const totalAssets = await dStakeToken.totalAssets();
      const totalSupply = await dStakeToken.totalSupply();
      const initialSharePrice = totalAssets * ethers.parseEther("1") / totalSupply;

      // Perform solver withdrawals to generate fees
      const vaultBalance = await vault.balanceOf(await collateralVault.getAddress());
      const withdrawShares = vaultBalance / 20n; // 5% withdrawal
      await dStakeToken.connect(alice).solverWithdrawShares(
        [await vault.getAddress()],
        [withdrawShares],
        ethers.parseEther("100"),
        alice.address,
        alice.address
      );

      // Verify fees are accumulated
      const feesAccumulated = await dStable.balanceOf(await dStakeToken.getAddress());
      expect(feesAccumulated).to.be.gt(0);

      // Check that share price reflects the accumulated fees
      const newTotalAssets = await dStakeToken.totalAssets();
      const newTotalSupply = await dStakeToken.totalSupply();
      const newSharePrice = newTotalAssets * ethers.parseEther("1") / newTotalSupply;

      // Share price should be higher due to accumulated fees (fewer shares, more assets)
      expect(newSharePrice).to.be.gt(initialSharePrice);

      // Verify that a new depositor gets fair share pricing
      const charlieDepositAmount = ethers.parseEther("500");
      const previewShares = await dStakeToken.previewDeposit(charlieDepositAmount);

      await dStakeToken.connect(charlie).deposit(charlieDepositAmount, charlie.address);
      const charlieActualShares = await dStakeToken.balanceOf(charlie.address);

      expect(charlieActualShares).to.equal(previewShares);
    });
  });

  describe("reinvestFees() Function", function () {
    beforeEach(async function () {
      // Setup initial position and generate some fees
      await dStakeToken.connect(alice).deposit(ethers.parseEther("2000"), alice.address);

      // Generate fees through solver withdrawal
      const vaultBalance = await vault.balanceOf(await collateralVault.getAddress());
      const withdrawShares = vaultBalance / 10n; // 10% withdrawal
      await dStakeToken.connect(alice).solverWithdrawShares(
        [await vault.getAddress()],
        [withdrawShares],
        ethers.parseEther("300"),
        alice.address,
        alice.address
      );
    });

    it("Should reinvest accumulated fees back into the vault", async function () {
      const feesBeforeReinvest = await dStable.balanceOf(await dStakeToken.getAddress());
      expect(feesBeforeReinvest).to.be.gt(0); // Ensure we have fees to reinvest

      const vaultValueBefore = await collateralVault.totalValueInDStable();

      const expectedIncentive = feesBeforeReinvest * reinvestIncentiveBps / ONE_HUNDRED_PERCENT_BPS;
      const expectedReinvested = feesBeforeReinvest - expectedIncentive;

      // Reinvest fees
      const tx = await dStakeToken.connect(bob).reinvestFees(); // Anyone can call this

      const feesAfterReinvest = await dStable.balanceOf(await dStakeToken.getAddress());
      const vaultValueAfter = await collateralVault.totalValueInDStable();

      // Verify fees were reinvested
      expect(feesAfterReinvest).to.equal(0);
      expect(vaultValueAfter).to.be.closeTo(vaultValueBefore + expectedReinvested, ethers.parseEther("0.001"));

      // Verify FeesReinvested event was emitted
      await expect(tx)
        .to.emit(dStakeToken, "FeesReinvested")
        .withArgs(expectedReinvested, expectedIncentive, bob.address);
    });

    it("Should return zero and not revert when no fees to reinvest", async function () {
      // First reinvest any existing fees
      await dStakeToken.reinvestFees();

      // Verify no fees remain
      expect(await dStable.balanceOf(await dStakeToken.getAddress())).to.equal(0);

      // Call reinvestFees again - should return 0 and not revert
      const result = await dStakeToken.reinvestFees.staticCall();
      expect(result).to.equal(0);

      const tx = await dStakeToken.reinvestFees();
      await expect(tx).to.not.emit(dStakeToken, "FeesReinvested");
    });

    it("Should handle partial reinvestment scenarios", async function () {
      const initialFees = await dStable.balanceOf(await dStakeToken.getAddress());

      // Add more fees manually to test larger amounts
      const additionalFees = ethers.parseEther("50");
      await dStable.mint(await dStakeToken.getAddress(), additionalFees);

      const totalFees = initialFees + additionalFees;
      const vaultValueBefore = await collateralVault.totalValueInDStable();

      const expectedIncentive = totalFees * reinvestIncentiveBps / ONE_HUNDRED_PERCENT_BPS;
      const expectedReinvested = totalFees - expectedIncentive;

      // Reinvest all fees
      await dStakeToken.reinvestFees();

      const vaultValueAfter = await collateralVault.totalValueInDStable();
      const feesRemaining = await dStable.balanceOf(await dStakeToken.getAddress());

      // All fees should be reinvested
      expect(feesRemaining).to.equal(0);
      expect(vaultValueAfter).to.be.closeTo(vaultValueBefore + expectedReinvested, ethers.parseEther("0.001"));
    });
  });

  describe("Value Conservation Under Multiple Operations", function () {
    it("Should maintain total value across multiple solver withdrawals and reinvestments", async function () {
      // Initial setup with multiple users
      await dStakeToken.connect(alice).deposit(ethers.parseEther("2000"), alice.address);
      await dStakeToken.connect(bob).deposit(ethers.parseEther("1500"), bob.address);
      await dStakeToken.connect(charlie).deposit(ethers.parseEther("1000"), charlie.address);

      const initialTotalAssets = await dStakeToken.totalAssets();

      // Track value over multiple operations
      let cumulativeWithdrawals = 0n;

      // Perform multiple solver withdrawals
      for (let i = 0; i < 3; i++) {
        const vaultBalance = await vault.balanceOf(await collateralVault.getAddress());
        const withdrawShares = vaultBalance / 20n; // 5% each time
        const beforeBalance = await dStable.balanceOf(alice.address);

        await dStakeToken.connect(alice).solverWithdrawShares(
          [await vault.getAddress()],
          [withdrawShares],
          ethers.parseEther("200"),
          alice.address,
          alice.address
        );

        const afterBalance = await dStable.balanceOf(alice.address);
        cumulativeWithdrawals = cumulativeWithdrawals + (afterBalance - beforeBalance);
      }

      // Check accumulated fees
      const accumulatedFees = await dStable.balanceOf(await dStakeToken.getAddress());
      expect(accumulatedFees).to.be.gt(0);

      // Verify totalAssets equals vault holdings plus fees
      const vaultValue = await collateralVault.totalValueInDStable();
      const calculatedTotalAssets = vaultValue + accumulatedFees;
      const actualTotalAssets = await dStakeToken.totalAssets();

      expect(actualTotalAssets).to.equal(calculatedTotalAssets);

      // Reinvest fees and verify conservation
      const expectedIncentive = accumulatedFees * reinvestIncentiveBps / ONE_HUNDRED_PERCENT_BPS;
      await dStakeToken.reinvestFees();

      const finalTotalAssets = await dStakeToken.totalAssets();

      // The total value should be initial value minus net withdrawals
      // (allowing for small rounding differences)
      const expectedFinalValue = initialTotalAssets - cumulativeWithdrawals - expectedIncentive;
      expect(finalTotalAssets).to.be.closeTo(expectedFinalValue, ethers.parseEther("1"));

      // Verify no fees remain after reinvestment
      expect(await dStable.balanceOf(await dStakeToken.getAddress())).to.equal(0);
    });

    it("Should handle edge case with zero fees correctly", async function () {
      // Deposit without generating fees first
      await dStakeToken.connect(alice).deposit(ethers.parseEther("1000"), alice.address);

      // Verify no fees initially
      expect(await dStable.balanceOf(await dStakeToken.getAddress())).to.equal(0);

      const totalAssetsBefore = await dStakeToken.totalAssets();
      const vaultValueBefore = await collateralVault.totalValueInDStable();

      // totalAssets should equal vault value when no fees
      expect(totalAssetsBefore).to.equal(vaultValueBefore);

      // Reinvest fees (should be no-op)
      const result = await dStakeToken.reinvestFees.staticCall();
      expect(result).to.equal(0);

      await dStakeToken.reinvestFees();

      // Values should remain unchanged
      expect(await dStakeToken.totalAssets()).to.equal(totalAssetsBefore);
      expect(await collateralVault.totalValueInDStable()).to.equal(vaultValueBefore);
    });

    it("Should handle large withdrawal with significant fees", async function () {
      // Large initial deposit
      const largeAmount = ethers.parseEther("10000");
      await dStable.mint(alice.address, largeAmount);
      await dStakeToken.connect(alice).deposit(largeAmount, alice.address);

      // Large withdrawal to generate significant fees
      const vaultBalance = await vault.balanceOf(await collateralVault.getAddress());
      const largeWithdrawShares = vaultBalance / 2n; // 50% withdrawal
      const maxShares = ethers.parseEther("6000");

      const aliceBalanceBefore = await dStable.balanceOf(alice.address);

      await dStakeToken.connect(alice).solverWithdrawShares(
        [await vault.getAddress()],
        [largeWithdrawShares],
        maxShares,
        alice.address,
        alice.address
      );

      const aliceBalanceAfter = await dStable.balanceOf(alice.address);

      // Verify significant fees were collected
      const feesCollected = await dStable.balanceOf(await dStakeToken.getAddress());
      expect(feesCollected).to.be.gt(ethers.parseEther("1")); // Should be substantial

      // Verify totalAssets accounts for fees
      const vaultValue = await collateralVault.totalValueInDStable();
      const totalAssets = await dStakeToken.totalAssets();
      expect(totalAssets).to.equal(vaultValue + feesCollected);

      // Verify share pricing is still accurate
      const currentSupply = await dStakeToken.totalSupply();
      if (currentSupply > 0n) {
        const sharePrice = totalAssets * ethers.parseEther("1") / currentSupply;
        expect(sharePrice).to.be.gte(ethers.parseEther("1")); // Should be >= 1 due to fees
      }

      // Reinvest and verify conservation
      await dStakeToken.reinvestFees();

      const finalTotalAssets = await dStakeToken.totalAssets();
      const finalVaultValue = await collateralVault.totalValueInDStable();

      expect(finalTotalAssets).to.equal(finalVaultValue);
      expect(await dStable.balanceOf(await dStakeToken.getAddress())).to.equal(0);
    });
  });

  describe("Integration with Share Pricing", function () {
    it("Should ensure no value leakage from accounting set", async function () {
      // Setup initial state with multiple participants
      const participants = [alice, bob, charlie];
      const depositAmounts = [
        ethers.parseEther("2000"),
        ethers.parseEther("1500"),
        ethers.parseEther("1000")
      ];

      const startingTotalAssets = await dStakeToken.totalAssets();

      // All participants deposit
      for (let i = 0; i < participants.length; i++) {
        await dStakeToken.connect(participants[i]).deposit(depositAmounts[i], participants[i].address);
      }

      const totalDeposited = depositAmounts.reduce((sum, amount) => sum + amount, 0n);
      const supplyAfterDeposits = await dStakeToken.totalSupply();
      const assetsAfterDeposits = await dStakeToken.totalAssets();
      const sharePriceAfterDeposits = supplyAfterDeposits > 0n ? (assetsAfterDeposits * ethers.parseEther("1")) / supplyAfterDeposits : 0n;

      // Perform multiple rounds of withdrawals and reinvestments
      let totalWithdrawn = 0n;
      let totalIncentivesPaid = 0n;

      for (let round = 0; round < 3; round++) {
        // Solver withdrawal
        const vaultBalance = await vault.balanceOf(await collateralVault.getAddress());
        const withdrawShares = vaultBalance / 10n; // 10% each round
        const beforeBalance = await dStable.balanceOf(alice.address);

        await dStakeToken.connect(alice).solverWithdrawShares(
          [await vault.getAddress()],
          [withdrawShares],
          ethers.parseEther("300"),
          alice.address,
          alice.address
        );

        const afterBalance = await dStable.balanceOf(alice.address);
        totalWithdrawn = totalWithdrawn + (afterBalance - beforeBalance);

        // Check that fees are properly tracked
        const currentFees = await dStable.balanceOf(await dStakeToken.getAddress());
        const currentTotalAssets = await dStakeToken.totalAssets();
        const currentVaultValue = await collateralVault.totalValueInDStable();

        // Invariant: totalAssets = vaultValue + fees
        expect(currentTotalAssets).to.equal(currentVaultValue + currentFees);

        // Occasionally reinvest fees
        if (round % 2 === 1) {
          const pendingFees = await dStable.balanceOf(await dStakeToken.getAddress());
          const incentive = pendingFees * reinvestIncentiveBps / ONE_HUNDRED_PERCENT_BPS;
          totalIncentivesPaid = totalIncentivesPaid + incentive;
          await dStakeToken.reinvestFees();

          // After reinvestment, no fees should remain
          expect(await dStable.balanceOf(await dStakeToken.getAddress())).to.equal(0);

          // totalAssets should equal vault value
          const postReinvestTotalAssets = await dStakeToken.totalAssets();
          const postReinvestVaultValue = await collateralVault.totalValueInDStable();
          expect(postReinvestTotalAssets).to.equal(postReinvestVaultValue);
        }
      }

      // Final reconciliation
      const pendingFees = await dStable.balanceOf(await dStakeToken.getAddress());
      const finalIncentive = pendingFees * reinvestIncentiveBps / ONE_HUNDRED_PERCENT_BPS;
      totalIncentivesPaid = totalIncentivesPaid + finalIncentive;
      await dStakeToken.reinvestFees(); // Ensure all fees are reinvested

      const finalTotalAssets = await dStakeToken.totalAssets();
      const finalTotalSupply = await dStakeToken.totalSupply();

      // Value conservation check: total value should equal deposits minus withdrawals
      const expectedValue = startingTotalAssets + totalDeposited - totalWithdrawn - totalIncentivesPaid;
      expect(finalTotalAssets).to.be.closeTo(expectedValue, ethers.parseEther("1"));

      // Share price should be reasonable (close to 1 ETH per share)
      if (finalTotalSupply > 0n) {
        const finalSharePrice = finalTotalAssets * ethers.parseEther("1") / finalTotalSupply;
        if (sharePriceAfterDeposits > 0n) {
          const sharePriceTolerance = sharePriceAfterDeposits / 10n; // allow 10% drift
          expect(finalSharePrice).to.be.closeTo(sharePriceAfterDeposits, sharePriceTolerance);
        } else {
          expect(finalSharePrice).to.be.closeTo(ethers.parseEther("1"), ethers.parseEther("0.2"));
        }
      }

      // No fees should be stranded
      expect(await dStable.balanceOf(await dStakeToken.getAddress())).to.equal(0);
    });

    it("Should handle alternating deposits and withdrawals with fee accumulation", async function () {
      const startingTotalAssets = await dStakeToken.totalAssets();
      let currentTotalDeposited = 0n;
      let currentTotalWithdrawn = 0n;
      let totalIncentivesPaid = 0n;

      // Round 1: Deposits
      await dStakeToken.connect(alice).deposit(ethers.parseEther("1000"), alice.address);
      currentTotalDeposited = currentTotalDeposited + ethers.parseEther("1000");

      // Round 2: Withdrawal with fees
      const vaultBalance1 = await vault.balanceOf(await collateralVault.getAddress());
      const withdrawShares1 = vaultBalance1 / 10n;
      const beforeBalance1 = await dStable.balanceOf(alice.address);
      await dStakeToken.connect(alice).solverWithdrawShares(
        [await vault.getAddress()],
        [withdrawShares1],
        ethers.parseEther("150"),
        alice.address,
        alice.address
      );
      const afterBalance1 = await dStable.balanceOf(alice.address);
      currentTotalWithdrawn = currentTotalWithdrawn + (afterBalance1 - beforeBalance1);

      // Verify fees accumulated
      let fees = await dStable.balanceOf(await dStakeToken.getAddress());
      expect(fees).to.be.gt(0);

      // Round 3: Another deposit (with fees present)
      await dStakeToken.connect(bob).deposit(ethers.parseEther("800"), bob.address);
      currentTotalDeposited = currentTotalDeposited + ethers.parseEther("800");

      // Verify totalAssets includes fees
      const totalAssets = await dStakeToken.totalAssets();
      const vaultValue = await collateralVault.totalValueInDStable();
      fees = await dStable.balanceOf(await dStakeToken.getAddress());
      expect(totalAssets).to.equal(vaultValue + fees);

      // Round 4: Reinvest fees
      const pendingFees = await dStable.balanceOf(await dStakeToken.getAddress());
      const incentive = pendingFees * reinvestIncentiveBps / ONE_HUNDRED_PERCENT_BPS;
      totalIncentivesPaid = totalIncentivesPaid + incentive;
      await dStakeToken.reinvestFees();

      // Round 5: Final withdrawal
      const vaultBalance2 = await vault.balanceOf(await collateralVault.getAddress());
      const withdrawShares2 = vaultBalance2 / 15n;
      const beforeBalance2 = await dStable.balanceOf(bob.address);
      await dStakeToken.connect(bob).solverWithdrawShares(
        [await vault.getAddress()],
        [withdrawShares2],
        ethers.parseEther("100"),
        bob.address,
        bob.address
      );
      const afterBalance2 = await dStable.balanceOf(bob.address);
      currentTotalWithdrawn = currentTotalWithdrawn + (afterBalance2 - beforeBalance2);

      // Final check: value conservation
      const finalTotalAssets = await dStakeToken.totalAssets();
      const finalFees = await dStable.balanceOf(await dStakeToken.getAddress());
      const expectedFinalValue = startingTotalAssets + currentTotalDeposited - currentTotalWithdrawn - totalIncentivesPaid;

      // Including any remaining fees
      expect(finalTotalAssets).to.be.closeTo(expectedFinalValue, ethers.parseEther("1"));

      // Accounting should be consistent
      const finalVaultValue = await collateralVault.totalValueInDStable();
      expect(finalTotalAssets).to.equal(finalVaultValue + finalFees);
    });

    it("Should pay reinvestment incentive to caller", async function () {
      // Setup: Enable withdrawal fees and verify reinvest incentive
      const FEE_MANAGER_ROLE = await dStakeToken.FEE_MANAGER_ROLE();
      await dStakeToken.connect(owner).grantRole(FEE_MANAGER_ROLE, owner.address);
      await dStakeToken.connect(owner).setWithdrawalFee(10000); // 1% fee for larger accumulation

      // Verify initial incentive is 1% (10000 with 2 decimal precision)
      const initialIncentive = await dStakeToken.reinvestIncentiveBps();
      expect(initialIncentive).to.equal(10000);

      // User deposits
      const depositAmount = ethers.parseEther("10000");
      await dStable.connect(owner).mint(alice.address, depositAmount);
      await dStable.connect(alice).approve(await dStakeToken.getAddress(), depositAmount);
      await dStakeToken.connect(alice).deposit(depositAmount, alice.address);

      // Perform withdrawal to accumulate fees
      const shares = await dStakeToken.balanceOf(alice.address);
      const vaultShares = await vault.balanceOf(await collateralVault.getAddress());
      // Use a much smaller percentage to avoid exceeding available amount
      const sharesToWithdraw = (shares * 20n) / 100n; // Only 20% to be safe
      await dStakeToken.connect(alice).solverWithdrawShares(
        [await vault.getAddress()],
        [vaultShares / 10n], // Also reduce vault shares withdrawal
        sharesToWithdraw,
        alice.address,
        alice.address
      );

      // Check accumulated fees
      const accumulatedFees = await dStable.balanceOf(await dStakeToken.getAddress());
      expect(accumulatedFees).to.be.gt(0);

      // Calculate expected incentive (1% of accumulated fees)
      const expectedIncentive = accumulatedFees * reinvestIncentiveBps / ONE_HUNDRED_PERCENT_BPS;
      const expectedReinvested = accumulatedFees - expectedIncentive;

      // Track caller balance before reinvesting
      const callerBalanceBefore = await dStable.balanceOf(bob.address);

      // Bob calls reinvestFees and should receive incentive
      const tx = await dStakeToken.connect(bob).reinvestFees();
      await expect(tx)
        .to.emit(dStakeToken, "FeesReinvested")
        .withArgs(expectedReinvested, expectedIncentive, bob.address);

      // Verify Bob received the incentive
      const callerBalanceAfter = await dStable.balanceOf(bob.address);
      const receivedIncentive = callerBalanceAfter - callerBalanceBefore;

      // Allow small rounding difference
      expect(receivedIncentive).to.be.closeTo(expectedIncentive, 1);

      // Verify no fees remain in contract
      const remainingFees = await dStable.balanceOf(await dStakeToken.getAddress());
      expect(remainingFees).to.equal(0);
    });

    it("Should allow governance to configure reinvestment incentive", async function () {
      const FEE_MANAGER_ROLE = await dStakeToken.FEE_MANAGER_ROLE();
      await dStakeToken.connect(owner).grantRole(FEE_MANAGER_ROLE, owner.address);

      // Set incentive to 0.5% (5000 with 2 decimal precision)
      await expect(dStakeToken.connect(owner).setReinvestIncentive(5000))
        .to.emit(dStakeToken, "ReinvestIncentiveSet")
        .withArgs(5000);
      expect(await dStakeToken.reinvestIncentiveBps()).to.equal(5000);

      // Set incentive to 10% (100000 with 2 decimal precision)
      await expect(dStakeToken.connect(owner).setReinvestIncentive(100000))
        .to.emit(dStakeToken, "ReinvestIncentiveSet")
        .withArgs(100000);
      expect(await dStakeToken.reinvestIncentiveBps()).to.equal(100000);

      // Set incentive to maximum 20% (200000 with 2 decimal precision)
      await expect(dStakeToken.connect(owner).setReinvestIncentive(200000))
        .to.emit(dStakeToken, "ReinvestIncentiveSet")
        .withArgs(200000);
      expect(await dStakeToken.reinvestIncentiveBps()).to.equal(200000);

      // Try to exceed maximum 20% (should revert)
      await expect(
        dStakeToken.connect(owner).setReinvestIncentive(200001)
      ).to.be.revertedWithCustomError(dStakeToken, "InvalidIncentiveBps");

      // Set incentive to 0 (disable incentive)
      await expect(dStakeToken.connect(owner).setReinvestIncentive(0))
        .to.emit(dStakeToken, "ReinvestIncentiveSet")
        .withArgs(0);
      expect(await dStakeToken.reinvestIncentiveBps()).to.equal(0);
    });

    it("Should handle reinvestment with zero incentive", async function () {
      const FEE_MANAGER_ROLE = await dStakeToken.FEE_MANAGER_ROLE();
      await dStakeToken.connect(owner).grantRole(FEE_MANAGER_ROLE, owner.address);

      // Disable reinvest incentive
      await dStakeToken.connect(owner).setReinvestIncentive(0);
      await dStakeToken.connect(owner).setWithdrawalFee(10000); // 1% fee

      // User deposits and withdraws to generate fees
      const depositAmount = ethers.parseEther("1000");
      await dStable.connect(owner).mint(alice.address, depositAmount);
      await dStable.connect(alice).approve(await dStakeToken.getAddress(), depositAmount);
      await dStakeToken.connect(alice).deposit(depositAmount, alice.address);

      const shares = await dStakeToken.balanceOf(alice.address);
      const vaultShares = await vault.balanceOf(await collateralVault.getAddress());
      // Use a much smaller percentage to avoid exceeding available amount
      const sharesToWithdraw = (shares * 20n) / 100n; // Only 20% to be safe
      await dStakeToken.connect(alice).solverWithdrawShares(
        [await vault.getAddress()],
        [vaultShares / 10n], // Also reduce vault shares withdrawal
        sharesToWithdraw,
        alice.address,
        alice.address
      );

      // Check accumulated fees
      const accumulatedFees = await dStable.balanceOf(await dStakeToken.getAddress());
      expect(accumulatedFees).to.be.gt(0);

      // Track caller balance
      const callerBalanceBefore = await dStable.balanceOf(bob.address);

      // Bob calls reinvestFees but should receive no incentive
      await dStakeToken.connect(bob).reinvestFees();

      // Verify Bob received no incentive
      const callerBalanceAfter = await dStable.balanceOf(bob.address);
      expect(callerBalanceAfter).to.equal(callerBalanceBefore);

      // Verify all fees were reinvested
      const remainingFees = await dStable.balanceOf(await dStakeToken.getAddress());
      expect(remainingFees).to.equal(0);
    });
  });
});
