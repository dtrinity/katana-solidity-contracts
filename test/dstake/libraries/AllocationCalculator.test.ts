import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { AllocationCalculatorHarness } from "../../../typechain-types";

describe("AllocationCalculator Library", () => {
  let harness: AllocationCalculatorHarness;
  let deployer: SignerWithAddress;
  const BPS_BASE = 10000n;

  before(async () => {
    [deployer] = await ethers.getSigners();

    // Deploy the harness contract
    const harnessFactory = await ethers.getContractFactory("AllocationCalculatorHarness");
    harness = await harnessFactory.deploy();
    await harness.waitForDeployment();
  });

  describe("calculateCurrentAllocations", () => {
    it("Should calculate correct allocations for normal balances", async () => {
      const vaultBalances = [
        ethers.parseEther("25"), // 25%
        ethers.parseEther("35"), // 35%  
        ethers.parseEther("40"), // 40%
      ]; // Total: 100 ETH

      const [allocations, totalBalance] = await harness.calculateCurrentAllocations(vaultBalances);

      expect(totalBalance).to.equal(ethers.parseEther("100"));
      expect(allocations).to.deep.equal([2500n, 3500n, 4000n]); // In basis points
    });

    it("Should handle zero balances correctly", async () => {
      const vaultBalances = [0n, 0n, 0n];

      const [allocations, totalBalance] = await harness.calculateCurrentAllocations(vaultBalances);

      expect(totalBalance).to.equal(0n);
      expect(allocations).to.deep.equal([0n, 0n, 0n]);
    });

    it("Should handle single vault with balance", async () => {
      const vaultBalances = [ethers.parseEther("100")];

      const [allocations, totalBalance] = await harness.calculateCurrentAllocations(vaultBalances);

      expect(totalBalance).to.equal(ethers.parseEther("100"));
      expect(allocations).to.deep.equal([10000n]); // 100% in basis points
    });

    it("Should handle mixed zero and non-zero balances", async () => {
      const vaultBalances = [
        0n,
        ethers.parseEther("50"),
        0n,
        ethers.parseEther("50"),
      ];

      const [allocations, totalBalance] = await harness.calculateCurrentAllocations(vaultBalances);

      expect(totalBalance).to.equal(ethers.parseEther("100"));
      expect(allocations).to.deep.equal([0n, 5000n, 0n, 5000n]);
    });

    it("Should handle empty vault array", async () => {
      const vaultBalances: bigint[] = [];

      const [allocations, totalBalance] = await harness.calculateCurrentAllocations(vaultBalances);

      expect(totalBalance).to.equal(0n);
      expect(allocations).to.have.lengthOf(0);
    });

    it("Should handle very small balances with proper rounding", async () => {
      const vaultBalances = [1n, 2n, 7n]; // Total: 10

      const [allocations, totalBalance] = await harness.calculateCurrentAllocations(vaultBalances);

      expect(totalBalance).to.equal(10n);
      expect(allocations).to.deep.equal([1000n, 2000n, 7000n]); // 10%, 20%, 70%
    });
  });

  describe("calculateDeficitsAndSurpluses", () => {
    it("Should calculate deficits and surpluses correctly", async () => {
      const currentAllocations = [2000n, 4000n, 4000n]; // 20%, 40%, 40%
      const targetAllocations = [2500n, 2500n, 5000n];  // 25%, 25%, 50%

      const [deficits, surpluses, totalDeficit, totalSurplus] = 
        await harness.calculateDeficitsAndSurpluses(currentAllocations, targetAllocations);

      expect(deficits).to.deep.equal([500n, 0n, 1000n]); // Underweight amounts
      expect(surpluses).to.deep.equal([0n, 1500n, 0n]); // Overweight amounts
      expect(totalDeficit).to.equal(1500n);
      expect(totalSurplus).to.equal(1500n);
    });

    it("Should handle all vaults at target allocation", async () => {
      const currentAllocations = [2500n, 2500n, 5000n];
      const targetAllocations = [2500n, 2500n, 5000n];

      const [deficits, surpluses, totalDeficit, totalSurplus] = 
        await harness.calculateDeficitsAndSurpluses(currentAllocations, targetAllocations);

      expect(deficits).to.deep.equal([0n, 0n, 0n]);
      expect(surpluses).to.deep.equal([0n, 0n, 0n]);
      expect(totalDeficit).to.equal(0n);
      expect(totalSurplus).to.equal(0n);
    });

    it("Should handle all vaults underweight", async () => {
      const currentAllocations = [1000n, 1000n, 2000n]; // All below target
      const targetAllocations = [2500n, 2500n, 5000n];

      const [deficits, surpluses, totalDeficit, totalSurplus] = 
        await harness.calculateDeficitsAndSurpluses(currentAllocations, targetAllocations);

      expect(deficits).to.deep.equal([1500n, 1500n, 3000n]);
      expect(surpluses).to.deep.equal([0n, 0n, 0n]);
      expect(totalDeficit).to.equal(6000n);
      expect(totalSurplus).to.equal(0n);
    });

    it("Should handle all vaults overweight", async () => {
      const currentAllocations = [3000n, 3000n, 4000n]; // All above target
      const targetAllocations = [2500n, 2500n, 3000n];

      const [deficits, surpluses, totalDeficit, totalSurplus] = 
        await harness.calculateDeficitsAndSurpluses(currentAllocations, targetAllocations);

      expect(deficits).to.deep.equal([0n, 0n, 0n]);
      expect(surpluses).to.deep.equal([500n, 500n, 1000n]);
      expect(totalDeficit).to.equal(0n);
      expect(totalSurplus).to.equal(2000n);
    });

    it("Should revert on array length mismatch", async () => {
      const currentAllocations = [2000n, 4000n];
      const targetAllocations = [2500n, 2500n, 5000n];

      await expect(
        harness.calculateDeficitsAndSurpluses(currentAllocations, targetAllocations)
      ).to.be.revertedWithCustomError(harness, "ArrayLengthMismatch");
    });
  });

  describe("splitAmountEvenly", () => {
    it("Should split amount evenly with no remainder", async () => {
      const totalAmount = ethers.parseEther("100");
      const vaultCount = 4;

      const amounts = await harness.splitAmountEvenly(totalAmount, vaultCount);

      expect(amounts).to.deep.equal([
        ethers.parseEther("25"),
        ethers.parseEther("25"), 
        ethers.parseEther("25"),
        ethers.parseEther("25")
      ]);
    });

    it("Should distribute remainder to first vaults", async () => {
      const totalAmount = 103n;
      const vaultCount = 4;

      const amounts = await harness.splitAmountEvenly(totalAmount, vaultCount);

      expect(amounts).to.deep.equal([26n, 26n, 26n, 25n]); // First 3 get +1
      
      // Verify total is preserved
      const total = amounts.reduce((sum, amount) => sum + amount, 0n);
      expect(total).to.equal(totalAmount);
    });

    it("Should handle zero amount", async () => {
      const totalAmount = 0n;
      const vaultCount = 3;

      const amounts = await harness.splitAmountEvenly(totalAmount, vaultCount);

      expect(amounts).to.deep.equal([0n, 0n, 0n]);
    });

    it("Should handle single vault", async () => {
      const totalAmount = ethers.parseEther("50");
      const vaultCount = 1;

      const amounts = await harness.splitAmountEvenly(totalAmount, vaultCount);

      expect(amounts).to.deep.equal([ethers.parseEther("50")]);
    });

    it("Should revert when vault count is zero", async () => {
      const totalAmount = ethers.parseEther("100");
      const vaultCount = 0;

      await expect(
        harness.splitAmountEvenly(totalAmount, vaultCount)
      ).to.be.revertedWithCustomError(harness, "DivisionByZero");
    });
  });

  describe("splitAmountProportionally", () => {
    it("Should split amount proportionally", async () => {
      const totalAmount = 1000n;
      const weights = [100n, 200n, 300n]; // 1:2:3 ratio

      const [amounts, remainder] = await harness.splitAmountProportionally(totalAmount, weights);

      // Expected: 1000 * 100/600 = 166.67 → 166
      //          1000 * 200/600 = 333.33 → 333  
      //          1000 * 300/600 = 500
      expect(amounts).to.deep.equal([166n, 333n, 500n]);
      expect(remainder).to.equal(1n); // 1000 - 999 = 1
    });

    it("Should handle zero weights", async () => {
      const totalAmount = 1000n;
      const weights = [0n, 0n, 0n];

      const [amounts, remainder] = await harness.splitAmountProportionally(totalAmount, weights);

      expect(amounts).to.deep.equal([0n, 0n, 0n]);
      expect(remainder).to.equal(totalAmount); // Full amount as remainder
    });

    it("Should handle zero amount", async () => {
      const totalAmount = 0n;
      const weights = [100n, 200n, 300n];

      const [amounts, remainder] = await harness.splitAmountProportionally(totalAmount, weights);

      expect(amounts).to.deep.equal([0n, 0n, 0n]);
      expect(remainder).to.equal(0n);
    });

    it("Should handle empty weights array", async () => {
      const totalAmount = 1000n;
      const weights: bigint[] = [];

      const [amounts, remainder] = await harness.splitAmountProportionally(totalAmount, weights);

      expect(amounts).to.have.lengthOf(0);
      expect(remainder).to.equal(0n);
    });

    it("Should handle single weight", async () => {
      const totalAmount = 1000n;
      const weights = [500n];

      const [amounts, remainder] = await harness.splitAmountProportionally(totalAmount, weights);

      expect(amounts).to.deep.equal([1000n]);
      expect(remainder).to.equal(0n);
    });

    it("Should preserve total amount (amount + remainder)", async () => {
      const totalAmount = 999n;
      const weights = [1n, 2n, 3n];

      const [amounts, remainder] = await harness.splitAmountProportionally(totalAmount, weights);

      const distributedTotal = amounts.reduce((sum, amount) => sum + amount, 0n);
      expect(distributedTotal + remainder).to.equal(totalAmount);
    });
  });

  describe("distributeRemainder", () => {
    it("Should distribute remainder to vaults with highest weights", async () => {
      const amounts = [100n, 200n, 300n];
      const weights = [100n, 200n, 300n];
      const remainder = 3n;

      const adjustedAmounts = await harness.distributeRemainder(amounts, weights, remainder);

      // Should give +1 to highest weight vaults first (300, 200, 100)
      expect(adjustedAmounts).to.deep.equal([101n, 201n, 301n]);
    });

    it("Should handle zero remainder", async () => {
      const amounts = [100n, 200n, 300n];
      const weights = [100n, 200n, 300n];
      const remainder = 0n;

      const adjustedAmounts = await harness.distributeRemainder(amounts, weights, remainder);

      expect(adjustedAmounts).to.deep.equal(amounts); // No change
    });

    it("Should handle remainder larger than vault count", async () => {
      const amounts = [100n, 200n];
      const weights = [100n, 200n];
      const remainder = 5n;

      const adjustedAmounts = await harness.distributeRemainder(amounts, weights, remainder);

      // First round: +1 to vault with weight 200, +1 to vault with weight 100
      // Second round: +1 to vault with weight 200, +1 to vault with weight 100  
      // Fifth remainder: +1 to vault with weight 200
      expect(adjustedAmounts).to.deep.equal([102n, 203n]);
    });

    it("Should handle zero weights gracefully", async () => {
      const amounts = [100n, 200n, 300n];
      const weights = [0n, 0n, 0n];
      const remainder = 5n;

      const adjustedAmounts = await harness.distributeRemainder(amounts, weights, remainder);

      // Should return original amounts when all weights are zero
      expect(adjustedAmounts).to.deep.equal(amounts);
    });

    it("Should revert on array length mismatch", async () => {
      const amounts = [100n, 200n];
      const weights = [100n, 200n, 300n];
      const remainder = 3n;

      await expect(
        harness.distributeRemainder(amounts, weights, remainder)
      ).to.be.revertedWithCustomError(harness, "ArrayLengthMismatch");
    });
  });

  describe("calculateVaultAllocation", () => {
    it("Should calculate allocation as percentage", async () => {
      const vaultBalance = ethers.parseEther("25");
      const totalBalance = ethers.parseEther("100");
      const scaleFactor = 100n; // For percentage

      const allocation = await harness.calculateVaultAllocation(
        vaultBalance, totalBalance, scaleFactor
      );

      expect(allocation).to.equal(25n); // 25%
    });

    it("Should calculate allocation as basis points", async () => {
      const vaultBalance = ethers.parseEther("25");
      const totalBalance = ethers.parseEther("100");
      const scaleFactor = 10000n; // For basis points

      const allocation = await harness.calculateVaultAllocation(
        vaultBalance, totalBalance, scaleFactor
      );

      expect(allocation).to.equal(2500n); // 2500 basis points = 25%
    });

    it("Should handle zero total balance", async () => {
      const vaultBalance = ethers.parseEther("25");
      const totalBalance = 0n;
      const scaleFactor = 10000n;

      const allocation = await harness.calculateVaultAllocation(
        vaultBalance, totalBalance, scaleFactor
      );

      expect(allocation).to.equal(0n);
    });

    it("Should handle zero vault balance", async () => {
      const vaultBalance = 0n;
      const totalBalance = ethers.parseEther("100");
      const scaleFactor = 10000n;

      const allocation = await harness.calculateVaultAllocation(
        vaultBalance, totalBalance, scaleFactor
      );

      expect(allocation).to.equal(0n);
    });
  });

  describe("validateTargetAllocations", () => {
    it("Should validate correct target allocations", async () => {
      const targetAllocations = [2500n, 2500n, 5000n]; // Total: 10000

      const [isValid, totalBps] = await harness.validateTargetAllocations(targetAllocations);

      expect(isValid).to.be.true;
      expect(totalBps).to.equal(10000n);
    });

    it("Should invalidate allocations that don't sum to BPS_BASE", async () => {
      const targetAllocations = [2500n, 2500n, 4000n]; // Total: 9000

      const [isValid, totalBps] = await harness.validateTargetAllocations(targetAllocations);

      expect(isValid).to.be.false;
      expect(totalBps).to.equal(9000n);
    });

    it("Should handle empty allocations array", async () => {
      const targetAllocations: bigint[] = [];

      const [isValid, totalBps] = await harness.validateTargetAllocations(targetAllocations);

      expect(isValid).to.be.false; // 0 != 10000
      expect(totalBps).to.equal(0n);
    });

    it("Should revert on allocation exceeding BPS_BASE", async () => {
      const targetAllocations = [15000n]; // Exceeds 10000

      await expect(
        harness.validateTargetAllocations(targetAllocations)
      ).to.be.revertedWithCustomError(harness, "InvalidBasisPoints");
    });

    it("Should handle single vault with full allocation", async () => {
      const targetAllocations = [10000n];

      const [isValid, totalBps] = await harness.validateTargetAllocations(targetAllocations);

      expect(isValid).to.be.true;
      expect(totalBps).to.equal(10000n);
    });
  });

  describe("calculateOptimalWithdrawal", () => {
    it("Should calculate optimal withdrawal to maintain target allocations", async () => {
      // Setup: 100 ETH total, want to withdraw 20 ETH, keep 80 ETH
      const targetAmount = ethers.parseEther("20");
      const vaultBalances = [
        ethers.parseEther("40"), // 40 ETH
        ethers.parseEther("30"), // 30 ETH  
        ethers.parseEther("30"), // 30 ETH
      ];
      const targetAllocations = [2500n, 3750n, 3750n]; // 25%, 37.5%, 37.5% of remaining 80

      const [withdrawAmounts, feasible] = await harness.calculateOptimalWithdrawal(
        targetAmount, vaultBalances, targetAllocations
      );

      expect(feasible).to.be.true;

      // After withdrawal, remaining should be 80 ETH
      // Target remaining: 20 ETH (25%), 30 ETH (37.5%), 30 ETH (37.5%)
      // So withdraw: 20, 0, 0
      expect(withdrawAmounts).to.deep.equal([
        ethers.parseEther("20"),
        ethers.parseEther("0"),
        ethers.parseEther("0")
      ]);

      // Verify total withdrawal equals target
      const totalWithdraw = withdrawAmounts.reduce((sum, amount) => sum + amount, 0n);
      expect(totalWithdraw).to.equal(targetAmount);
    });

    it("Should handle insufficient balance", async () => {
      const targetAmount = ethers.parseEther("200"); // More than available
      const vaultBalances = [
        ethers.parseEther("40"),
        ethers.parseEther("30"),
        ethers.parseEther("30")
      ]; // Total: 100 ETH
      const targetAllocations = [3333n, 3333n, 3334n];

      const [withdrawAmounts, feasible] = await harness.calculateOptimalWithdrawal(
        targetAmount, vaultBalances, targetAllocations
      );

      expect(feasible).to.be.false;
    });

    it("Should handle zero withdrawal amount", async () => {
      const targetAmount = 0n;
      const vaultBalances = [
        ethers.parseEther("40"),
        ethers.parseEther("30"),
        ethers.parseEther("30")
      ];
      const targetAllocations = [3333n, 3333n, 3334n];

      const [withdrawAmounts, feasible] = await harness.calculateOptimalWithdrawal(
        targetAmount, vaultBalances, targetAllocations
      );

      expect(feasible).to.be.true;
      expect(withdrawAmounts).to.deep.equal([0n, 0n, 0n]);
    });

    it("Should adjust for rounding differences", async () => {
      const targetAmount = 99n;
      const vaultBalances = [50n, 30n, 20n]; // Total: 100
      const targetAllocations = [5000n, 3000n, 2000n]; // 50%, 30%, 20%

      const [withdrawAmounts, feasible] = await harness.calculateOptimalWithdrawal(
        targetAmount, vaultBalances, targetAllocations
      );

      expect(feasible).to.be.true;
      
      // Verify total withdrawal equals target
      const totalWithdraw = withdrawAmounts.reduce((sum, amount) => sum + amount, 0n);
      expect(totalWithdraw).to.equal(targetAmount);
    });

    it("Should revert on array length mismatch", async () => {
      const targetAmount = ethers.parseEther("20");
      const vaultBalances = [ethers.parseEther("40"), ethers.parseEther("30")];
      const targetAllocations = [3333n, 3333n, 3334n];

      await expect(
        harness.calculateOptimalWithdrawal(targetAmount, vaultBalances, targetAllocations)
      ).to.be.revertedWithCustomError(harness, "ArrayLengthMismatch");
    });

    it("Should handle edge case where vault is already below target", async () => {
      const targetAmount = ethers.parseEther("10");
      const vaultBalances = [
        ethers.parseEther("10"), // Will become 0 after some withdrawal
        ethers.parseEther("50"),
        ethers.parseEther("40")
      ]; // Total: 100, remaining after withdrawal: 90
      const targetAllocations = [2222n, 3889n, 3889n]; // 20%, 35%, 35% of remaining

      const [withdrawAmounts, feasible] = await harness.calculateOptimalWithdrawal(
        targetAmount, vaultBalances, targetAllocations
      );

      expect(feasible).to.be.true;
      
      // First vault should not be withdrawn from as it's already below target
      expect(withdrawAmounts[0]).to.equal(0n);
    });
  });

  describe("Edge Cases and Mathematical Properties", () => {
    it("Should handle maximum uint256 values", async () => {
      const maxUint = ethers.MaxUint256;
      const vaultBalances = [maxUint / 2n, maxUint / 2n];

      const [allocations, totalBalance] = await harness.calculateCurrentAllocations(vaultBalances);

      expect(totalBalance).to.equal(maxUint);
      expect(allocations).to.deep.equal([5000n, 5000n]); // 50% each
    });

    it("Should maintain precision with large numbers", async () => {
      const largeAmount = ethers.parseUnits("1000000", 18); // 1M tokens
      const weights = [1n, 2n, 3n];

      const [amounts, remainder] = await harness.splitAmountProportionally(largeAmount, weights);

      // Verify precision is maintained
      const distributedTotal = amounts.reduce((sum, amount) => sum + amount, 0n);
      expect(distributedTotal + remainder).to.equal(largeAmount);
    });

    it("Should handle basis points edge cases", async () => {
      // Test allocations that sum to exactly BPS_BASE with many small values
      const targetAllocations = Array(1000).fill(10n); // 1000 vaults with 10 bps each

      const [isValid, totalBps] = await harness.validateTargetAllocations(targetAllocations);

      expect(isValid).to.be.true;
      expect(totalBps).to.equal(10000n);
    });

    it("Should preserve mathematical invariants in splits", async () => {
      // Test that even splits always sum to original amount
      const amounts = [1n, 7n, 13n, 23n, 97n]; // Various prime numbers
      
      for (const amount of amounts) {
        for (let vaults = 1; vaults <= 10; vaults++) {
          const splits = await harness.splitAmountEvenly(amount, vaults);
          const total = splits.reduce((sum, split) => sum + split, 0n);
          expect(total).to.equal(amount, `Failed for amount ${amount} with ${vaults} vaults`);
        }
      }
    });
  });