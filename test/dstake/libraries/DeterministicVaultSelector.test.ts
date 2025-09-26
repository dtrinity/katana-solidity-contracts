import { expect } from "chai";
import { ethers, deployments, getNamedAccounts } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { DeterministicVaultSelectorHarness } from "../../../typechain-types";

describe("DeterministicVaultSelector Library Tests", function () {
  let harness: DeterministicVaultSelectorHarness;
  let deployer: SignerWithAddress;

  // Test data constants
  const vault1 = "0x1000000000000000000000000000000000000001";
  const vault2 = "0x2000000000000000000000000000000000000002";
  const vault3 = "0x3000000000000000000000000000000000000003";
  const vault4 = "0x4000000000000000000000000000000000000004";

  beforeEach(async function () {
    [deployer] = await ethers.getSigners();

    // Deploy the test harness contract
    const DeterministicVaultSelectorHarnessFactory = await ethers.getContractFactory("DeterministicVaultSelectorHarness");
    harness = await DeterministicVaultSelectorHarnessFactory.deploy();
    await harness.waitForDeployment();
  });

  describe("calculateUnderallocations", function () {
    it("Should calculate underallocations correctly when all vaults are underweight", async function () {
      const currentBps = [200000, 100000, 150000]; // 20%, 10%, 15% (total 45%)
      const targetBps = [500000, 300000, 200000]; // 50%, 30%, 20% (total 100%)

      const underallocations = await harness.calculateUnderallocations(currentBps, targetBps);

      expect(underallocations[0]).to.equal(300000); // 50% - 20% = 30%
      expect(underallocations[1]).to.equal(200000); // 30% - 10% = 20%
      expect(underallocations[2]).to.equal(50000); // 20% - 15% = 5%
    });

    it("Should return zero for overweight vaults", async function () {
      const currentBps = [600000, 200000, 150000]; // 60%, 20%, 15%
      const targetBps = [500000, 300000, 200000]; // 50%, 30%, 20%

      const underallocations = await harness.calculateUnderallocations(currentBps, targetBps);

      expect(underallocations[0]).to.equal(0); // Overweight: 60% > 50%
      expect(underallocations[1]).to.equal(100000); // Underweight: 30% - 20% = 10%
      expect(underallocations[2]).to.equal(50000); // Underweight: 20% - 15% = 5%
    });

    it("Should return all zeros when all vaults are at target", async function () {
      const currentBps = [500000, 300000, 200000];
      const targetBps = [500000, 300000, 200000];

      const underallocations = await harness.calculateUnderallocations(currentBps, targetBps);

      expect(underallocations[0]).to.equal(0);
      expect(underallocations[1]).to.equal(0);
      expect(underallocations[2]).to.equal(0);
    });

    it("Should revert with mismatched array lengths", async function () {
      const currentBps = [500000, 300000]; // 2 elements
      const targetBps = [500000, 300000, 200000]; // 3 elements

      await expect(harness.calculateUnderallocations(currentBps, targetBps)).to.be.revertedWithCustomError(harness, "ArrayLengthMismatch");
    });
  });

  describe("calculateOverallocations", function () {
    it("Should calculate overallocations correctly when all vaults are overweight", async function () {
      const currentBps = [600000, 400000, 300000]; // 60%, 40%, 30% (total 130%)
      const targetBps = [500000, 300000, 200000]; // 50%, 30%, 20% (total 100%)

      const overallocations = await harness.calculateOverallocations(currentBps, targetBps);

      expect(overallocations[0]).to.equal(100000); // 60% - 50% = 10%
      expect(overallocations[1]).to.equal(100000); // 40% - 30% = 10%
      expect(overallocations[2]).to.equal(100000); // 30% - 20% = 10%
    });

    it("Should return zero for underweight vaults", async function () {
      const currentBps = [400000, 200000, 250000]; // 40%, 20%, 25%
      const targetBps = [500000, 300000, 200000]; // 50%, 30%, 20%

      const overallocations = await harness.calculateOverallocations(currentBps, targetBps);

      expect(overallocations[0]).to.equal(0); // Underweight: 40% < 50%
      expect(overallocations[1]).to.equal(0); // Underweight: 20% < 30%
      expect(overallocations[2]).to.equal(50000); // Overweight: 25% - 20% = 5%
    });

    it("Should return all zeros when all vaults are at target", async function () {
      const currentBps = [500000, 300000, 200000];
      const targetBps = [500000, 300000, 200000];

      const overallocations = await harness.calculateOverallocations(currentBps, targetBps);

      expect(overallocations[0]).to.equal(0);
      expect(overallocations[1]).to.equal(0);
      expect(overallocations[2]).to.equal(0);
    });

    it("Should revert with mismatched array lengths", async function () {
      const currentBps = [500000, 300000]; // 2 elements
      const targetBps = [500000, 300000, 200000]; // 3 elements

      await expect(harness.calculateOverallocations(currentBps, targetBps)).to.be.revertedWithCustomError(harness, "ArrayLengthMismatch");
    });
  });

  describe("selectTopUnderallocated", function () {
    it("Should select vault with highest underallocation for deposits", async function () {
      const vaults = [vault1, vault2, vault3];
      const currentBps = [200000, 100000, 150000]; // 20%, 10%, 15%
      const targetBps = [500000, 300000, 200000]; // 50%, 30%, 20%
      const count = 1;

      // Expected underallocations: [30%, 20%, 5%] - vault1 has highest
      const [selectedVaults, selectedIndices] = await harness.selectTopUnderallocated(vaults, currentBps, targetBps, count);

      expect(selectedVaults).to.have.lengthOf(1);
      expect(selectedVaults[0]).to.equal(vault1);
      expect(selectedIndices[0]).to.equal(0);
    });

    it("Should select top 2 vaults with highest underallocations", async function () {
      const vaults = [vault1, vault2, vault3];
      const currentBps = [200000, 100000, 150000]; // 20%, 10%, 15%
      const targetBps = [500000, 300000, 200000]; // 50%, 30%, 20%
      const count = 2;

      // Expected underallocations: [30%, 20%, 5%] - should select vault1 and vault2
      const [selectedVaults, selectedIndices] = await harness.selectTopUnderallocated(vaults, currentBps, targetBps, count);

      expect(selectedVaults).to.have.lengthOf(2);
      expect(selectedVaults[0]).to.equal(vault1); // Highest underallocation (30%)
      expect(selectedVaults[1]).to.equal(vault2); // Second highest (20%)
      expect(selectedIndices[0]).to.equal(0);
      expect(selectedIndices[1]).to.equal(1);
    });

    it("Should handle tie-breaking by original index (stable sort)", async function () {
      const vaults = [vault1, vault2, vault3, vault4];
      const currentBps = [200000, 300000, 100000, 300000]; // 20%, 30%, 10%, 30%
      const targetBps = [500000, 500000, 300000, 500000]; // 50%, 50%, 30%, 50%
      const count = 2;

      // Underallocations: [30%, 20%, 20%, 20%] - vault1 highest, then tie between vault2 and vault4
      // Should select vault1 (30%) and vault2 (20%, earlier index than vault4)
      const [selectedVaults, selectedIndices] = await harness.selectTopUnderallocated(vaults, currentBps, targetBps, count);

      expect(selectedVaults).to.have.lengthOf(2);
      expect(selectedVaults[0]).to.equal(vault1); // Highest underallocation
      expect(selectedVaults[1]).to.equal(vault2); // Earlier index in tie
      expect(selectedIndices[0]).to.equal(0);
      expect(selectedIndices[1]).to.equal(1);
    });

    it("Should deterministically select first vaults when no underallocations exist", async function () {
      const vaults = [vault1, vault2, vault3];
      const currentBps = [500000, 300000, 200000]; // At target
      const targetBps = [500000, 300000, 200000];
      const count = 2;

      const [selectedVaults, selectedIndices] = await harness.selectTopUnderallocated(vaults, currentBps, targetBps, count);

      expect(selectedVaults).to.have.lengthOf(2);
      expect(selectedVaults[0]).to.equal(vault1); // First vault
      expect(selectedVaults[1]).to.equal(vault2); // Second vault
      expect(selectedIndices[0]).to.equal(0);
      expect(selectedIndices[1]).to.equal(1);
    });

    it("Should revert with mismatched array lengths", async function () {
      const vaults = [vault1, vault2];
      const currentBps = [500000, 300000, 200000]; // Different length
      const targetBps = [500000, 300000];

      await expect(harness.selectTopUnderallocated(vaults, currentBps, targetBps, 1)).to.be.revertedWithCustomError(
        harness,
        "ArrayLengthMismatch"
      );
    });

    it("Should revert when requesting more vaults than available", async function () {
      const vaults = [vault1, vault2];
      const currentBps = [500000, 300000];
      const targetBps = [500000, 300000];

      await expect(harness.selectTopUnderallocated(vaults, currentBps, targetBps, 3)).to.be.revertedWithCustomError(
        harness,
        "InsufficientItems"
      );
    });

    it("Should revert with zero count", async function () {
      const vaults = [vault1, vault2];
      const currentBps = [500000, 300000];
      const targetBps = [500000, 300000];

      await expect(harness.selectTopUnderallocated(vaults, currentBps, targetBps, 0)).to.be.revertedWithCustomError(
        harness,
        "InvalidSelectionCount"
      );
    });

    it("Should revert with empty vault array", async function () {
      const vaults: string[] = [];
      const currentBps: number[] = [];
      const targetBps: number[] = [];

      await expect(harness.selectTopUnderallocated(vaults, currentBps, targetBps, 1)).to.be.revertedWithCustomError(
        harness,
        "NoItemsAvailable"
      );
    });
  });

  describe("selectTopOverallocated", function () {
    it("Should select vault with highest overallocation for withdrawals", async function () {
      const vaults = [vault1, vault2, vault3];
      const currentBps = [600000, 400000, 250000]; // 60%, 40%, 25%
      const targetBps = [500000, 300000, 200000]; // 50%, 30%, 20%
      const count = 1;

      // Expected overallocations: [10%, 10%, 5%] - tie between vault1 and vault2, should pick vault1 (earlier index)
      const [selectedVaults, selectedIndices] = await harness.selectTopOverallocated(vaults, currentBps, targetBps, count);

      expect(selectedVaults).to.have.lengthOf(1);
      expect(selectedVaults[0]).to.equal(vault1); // Earlier index in tie
      expect(selectedIndices[0]).to.equal(0);
    });

    it("Should select top 2 vaults with highest overallocations", async function () {
      const vaults = [vault1, vault2, vault3];
      const currentBps = [700000, 400000, 250000]; // 70%, 40%, 25%
      const targetBps = [500000, 300000, 200000]; // 50%, 30%, 20%
      const count = 2;

      // Expected overallocations: [20%, 10%, 5%] - should select vault1 and vault2
      const [selectedVaults, selectedIndices] = await harness.selectTopOverallocated(vaults, currentBps, targetBps, count);

      expect(selectedVaults).to.have.lengthOf(2);
      expect(selectedVaults[0]).to.equal(vault1); // Highest overallocation (20%)
      expect(selectedVaults[1]).to.equal(vault2); // Second highest (10%)
      expect(selectedIndices[0]).to.equal(0);
      expect(selectedIndices[1]).to.equal(1);
    });

    it("Should deterministically select first vaults when no overallocations exist", async function () {
      const vaults = [vault1, vault2, vault3];
      const currentBps = [500000, 300000, 200000]; // At target
      const targetBps = [500000, 300000, 200000];
      const count = 2;

      const [selectedVaults, selectedIndices] = await harness.selectTopOverallocated(vaults, currentBps, targetBps, count);

      expect(selectedVaults).to.have.lengthOf(2);
      expect(selectedVaults[0]).to.equal(vault1); // First vault
      expect(selectedVaults[1]).to.equal(vault2); // Second vault
      expect(selectedIndices[0]).to.equal(0);
      expect(selectedIndices[1]).to.equal(1);
    });

    it("Should handle single vault selection", async function () {
      const vaults = [vault1];
      const currentBps = [600000]; // 60%
      const targetBps = [500000]; // 50%
      const count = 1;

      const [selectedVaults, selectedIndices] = await harness.selectTopOverallocated(vaults, currentBps, targetBps, count);

      expect(selectedVaults).to.have.lengthOf(1);
      expect(selectedVaults[0]).to.equal(vault1);
      expect(selectedIndices[0]).to.equal(0);
    });
  });

  // Utility functions removed in refactor

  describe("Edge Cases", function () {
    it("Should handle maximum values without overflow", async function () {
      const maxUint = ethers.MaxUint256;
      const vaults = [vault1];
      const currentBps = [0];
      const targetBps = [maxUint];

      const [selectedVaults] = await harness.selectTopUnderallocated(vaults, currentBps, targetBps, 1);
      expect(selectedVaults[0]).to.equal(vault1);
    });

    it("Should handle all vaults with same underallocation (complete tie)", async function () {
      const vaults = [vault1, vault2, vault3, vault4];
      const currentBps = [100000, 100000, 100000, 100000]; // All 10%
      const targetBps = [300000, 300000, 300000, 300000]; // All 30%
      const count = 2;

      // All have same 20% underallocation - should pick first 2 by index
      const [selectedVaults, selectedIndices] = await harness.selectTopUnderallocated(vaults, currentBps, targetBps, count);

      expect(selectedVaults).to.have.lengthOf(2);
      expect(selectedVaults[0]).to.equal(vault1); // Index 0 wins tie
      expect(selectedVaults[1]).to.equal(vault2); // Index 1 wins tie
      expect(selectedIndices[0]).to.equal(0);
      expect(selectedIndices[1]).to.equal(1);
    });

    it("Should be deterministic across multiple calls with same inputs", async function () {
      const vaults = [vault1, vault2, vault3];
      const currentBps = [200000, 100000, 150000];
      const targetBps = [500000, 300000, 200000];
      const count = 2;

      // Call multiple times and verify same results
      const results: Array<{ vaults: string[]; indices: bigint[] }> = [];

      for (let i = 0; i < 5; i++) {
        const [selectedVaults, selectedIndices] = await harness.selectTopUnderallocated(vaults, currentBps, targetBps, count);
        results.push({ vaults: selectedVaults, indices: selectedIndices });
      }

      // All results should be identical
      for (let i = 1; i < results.length; i++) {
        expect(results[i].vaults).to.deep.equal(results[0].vaults);
        expect(results[i].indices).to.deep.equal(results[0].indices);
      }
    });
  });

  describe("Gas Efficiency Tests", function () {
    it("Should have reasonable gas consumption for selectTopUnderallocated", async function () {
      const vaults = [vault1, vault2, vault3, vault4];
      const currentBps = [200000, 100000, 150000, 300000];
      const targetBps = [500000, 300000, 200000, 100000];
      const count = 2;

      const tx = await harness.selectTopUnderallocated.populateTransaction(vaults, currentBps, targetBps, count);

      const gasEstimate = await deployer.estimateGas(tx);

      // Gas should be reasonable (less than 100k for 4 vaults)
      expect(gasEstimate).to.be.lt(100000n);
    });

    it("Should scale linearly with vault count", async function () {
      // Test with 3 vaults
      const vaults3 = [vault1, vault2, vault3];
      const currentBps3 = [200000, 100000, 150000];
      const targetBps3 = [500000, 300000, 200000];

      const tx3 = await harness.selectTopUnderallocated.populateTransaction(vaults3, currentBps3, targetBps3, 1);
      const gas3 = await deployer.estimateGas(tx3);

      // Test with 4 vaults
      const vaults4 = [vault1, vault2, vault3, vault4];
      const currentBps4 = [200000, 100000, 150000, 300000];
      const targetBps4 = [500000, 300000, 200000, 100000];

      const tx4 = await harness.selectTopUnderallocated.populateTransaction(vaults4, currentBps4, targetBps4, 1);
      const gas4 = await deployer.estimateGas(tx4);


      // Gas increase should be reasonable (not exponential)
      const gasIncrease = gas4 - gas3;
      expect(gasIncrease).to.be.lt(gas3 / 2n); // Increase should be less than 50% of base
    });
  });
});
