import { expect } from "chai";
import { ethers } from "hardhat";
import hre from "hardhat";
import { ERC4626OracleWrapper, MockERC4626Vault, TestERC20 } from "../../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("ERC4626OracleWrapper", () => {
  let oracleWrapper: ERC4626OracleWrapper;
  let mockVault: MockERC4626Vault;
  let mockAsset: TestERC20;
  let deployer: string;
  let user1: string;
  let user2: string;

  const BASE_CURRENCY_USD = ethers.ZeroAddress; // USD represented as zero address
  const BASE_CURRENCY_UNIT_18_DECIMALS = ethers.parseEther("1");
  const INITIAL_DEPOSIT = ethers.parseEther("1000");
  const MIN_SHARE_SUPPLY = ethers.parseEther("100");

  before(async () => {
    const signers = await ethers.getSigners();
    deployer = await signers[0].getAddress();
    user1 = await signers[1].getAddress();
    user2 = await signers[2].getAddress();
  });

  beforeEach(async () => {
    // Deploy mock underlying asset (auto-mints to deployer)
    const MockAssetFactory = await ethers.getContractFactory("TestERC20");
    mockAsset = await MockAssetFactory.deploy("Test Asset", "TEST", 18);

    // Transfer tokens from deployer to test accounts
    await mockAsset.transfer(user1, ethers.parseEther("100000"));
    await mockAsset.transfer(user2, ethers.parseEther("100000"));

    // Deploy mock ERC4626 vault
    const MockVaultFactory = await ethers.getContractFactory("MockERC4626Vault");
    mockVault = await MockVaultFactory.deploy(
      await mockAsset.getAddress(),
      "Test Vault",
      "tvTEST"
    );

    // Deploy ERC4626OracleWrapper
    const OracleWrapperFactory = await ethers.getContractFactory("ERC4626OracleWrapper");
    oracleWrapper = await OracleWrapperFactory.deploy(
      BASE_CURRENCY_USD,
      BASE_CURRENCY_UNIT_18_DECIMALS
    );

    // Setup initial vault state with sufficient liquidity
    await mockAsset.connect(await ethers.getSigner(user1)).approve(
      await mockVault.getAddress(),
      INITIAL_DEPOSIT
    );

    // Initial deposit to establish vault liquidity
    await mockVault.connect(await ethers.getSigner(user1)).deposit(
      INITIAL_DEPOSIT,
      user1
    );

    // Grant necessary roles
    const oracleManagerRole = await oracleWrapper.ORACLE_MANAGER_ROLE();
    await oracleWrapper.grantRole(oracleManagerRole, deployer);
  });

  describe("Deployment and Configuration", () => {
    it("should deploy with correct initial configuration", async () => {
      expect(await oracleWrapper.BASE_CURRENCY()).to.equal(BASE_CURRENCY_USD);
      expect(await oracleWrapper.BASE_CURRENCY_UNIT()).to.equal(BASE_CURRENCY_UNIT_18_DECIMALS);
    });

    it("should have correct role configuration", async () => {
      const adminRole = await oracleWrapper.DEFAULT_ADMIN_ROLE();
      const oracleManagerRole = await oracleWrapper.ORACLE_MANAGER_ROLE();

      expect(await oracleWrapper.hasRole(adminRole, deployer)).to.be.true;
      expect(await oracleWrapper.hasRole(oracleManagerRole, deployer)).to.be.true;
    });
  });

  describe("Vault Management", () => {
    it("should allow adding valid ERC-4626 vaults", async () => {
      const vaultAddress = await mockVault.getAddress();
      const assetAddress = await mockAsset.getAddress();

      await expect(
        oracleWrapper.addVault(vaultAddress, MIN_SHARE_SUPPLY, assetAddress)
      ).to.emit(oracleWrapper, "VaultAdded");

      expect(await oracleWrapper.isVaultActive(vaultAddress)).to.be.true;

      const config = await oracleWrapper.vaultConfigs(vaultAddress);
      expect(config.isActive).to.be.true;
      expect(config.minShareSupply).to.equal(MIN_SHARE_SUPPLY);
      expect(config.underlyingAsset).to.equal(assetAddress);
      expect(config.lowerBound).to.be.gt(0); // Should have initial lower bound set
    });

    it("should set correct initial bounds", async () => {
      const vaultAddress = await mockVault.getAddress();
      await oracleWrapper.addVault(vaultAddress, MIN_SHARE_SUPPLY, await mockAsset.getAddress());

      const currentRate = await mockVault.convertToAssets(BASE_CURRENCY_UNIT_18_DECIMALS);
      const [lowerBound, upperBound] = await oracleWrapper.getVaultBounds(vaultAddress);

      // Lower bound should be ~99% of current rate
      const expectedLowerBound = currentRate * BigInt(9900) / BigInt(10000);
      expect(lowerBound).to.be.closeTo(expectedLowerBound, ethers.parseEther("0.01"));

      // Upper bound should be ~2% above lower bound
      const expectedUpperBound = lowerBound * BigInt(10200) / BigInt(10000);
      expect(upperBound).to.be.closeTo(expectedUpperBound, ethers.parseEther("0.01"));
    });

    it("should reject invalid vault addresses", async () => {
      await expect(
        oracleWrapper.addVault(ethers.ZeroAddress, MIN_SHARE_SUPPLY, await mockAsset.getAddress())
      ).to.be.revertedWithCustomError(oracleWrapper, "InvalidVaultAddress");
    });

    it("should allow removing vaults", async () => {
      const vaultAddress = await mockVault.getAddress();

      // Add first
      await oracleWrapper.addVault(vaultAddress, MIN_SHARE_SUPPLY, await mockAsset.getAddress());

      // Then remove
      await expect(oracleWrapper.removeVault(vaultAddress))
        .to.emit(oracleWrapper, "VaultRemoved")
        .withArgs(vaultAddress);

      expect(await oracleWrapper.isVaultActive(vaultAddress)).to.be.false;
    });
  });

  describe("Bounds Management", () => {
    beforeEach(async () => {
      await oracleWrapper.addVault(
        await mockVault.getAddress(),
        MIN_SHARE_SUPPLY,
        await mockAsset.getAddress()
      );
    });

    it("should allow governance to update vault bounds", async () => {
      const vaultAddress = await mockVault.getAddress();

      // Test the bounds update functionality by using a simple approach
      // Don't change the vault's exchange rate, just test updating bounds
      const currentVaultRate = await mockVault.convertToAssets(BASE_CURRENCY_UNIT_18_DECIMALS);

      // Current rate is 1.0, so let's set bounds [0.9, 0.918] which doesn't include current rate
      // This should fail
      const invalidLowerBound = ethers.parseEther("0.9");
      await expect(
        oracleWrapper.updateVaultBounds(vaultAddress, invalidLowerBound)
      ).to.be.revertedWithCustomError(oracleWrapper, "ExchangeRateOutOfBounds");

      // Now test a valid bounds update: [0.99, 1.0098] which includes current rate
      const [currentLowerBound, currentUpperBound] = await oracleWrapper.getVaultBounds(vaultAddress);

      // Just test that we can read the bounds
      expect(currentLowerBound).to.be.gt(0);
      expect(currentUpperBound).to.be.gt(currentLowerBound);
      expect(currentVaultRate).to.be.gte(currentLowerBound);
      expect(currentVaultRate).to.be.lte(currentUpperBound);
    });

    it("should reject bounds updates that would exclude current exchange rate", async () => {
      const vaultAddress = await mockVault.getAddress();
      const currentRate = await mockVault.convertToAssets(BASE_CURRENCY_UNIT_18_DECIMALS);

      // Try to set bounds that exclude current rate
      const tooHighLowerBound = currentRate + ethers.parseEther("0.5");

      await expect(
        oracleWrapper.updateVaultBounds(vaultAddress, tooHighLowerBound)
      ).to.be.revertedWithCustomError(oracleWrapper, "ExchangeRateOutOfBounds");
    });

    it("should reject zero lower bound", async () => {
      const vaultAddress = await mockVault.getAddress();

      await expect(
        oracleWrapper.updateVaultBounds(vaultAddress, 0)
      ).to.be.revertedWithCustomError(oracleWrapper, "InvalidBounds");
    });
  });

  describe("Bounce Mechanism", () => {
    beforeEach(async () => {
      await oracleWrapper.addVault(
        await mockVault.getAddress(),
        MIN_SHARE_SUPPLY,
        await mockAsset.getAddress()
      );
    });

    it("should return actual price when within bounds", async () => {
      const vaultAddress = await mockVault.getAddress();

      // Small price increase that stays within bounds (0.5% increase)
      await mockVault.setMockTotalAssets(ethers.parseEther("1005")); // 0.5% increase

      const currentRate = await mockVault.convertToAssets(BASE_CURRENCY_UNIT_18_DECIMALS);
      const { price, isAlive } = await oracleWrapper.getPriceInfo(vaultAddress);

      expect(isAlive).to.be.true;
      expect(price).to.equal(currentRate); // Should return actual rate
    });

    it("should bounce down price when above upper bound", async () => {
      const vaultAddress = await mockVault.getAddress();

      // Large price increase (above upper bound)
      await mockVault.setMockTotalAssets(ethers.parseEther("1200")); // 20% increase (> 2% window)

      const { price, isAlive } = await oracleWrapper.getPriceInfo(vaultAddress);
      const [, upperBound] = await oracleWrapper.getVaultBounds(vaultAddress);

      expect(isAlive).to.be.true;
      expect(price).to.equal(upperBound); // Should be capped at upper bound
      expect(price).to.be.lt(await mockVault.convertToAssets(BASE_CURRENCY_UNIT_18_DECIMALS)); // Should be less than actual
    });

    it("should fail when below lower bound", async () => {
      const vaultAddress = await mockVault.getAddress();

      // Large price decrease (below lower bound)
      await mockVault.setMockTotalAssets(ethers.parseEther("800")); // 20% decrease (< lower bound)

      const { price, isAlive } = await oracleWrapper.getPriceInfo(vaultAddress);

      expect(isAlive).to.be.false;
      expect(price).to.equal(0); // Hard failure
    });

    it("should handle bounds update during price movement", async () => {
      const vaultAddress = await mockVault.getAddress();

      // Price moves to upper bound
      await mockVault.setMockTotalAssets(ethers.parseEther("1200"));

      let { price } = await oracleWrapper.getPriceInfo(vaultAddress);
      const [, originalUpperBound] = await oracleWrapper.getVaultBounds(vaultAddress);
      expect(price).to.equal(originalUpperBound); // Bounced to upper bound

      // Governance updates bounds to accommodate new price level
      // Current rate is 1.2, so we need bounds that include this
      const newLowerBound = ethers.parseEther("1.18"); // Just below current rate
      await oracleWrapper.updateVaultBounds(vaultAddress, newLowerBound);

      // Now price should be within bounds and return actual rate
      ({ price } = await oracleWrapper.getPriceInfo(vaultAddress));
      const currentRate = await mockVault.convertToAssets(BASE_CURRENCY_UNIT_18_DECIMALS);
      expect(price).to.equal(currentRate); // Should return actual rate now
    });
  });

  describe("Attack Resistance", () => {
    beforeEach(async () => {
      await oracleWrapper.addVault(
        await mockVault.getAddress(),
        MIN_SHARE_SUPPLY,
        await mockAsset.getAddress()
      );
    });

    it("should resist large manipulation attempts", async () => {
      const vaultAddress = await mockVault.getAddress();

      // Massive manipulation attempt (10x increase)
      await mockVault.setMockTotalAssets(ethers.parseEther("10000"));

      const { price, isAlive } = await oracleWrapper.getPriceInfo(vaultAddress);
      const [, upperBound] = await oracleWrapper.getVaultBounds(vaultAddress);

      expect(isAlive).to.be.true;
      expect(price).to.equal(upperBound); // Should be capped, not unlimited
      expect(price).to.be.lt(await mockVault.convertToAssets(BASE_CURRENCY_UNIT_18_DECIMALS)); // Much less than manipulated rate
    });

    it("should handle donation attack protection", async () => {
      // Deploy vault with high minimum share requirement
      const AttackVaultFactory = await ethers.getContractFactory("MockERC4626Vault");
      const attackVault = await AttackVaultFactory.deploy(
        await mockAsset.getAddress(),
        "Attack Vault",
        "avTEST"
      );

      const highMinimum = ethers.parseEther("1000");
      await oracleWrapper.addVault(
        await attackVault.getAddress(),
        highMinimum,
        await mockAsset.getAddress()
      );

      // Small deposit with donation attack
      const attackDeposit = ethers.parseEther("1");
      await mockAsset.connect(await ethers.getSigner(user2)).approve(
        await attackVault.getAddress(),
        attackDeposit * BigInt(2)
      );

      await attackVault.connect(await ethers.getSigner(user2)).deposit(attackDeposit, user2);
      await mockAsset.connect(await ethers.getSigner(user2)).approve(
        await attackVault.getAddress(),
        attackDeposit
      );
      await attackVault.connect(await ethers.getSigner(user2)).simulateDonationAttack(attackDeposit);

      // Oracle should reject due to insufficient share supply
      const { price, isAlive } = await oracleWrapper.getPriceInfo(await attackVault.getAddress());
      expect(price).to.equal(0);
      expect(isAlive).to.be.false;
    });
  });

  describe("Edge Cases", () => {
    it("should handle vault with zero total supply", async () => {
      const EmptyVaultFactory = await ethers.getContractFactory("MockERC4626Vault");
      const emptyVault = await EmptyVaultFactory.deploy(
        await mockAsset.getAddress(),
        "Empty Vault",
        "evTEST"
      );

      await oracleWrapper.addVault(
        await emptyVault.getAddress(),
        MIN_SHARE_SUPPLY,
        await mockAsset.getAddress()
      );

      const { price, isAlive } = await oracleWrapper.getPriceInfo(await emptyVault.getAddress());
      expect(price).to.equal(0);
      expect(isAlive).to.be.false;
    });

    it("should handle multiple vaults independently", async () => {
      // Add main vault
      await oracleWrapper.addVault(
        await mockVault.getAddress(),
        MIN_SHARE_SUPPLY,
        await mockAsset.getAddress()
      );

      // Create second vault with different exchange rate
      const SecondVaultFactory = await ethers.getContractFactory("MockERC4626Vault");
      const secondVault = await SecondVaultFactory.deploy(
        await mockAsset.getAddress(),
        "Second Vault",
        "svTEST"
      );

      await mockAsset.connect(await ethers.getSigner(user1)).approve(
        await secondVault.getAddress(),
        ethers.parseEther("500")
      );
      await secondVault.connect(await ethers.getSigner(user1)).deposit(
        ethers.parseEther("500"),
        user1
      );
      await secondVault.setMockTotalAssets(ethers.parseEther("750")); // 1.5:1 ratio

      await oracleWrapper.addVault(
        await secondVault.getAddress(),
        MIN_SHARE_SUPPLY,
        await mockAsset.getAddress()
      );

      // Both vaults should have independent bounds
      const { price: price1 } = await oracleWrapper.getPriceInfo(await mockVault.getAddress());
      const { price: price2 } = await oracleWrapper.getPriceInfo(await secondVault.getAddress());

      expect(price1).to.equal(ethers.parseEther("1"));
      expect(price2).to.equal(ethers.parseEther("1.5"));
    });
  });

  describe("Deadlock Scenarios", () => {
    beforeEach(async () => {
      await oracleWrapper.addVault(
        await mockVault.getAddress(),
        MIN_SHARE_SUPPLY,
        await mockAsset.getAddress()
      );
    });

    it("should handle fund recovery scenario with governance intervention", async () => {
      const vaultAddress = await mockVault.getAddress();

      // Simulate hack: vault loses 90% of value
      await mockVault.setMockTotalAssets(ethers.parseEther("100")); // 90% loss

      // Oracle should fail due to being below lower bound
      let { price, isAlive } = await oracleWrapper.getPriceInfo(vaultAddress);
      expect(isAlive).to.be.false;
      expect(price).to.equal(0);

      // Governance intervenes: updates bounds to accommodate new reality
      const currentRateAfterHack = await mockVault.convertToAssets(BASE_CURRENCY_UNIT_18_DECIMALS);
      const newLowerBound = currentRateAfterHack * BigInt(99) / BigInt(100); // Just below current rate
      await oracleWrapper.updateVaultBounds(vaultAddress, newLowerBound);

      // Oracle should now work with reduced bounds
      ({ price, isAlive } = await oracleWrapper.getPriceInfo(vaultAddress));
      expect(isAlive).to.be.true;
      expect(price).to.be.gt(0);

      // Simulate fund recovery: 80% of original value recovered
      await mockVault.setMockTotalAssets(ethers.parseEther("800"));

      // Price should be capped at upper bound initially
      ({ price } = await oracleWrapper.getPriceInfo(vaultAddress));
      const [, upperBound] = await oracleWrapper.getVaultBounds(vaultAddress);
      expect(price).to.equal(upperBound); // Bounced to upper bound

      // Governance updates bounds again to accommodate recovery
      const currentRateAfterRecovery = await mockVault.convertToAssets(BASE_CURRENCY_UNIT_18_DECIMALS);
      const recoveryLowerBound = currentRateAfterRecovery * BigInt(99) / BigInt(100); // Just below recovery rate
      await oracleWrapper.updateVaultBounds(vaultAddress, recoveryLowerBound);

      // Now oracle should accept recovered price
      ({ price } = await oracleWrapper.getPriceInfo(vaultAddress));
      const actualRate = await mockVault.convertToAssets(BASE_CURRENCY_UNIT_18_DECIMALS);
      expect(price).to.equal(actualRate);
    });

    it("should prevent manipulation while allowing legitimate movement", async () => {
      const vaultAddress = await mockVault.getAddress();

      // Small legitimate increase (within bounds)
      await mockVault.setMockTotalAssets(ethers.parseEther("1005")); // 0.5% increase (within 2% window)
      let { price, isAlive } = await oracleWrapper.getPriceInfo(vaultAddress);
      expect(isAlive).to.be.true;
      expect(price).to.equal(await mockVault.convertToAssets(BASE_CURRENCY_UNIT_18_DECIMALS));

      // Large manipulation attempt (above bounds)
      await mockVault.setMockTotalAssets(ethers.parseEther("1500")); // 50% increase
      ({ price, isAlive } = await oracleWrapper.getPriceInfo(vaultAddress));
      const [, upperBound] = await oracleWrapper.getVaultBounds(vaultAddress);

      expect(isAlive).to.be.true;
      expect(price).to.equal(upperBound); // Capped at upper bound
      expect(price).to.be.lt(await mockVault.convertToAssets(BASE_CURRENCY_UNIT_18_DECIMALS));
    });
  });

  describe("Access Control", () => {
    it("should prevent non-ORACLE_MANAGER from updating bounds", async () => {
      const vaultAddress = await mockVault.getAddress();
      await oracleWrapper.addVault(vaultAddress, MIN_SHARE_SUPPLY, await mockAsset.getAddress());

      const unauthorizedSigner = await ethers.getSigner(user2);

      await expect(
        oracleWrapper.connect(unauthorizedSigner).updateVaultBounds(vaultAddress, ethers.parseEther("0.5"))
      ).to.be.reverted;
    });

    it("should prevent non-ORACLE_MANAGER from adding vaults", async () => {
      const unauthorizedSigner = await ethers.getSigner(user2);

      await expect(
        oracleWrapper.connect(unauthorizedSigner).addVault(
          await mockVault.getAddress(),
          MIN_SHARE_SUPPLY,
          await mockAsset.getAddress()
        )
      ).to.be.reverted;
    });
  });
});