import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { WeightedRandomSelectorHarness } from "../../../typechain-types";

describe("WeightedRandomSelector Library", () => {
  let harness: WeightedRandomSelectorHarness;
  let deployer: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  // Mock addresses for testing
  const mockAddresses = [
    "0x1234567890123456789012345678901234567890",
    "0x2234567890123456789012345678901234567890",
    "0x3234567890123456789012345678901234567890",
    "0x4234567890123456789012345678901234567890",
    "0x5234567890123456789012345678901234567890",
  ];

  before(async () => {
    [deployer, user1, user2] = await ethers.getSigners();

    // Deploy the harness contract
    const harnessFactory = await ethers.getContractFactory("WeightedRandomSelectorHarness");
    harness = await harnessFactory.deploy();
    await harness.waitForDeployment();
  });

  describe("calculateDepositWeights", () => {
    it("Should calculate correct weights for underweight vaults", async () => {
      const currentAllocations = [2000, 3000, 1000]; // 20%, 30%, 10%
      const targetAllocations = [2500, 2500, 5000];  // 25%, 25%, 50%

      const weights = await harness.calculateDepositWeights(
        currentAllocations,
        targetAllocations
      );

      expect(weights).to.deep.equal([500n, 0n, 4000n]); // Only underweight vaults get weight
    });

    it("Should return zero weights when all vaults are overweight", async () => {
      const currentAllocations = [3000, 4000, 3000]; // All above target
      const targetAllocations = [2500, 2500, 2500];

      const weights = await harness.calculateDepositWeights(
        currentAllocations,
        targetAllocations
      );

      expect(weights).to.deep.equal([0n, 0n, 0n]);
    });

    it("Should handle edge case with zero current allocations", async () => {
      const currentAllocations = [0, 0, 0];
      const targetAllocations = [3000, 3000, 4000];

      const weights = await harness.calculateDepositWeights(
        currentAllocations,
        targetAllocations
      );

      expect(weights).to.deep.equal([3000n, 3000n, 4000n]);
    });

    it("Should handle single vault scenario", async () => {
      const currentAllocations = [5000];
      const targetAllocations = [10000];

      const weights = await harness.calculateDepositWeights(
        currentAllocations,
        targetAllocations
      );

      expect(weights).to.deep.equal([5000n]);
    });

    it("Should revert on array length mismatch", async () => {
      const currentAllocations = [2000, 3000];
      const targetAllocations = [2500, 2500, 5000];

      await expect(
        harness.calculateDepositWeights(currentAllocations, targetAllocations)
      ).to.be.revertedWithCustomError(harness, "ArrayLengthMismatch");
    });

    it("Should handle exact target allocations", async () => {
      const currentAllocations = [2500, 2500, 5000];
      const targetAllocations = [2500, 2500, 5000];

      const weights = await harness.calculateDepositWeights(
        currentAllocations,
        targetAllocations
      );

      expect(weights).to.deep.equal([0n, 0n, 0n]);
    });
  });

  describe("calculateWithdrawalWeights", () => {
    it("Should calculate correct weights for overweight vaults", async () => {
      const currentAllocations = [3000, 3000, 4000]; // 30%, 30%, 40%
      const targetAllocations = [2500, 2500, 5000];  // 25%, 25%, 50%

      const weights = await harness.calculateWithdrawalWeights(
        currentAllocations,
        targetAllocations
      );

      expect(weights).to.deep.equal([500n, 500n, 0n]); // Only overweight vaults get weight
    });

    it("Should return zero weights when all vaults are underweight", async () => {
      const currentAllocations = [2000, 2000, 2000];
      const targetAllocations = [2500, 2500, 5000];

      const weights = await harness.calculateWithdrawalWeights(
        currentAllocations,
        targetAllocations
      );

      expect(weights).to.deep.equal([0n, 0n, 0n]);
    });

    it("Should handle edge case with zero target allocations", async () => {
      const currentAllocations = [3000, 3000, 4000];
      const targetAllocations = [0, 0, 0];

      const weights = await harness.calculateWithdrawalWeights(
        currentAllocations,
        targetAllocations
      );

      expect(weights).to.deep.equal([3000n, 3000n, 4000n]);
    });

    it("Should revert on array length mismatch", async () => {
      const currentAllocations = [3000, 3000];
      const targetAllocations = [2500, 2500, 5000];

      await expect(
        harness.calculateWithdrawalWeights(currentAllocations, targetAllocations)
      ).to.be.revertedWithCustomError(harness, "ArrayLengthMismatch");
    });
  });

  describe("selectWeightedRandom", () => {

    it("Should select single item with weighted probability", async () => {
      const items = mockAddresses.slice(0, 3);
      const weights = [100, 200, 300]; // 100:200:300 ratio
      const randomSeed = 12345;

      const [selected, selectedIndex] = await harness.testSelectSingleWeightedRandom(
        items,
        weights,
        randomSeed
      );

      expect(items).to.include(selected);
      expect(selectedIndex).to.be.within(0, 2);
    });

    it("Should select multiple items without replacement", async () => {
      const items = mockAddresses.slice(0, 4);
      const weights = [100, 200, 300, 400];
      const count = 3;
      const randomSeed = 54321;

      const [selected, selectedIndices] = await harness.selectWeightedRandom(
        items,
        weights,
        count,
        randomSeed
      );

      expect(selected).to.have.lengthOf(3);
      expect(selectedIndices).to.have.lengthOf(3);
      
      // Should not have duplicates
      const uniqueSelected = new Set(selected);
      const uniqueIndices = new Set(selectedIndices.map(idx => idx.toString()));
      expect(uniqueSelected.size).to.equal(3);
      expect(uniqueIndices.size).to.equal(3);
    });

    it("Should handle zero weights by selecting randomly from remaining", async () => {
      const items = mockAddresses.slice(0, 3);
      const weights = [0, 0, 0];
      const count = 2;
      const randomSeed = 99999;

      const [selected, selectedIndices] = await harness.selectWeightedRandom(
        items,
        weights,
        count,
        randomSeed
      );

      expect(selected).to.have.lengthOf(2);
      expect(selectedIndices).to.have.lengthOf(2);
      // Should still select valid items
      for (const item of selected) {
        expect(items).to.include(item);
      }
    });

    it("Should handle single item selection", async () => {
      const items = [mockAddresses[0]];
      const weights = [100];
      const randomSeed = 1111;

      const [selected, selectedIndex] = await harness.testSelectSingleWeightedRandom(
        items,
        weights,
        randomSeed
      );

      expect(selected).to.equal(mockAddresses[0]);
      expect(selectedIndex).to.equal(0n);
    });

    it("Should return empty arrays when count is 0", async () => {
      const items = mockAddresses.slice(0, 3);
      const weights = [100, 200, 300];
      const count = 0;
      const randomSeed = 2222;

      const [selected, selectedIndices] = await harness.selectWeightedRandom(
        items,
        weights,
        count,
        randomSeed
      );

      expect(selected).to.have.lengthOf(0);
      expect(selectedIndices).to.have.lengthOf(0);
    });

    it("Should revert when requesting more items than available", async () => {
      const items = mockAddresses.slice(0, 2);
      const weights = [100, 200];
      const count = 3;
      const randomSeed = 3333;

      await expect(
        harness.selectWeightedRandom(items, weights, count, randomSeed)
      ).to.be.revertedWithCustomError(harness, "InsufficientItems");
    });

    it("Should revert when arrays have mismatched lengths", async () => {
      const items = mockAddresses.slice(0, 3);
      const weights = [100, 200];
      const count = 1;
      const randomSeed = 4444;

      await expect(
        harness.selectWeightedRandom(items, weights, count, randomSeed)
      ).to.be.revertedWithCustomError(harness, "ArrayLengthMismatch");
    });

    it("Should revert when no items available", async () => {
      const items: string[] = [];
      const weights: number[] = [];
      const count = 1;
      const randomSeed = 5555;

      await expect(
        harness.selectWeightedRandom(items, weights, count, randomSeed)
      ).to.be.revertedWithCustomError(harness, "NoItemsAvailable");
    });

    it("Should handle mixed zero and non-zero weights", async () => {
      const items = mockAddresses.slice(0, 4);
      const weights = [0, 100, 0, 200];
      const count = 2;
      const randomSeed = 6666;

      const [selected, selectedIndices] = await harness.selectWeightedRandom(
        items,
        weights,
        count,
        randomSeed
      );

      expect(selected).to.have.lengthOf(2);
      expect(selectedIndices).to.have.lengthOf(2);
    });
  });

  describe("Selection Distribution Tests", () => {
    it("Should respect weight distribution over multiple selections", async () => {
      const items = [mockAddresses[0], mockAddresses[1]];
      const weights = [100, 300]; // 1:3 ratio
      const numTests = 100;
      
      let firstSelected = 0;
      let secondSelected = 0;

      for (let i = 0; i < numTests; i++) {
        const [selected] = await harness.testSelectSingleWeightedRandom(
          items,
          weights,
          i * 1000 + 12345 // Different seed each time
        );

        if (selected === items[0]) {
          firstSelected++;
        } else if (selected === items[1]) {
          secondSelected++;
        }
      }

      // Due to deterministic hashing in tests, distribution might be very skewed
      // Just verify that the weighted selection is working (not 50/50)
      console.log(`Distribution: First: ${firstSelected}, Second: ${secondSelected}`);
      
      // With weights [100, 300], second should be selected more often
      // But due to deterministic nature, it might be extreme
      expect(secondSelected).to.be.gt(firstSelected); // Second should win more due to higher weight
    });
  });

  describe("calculateTotalWeight", () => {
    it("Should calculate total weight correctly", async () => {
      const weights = [100, 200, 300, 400];
      const totalWeight = await harness.calculateTotalWeight(weights);
      expect(totalWeight).to.equal(1000n);
    });

    it("Should handle zero weights", async () => {
      const weights = [0, 0, 0];
      const totalWeight = await harness.calculateTotalWeight(weights);
      expect(totalWeight).to.equal(0n);
    });

    it("Should handle empty array", async () => {
      const weights: number[] = [];
      const totalWeight = await harness.calculateTotalWeight(weights);
      expect(totalWeight).to.equal(0n);
    });

    it("Should handle single weight", async () => {
      const weights = [500];
      const totalWeight = await harness.calculateTotalWeight(weights);
      expect(totalWeight).to.equal(500n);
    });
  });

  describe("hasNonZeroWeights", () => {
    it("Should return true when weights contain non-zero values", async () => {
      const weights = [0, 0, 100, 0];
      const hasNonZero = await harness.hasNonZeroWeights(weights);
      expect(hasNonZero).to.be.true;
    });

    it("Should return false when all weights are zero", async () => {
      const weights = [0, 0, 0];
      const hasNonZero = await harness.hasNonZeroWeights(weights);
      expect(hasNonZero).to.be.false;
    });

    it("Should return false for empty array", async () => {
      const weights: number[] = [];
      const hasNonZero = await harness.hasNonZeroWeights(weights);
      expect(hasNonZero).to.be.false;
    });

    it("Should return true for single non-zero weight", async () => {
      const weights = [1];
      const hasNonZero = await harness.hasNonZeroWeights(weights);
      expect(hasNonZero).to.be.true;
    });
  });

  describe("generateRandomSeed", () => {
    it("Should generate different seeds for different senders", async () => {
      const nonce = 123;
      
      const seed1 = await harness.generateRandomSeed(user1.address, nonce);
      const seed2 = await harness.generateRandomSeed(user2.address, nonce);
      
      expect(seed1).to.not.equal(seed2);
    });

    it("Should generate different seeds for different nonces", async () => {
      const sender = user1.address;
      
      const seed1 = await harness.generateRandomSeed(sender, 123);
      const seed2 = await harness.generateRandomSeed(sender, 456);
      
      expect(seed1).to.not.equal(seed2);
    });

    it("Should generate consistent seeds for same inputs", async () => {
      const sender = user1.address;
      const nonce = 789;
      
      const seed1 = await harness.generateRandomSeed(sender, nonce);
      const seed2 = await harness.generateRandomSeed(sender, nonce);
      
      expect(seed1).to.equal(seed2);
    });
  });

  describe("Edge Cases and Gas Efficiency", () => {
    it("Should handle large weight arrays efficiently", async () => {
      const largeSize = 50;
      const items = Array(largeSize).fill(0).map((_, i) => 
        `0x${i.toString(16).padStart(40, '0')}`
      );
      const weights = Array(largeSize).fill(100);
      
      const tx = await harness.selectWeightedRandom(
        items,
        weights,
        10,
        999999
      );
      
      // Should complete without running out of gas
      expect(tx).to.not.be.undefined;
    });

    it("Should handle maximum basis points values", async () => {
      const currentAllocations = [10000]; // 100% allocation
      const targetAllocations = [5000];   // 50% target
      
      const weights = await harness.calculateWithdrawalWeights(
        currentAllocations,
        targetAllocations
      );
      
      expect(weights).to.deep.equal([5000n]);
    });

    it("Should handle very large weight values", async () => {
      const weights = [ethers.parseUnits("1", 18), ethers.parseUnits("2", 18)];
      const totalWeight = await harness.calculateTotalWeight(weights);
      
      expect(totalWeight).to.equal(ethers.parseUnits("3", 18));
    });
  });

  describe("Single Weight Selection Logic", () => {
    it("Should select correct index based on weight distribution", async () => {
      // Test the single weight selection logic
      const items = mockAddresses.slice(0, 3);
      const weights = [100, 200, 300];
      
      // Test with seed that should select first item (0-99)
      const [, index1] = await harness.testSelectSingleWeightedRandom(items, weights, 50);
      expect(index1).to.equal(0n);
      
      // Test with seed that should select second item (100-299)
      const [, index2] = await harness.testSelectSingleWeightedRandom(items, weights, 150);
      expect(index2).to.equal(1n);
      
      // Test with seed that should select third item (300-599)
      const [, index3] = await harness.testSelectSingleWeightedRandom(items, weights, 450);
      expect(index3).to.equal(2n);
    });

    it("Should handle zero weights in single selection", async () => {
      const items = mockAddresses.slice(0, 3);
      const weights = [0, 0, 0];
      const randomSeed = 12345;
      
      const [, index] = await harness.testSelectSingleWeightedRandom(items, weights, randomSeed);
      
      // Should return random index when all weights are zero
      expect(index).to.be.within(0, 2);
    });
  });
});