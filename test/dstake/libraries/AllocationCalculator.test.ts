import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import { AllocationCalculatorHarness } from "../../../typechain-types";

describe("AllocationCalculator Library", () => {
  let harness: AllocationCalculatorHarness;
  let deployer: SignerWithAddress;
  const BPS_BASE = 1000000n;

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
      expect(allocations).to.deep.equal([250000n, 350000n, 400000n]); // In basis points
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
      expect(allocations).to.deep.equal([1000000n]); // 100% in basis points
    });

    it("Should handle mixed zero and non-zero balances", async () => {
      const vaultBalances = [0n, ethers.parseEther("50"), 0n, ethers.parseEther("50")];

      const [allocations, totalBalance] = await harness.calculateCurrentAllocations(vaultBalances);

      expect(totalBalance).to.equal(ethers.parseEther("100"));
      expect(allocations).to.deep.equal([0n, 500000n, 0n, 500000n]);
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
      expect(allocations).to.deep.equal([100000n, 200000n, 700000n]); // 10%, 20%, 70%
    });
  });

  // Removed tests for helpers no longer present in the library after refactor

  describe("Edge Cases and Mathematical Properties", () => {
    it("Should handle very large values", async () => {
      const largeValue = ethers.parseUnits("1000000000", 18);
      const vaultBalances = [largeValue / 2n, largeValue / 2n];
      const [allocations, totalBalance] = await harness.calculateCurrentAllocations(vaultBalances);
      expect(totalBalance).to.equal(largeValue);
      expect(allocations).to.deep.equal([500000n, 500000n]);
    });
  });
});
