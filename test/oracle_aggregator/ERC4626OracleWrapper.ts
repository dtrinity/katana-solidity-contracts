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
      expect(await oracleWrapper.maxDeviation()).to.equal(500); // 5% default
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
      ).to.emit(oracleWrapper, "VaultAdded")
        .withArgs(vaultAddress, MIN_SHARE_SUPPLY, assetAddress);

      expect(await oracleWrapper.isVaultActive(vaultAddress)).to.be.true;

      const config = await oracleWrapper.vaultConfigs(vaultAddress);
      expect(config.isActive).to.be.true;
      expect(config.minShareSupply).to.equal(MIN_SHARE_SUPPLY);
      expect(config.underlyingAsset).to.equal(assetAddress);
      expect(config.lastValidPrice).to.be.gt(0); // Should be set to initial price
    });

    it("should reject invalid vault addresses", async () => {
      await expect(
        oracleWrapper.addVault(ethers.ZeroAddress, MIN_SHARE_SUPPLY, await mockAsset.getAddress())
      ).to.be.revertedWithCustomError(oracleWrapper, "InvalidVaultAddress");
    });

    it("should reject vaults with mismatched underlying assets", async () => {
      const wrongAsset = await ethers.getContractFactory("TestERC20");
      const wrongAssetInstance = await wrongAsset.deploy("Wrong", "WRONG", 18);

      await expect(
        oracleWrapper.addVault(
          await mockVault.getAddress(),
          MIN_SHARE_SUPPLY,
          await wrongAssetInstance.getAddress()
        )
      ).to.be.revertedWithCustomError(oracleWrapper, "InvalidUnderlyingAsset");
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

    it("should allow pausing and unpausing vaults", async () => {
      const vaultAddress = await mockVault.getAddress();

      await oracleWrapper.addVault(vaultAddress, MIN_SHARE_SUPPLY, await mockAsset.getAddress());

      // Pause vault
      await expect(oracleWrapper.pauseVault(vaultAddress))
        .to.emit(oracleWrapper, "VaultPaused")
        .withArgs(vaultAddress);

      expect(await oracleWrapper.isVaultActive(vaultAddress)).to.be.false;

      // Unpause vault
      await expect(oracleWrapper.unPauseVault(vaultAddress))
        .to.emit(oracleWrapper, "VaultUnpaused")
        .withArgs(vaultAddress);

      expect(await oracleWrapper.isVaultActive(vaultAddress)).to.be.true;
    });
  });

  describe("Price Retrieval", () => {
    beforeEach(async () => {
      await oracleWrapper.addVault(
        await mockVault.getAddress(),
        MIN_SHARE_SUPPLY,
        await mockAsset.getAddress()
      );
    });

    it("should return correct initial price for new vault", async () => {
      const { price, isAlive } = await oracleWrapper.getPriceInfo(await mockVault.getAddress());

      expect(isAlive).to.be.true;
      expect(price).to.equal(ethers.parseEther("1")); // 1:1 exchange rate initially
    });

    it("should return same price via getAssetPrice and getPriceInfo", async () => {
      const vaultAddress = await mockVault.getAddress();
      const { price: priceFromInfo } = await oracleWrapper.getPriceInfo(vaultAddress);
      const priceFromAsset = await oracleWrapper.getAssetPrice(vaultAddress);

      expect(priceFromInfo).to.equal(priceFromAsset);
    });

    it("should handle vault with zero total supply", async () => {
      // Create empty vault
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

    it("should reject pricing when insufficient liquidity", async () => {
      // Create vault with high minimum requirement
      const LowLiquidityVaultFactory = await ethers.getContractFactory("MockERC4626Vault");
      const lowLiquidityVault = await LowLiquidityVaultFactory.deploy(
        await mockAsset.getAddress(),
        "Low Liquidity Vault",
        "lvTEST"
      );

      const highMinimum = ethers.parseEther("1000"); // Very high requirement
      await oracleWrapper.addVault(
        await lowLiquidityVault.getAddress(),
        highMinimum,
        await mockAsset.getAddress()
      );

      // Only deposit small amount (below minimum) 
      const smallDeposit = ethers.parseEther("50");
      await mockAsset.connect(await ethers.getSigner(user2)).approve(
        await lowLiquidityVault.getAddress(),
        smallDeposit
      );
      await lowLiquidityVault.connect(await ethers.getSigner(user2)).deposit(smallDeposit, user2);

      const { price, isAlive } = await oracleWrapper.getPriceInfo(await lowLiquidityVault.getAddress());

      expect(price).to.equal(0);
      expect(isAlive).to.be.false;
    });
  });

  describe("Protection Mechanisms", () => {
    beforeEach(async () => {
      await oracleWrapper.addVault(
        await mockVault.getAddress(),
        MIN_SHARE_SUPPLY,
        await mockAsset.getAddress()
      );
    });

    it("should detect and handle price deviation", async () => {
      const vaultAddress = await mockVault.getAddress();

      // Create a large price deviation (>5%)
      await mockVault.setMockTotalAssets(ethers.parseEther("2000")); // 100% increase

      // Check that oracle handles deviation gracefully
      const { price, isAlive } = await oracleWrapper.getPriceInfo(vaultAddress);

      // Should still provide a price (using lastValidPrice fallback)
      expect(isAlive).to.be.true;
      expect(price).to.be.gt(0);
    });

    it("should use stored valid price when deviation detected", async () => {
      const vaultAddress = await mockVault.getAddress();

      // Get baseline price from last valid update
      const lastValidPrice = await oracleWrapper.getLastValidPrice(vaultAddress);

      // Create massive price spike
      await mockVault.setMockTotalAssets(ethers.parseEther("10000")); // 10x increase

      // Oracle should return last valid price, not manipulated price
      const { price } = await oracleWrapper.getPriceInfo(vaultAddress);
      expect(price).to.equal(lastValidPrice); // Should use stored safe price
    });

    it("should use current price when deviation is acceptable", async () => {
      const vaultAddress = await mockVault.getAddress();

      // Small price change (within 5% limit)  
      await mockVault.setMockTotalAssets(ethers.parseEther("1030")); // 3% increase

      const { price } = await oracleWrapper.getPriceInfo(vaultAddress);
      const currentPrice = await mockVault.convertToAssets(BASE_CURRENCY_UNIT_18_DECIMALS);

      // Should accept current price since it's within deviation bounds
      expect(price).to.equal(currentPrice);
    });

    it("should handle donation attack protection", async () => {
      // Deploy vault with very high minimum share requirement
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

      // Simulate donation attack: small deposit + large donation
      const attackDeposit = ethers.parseEther("1");
      await mockAsset.connect(await ethers.getSigner(user2)).approve(
        await attackVault.getAddress(),
        attackDeposit * BigInt(2)
      );

      // Small initial deposit
      await attackVault.connect(await ethers.getSigner(user2)).deposit(attackDeposit, user2);

      // Simulate donation (direct asset transfer to inflate exchange rate)
      await mockAsset.connect(await ethers.getSigner(user2)).approve(
        await attackVault.getAddress(),
        attackDeposit
      );
      await attackVault.connect(await ethers.getSigner(user2)).simulateDonationAttack(attackDeposit);

      // Oracle should reject pricing due to insufficient share supply
      const { price, isAlive } = await oracleWrapper.getPriceInfo(await attackVault.getAddress());
      expect(price).to.equal(0);
      expect(isAlive).to.be.false;
    });
  });

  describe("Parameter Management", () => {
    it("should allow updating max deviation", async () => {
      const newDeviation = 1000; // 10%

      await expect(oracleWrapper.setMaxDeviation(newDeviation))
        .to.emit(oracleWrapper, "MaxDeviationUpdated")
        .withArgs(500, newDeviation);

      expect(await oracleWrapper.maxDeviation()).to.equal(newDeviation);
    });

    it("should reject invalid deviation values", async () => {
      await expect(oracleWrapper.setMaxDeviation(0))
        .to.be.revertedWithCustomError(oracleWrapper, "InvalidDeviation");

      await expect(oracleWrapper.setMaxDeviation(10001)) // > 100%
        .to.be.revertedWithCustomError(oracleWrapper, "InvalidDeviation");
    });

    it("should allow updating last valid price", async () => {
      const vaultAddress = await mockVault.getAddress();
      await oracleWrapper.addVault(vaultAddress, MIN_SHARE_SUPPLY, await mockAsset.getAddress());

      const newPrice = ethers.parseEther("1.5");

      await expect(oracleWrapper.updateLastValidPrice(vaultAddress, newPrice))
        .to.emit(oracleWrapper, "LastValidPriceUpdated")
        .withArgs(vaultAddress, newPrice);

      expect(await oracleWrapper.getLastValidPrice(vaultAddress)).to.equal(newPrice);
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

    it("should resist flash loan price manipulation", async () => {
      const vaultAddress = await mockVault.getAddress();

      // Get baseline price
      const initialPrice = await oracleWrapper.getLastValidPrice(vaultAddress);

      // Simulate flash loan attack: massive price spike (>5% deviation)
      await mockVault.setMockTotalAssets(ethers.parseEther("2100")); // 110% increase (>5% limit)

      // Oracle should detect deviation and use lastValidPrice for protection
      const { price, isAlive } = await oracleWrapper.getPriceInfo(vaultAddress);
      const currentInflatedPrice = await mockVault.convertToAssets(BASE_CURRENCY_UNIT_18_DECIMALS);
      const lastValidPrice = await oracleWrapper.getLastValidPrice(vaultAddress);

      expect(isAlive).to.be.true;
      expect(price).to.be.lt(currentInflatedPrice); // Should not use inflated price
      expect(price).to.equal(lastValidPrice); // Should use stored safe price
    });

    it("should prevent pricing when vault is paused", async () => {
      const vaultAddress = await mockVault.getAddress();

      // Pause the vault
      await oracleWrapper.pauseVault(vaultAddress);

      const { price, isAlive } = await oracleWrapper.getPriceInfo(vaultAddress);
      expect(price).to.equal(0);
      expect(isAlive).to.be.false;
    });
  });

  describe("Edge Cases", () => {
    it("should handle vault with zero assets", async () => {
      const vaultAddress = await mockVault.getAddress();

      await oracleWrapper.addVault(vaultAddress, MIN_SHARE_SUPPLY, await mockAsset.getAddress());

      // Set vault to have zero assets
      await mockVault.setMockTotalAssets(0);

      const { price, isAlive } = await oracleWrapper.getPriceInfo(vaultAddress);
      expect(price).to.equal(0);
      expect(isAlive).to.be.false;
    });

    it("should revert getAssetPrice when vault is not healthy", async () => {
      // First add the vault to the oracle
      await oracleWrapper.addVault(
        await mockVault.getAddress(),
        MIN_SHARE_SUPPLY,
        await mockAsset.getAddress()
      );

      // Then pause vault to make it unhealthy
      await oracleWrapper.pauseVault(await mockVault.getAddress());

      await expect(oracleWrapper.getAssetPrice(await mockVault.getAddress()))
        .to.be.revertedWithCustomError(oracleWrapper, "PriceNotAvailable");
    });

    it("should handle multiple vaults independently", async () => {
      // Add the main vault from beforeEach to the oracle wrapper
      await oracleWrapper.addVault(
        await mockVault.getAddress(),
        MIN_SHARE_SUPPLY,
        await mockAsset.getAddress()
      );

      // Create second vault
      const SecondVaultFactory = await ethers.getContractFactory("MockERC4626Vault");
      const secondVault = await SecondVaultFactory.deploy(
        await mockAsset.getAddress(),
        "Second Vault",
        "svTEST"
      );

      // Setup second vault with different exchange rate
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

      // Both vaults should return different prices
      const { price: price1 } = await oracleWrapper.getPriceInfo(await mockVault.getAddress());
      const { price: price2 } = await oracleWrapper.getPriceInfo(await secondVault.getAddress());

      expect(price1).to.equal(ethers.parseEther("1"));
      expect(price2).to.equal(ethers.parseEther("1.5"));
    });
  });

  describe("Access Control", () => {
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

    it("should prevent non-ADMIN from updating parameters", async () => {
      const unauthorizedSigner = await ethers.getSigner(user2);

      await expect(
        oracleWrapper.connect(unauthorizedSigner).setMaxDeviation(1000)
      ).to.be.reverted;
    });
  });
});