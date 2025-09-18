import { expect } from "chai";
import { ethers } from "hardhat";
import { MetaMorphoConversionAdapter, TestMintableERC20, MockMetaMorphoVault } from "../../typechain-types";

describe("MetaMorphoConversionAdapter - Valuation Handling", function () {
  let adapter: MetaMorphoConversionAdapter;
  let dStable: TestMintableERC20;
  let metaMorphoVault: MockMetaMorphoVault;

  beforeEach(async function () {
    const [admin] = await ethers.getSigners();

    const TokenFactory = await ethers.getContractFactory("TestMintableERC20");
    dStable = await TokenFactory.deploy("dUSD", "dUSD", 18);

    const MockVaultFactory = await ethers.getContractFactory("MockMetaMorphoVault");
    metaMorphoVault = await MockVaultFactory.deploy(dStable.target, "MetaMorpho Vault", "mmVault");

    const AdapterFactory = await ethers.getContractFactory("MetaMorphoConversionAdapter");
    adapter = await AdapterFactory.deploy(dStable.target, metaMorphoVault.target, admin.address, admin.address);

    const depositAmount = ethers.parseEther("100");
    await dStable.mint(admin.address, depositAmount);
    await dStable.approve(metaMorphoVault.target, depositAmount);
    await metaMorphoVault.deposit(depositAmount, admin.address);
  });

  it("falls back to convertToAssets when previewRedeem reverts", async function () {
    const [admin] = await ethers.getSigners();

    const shares = await metaMorphoVault.balanceOf(admin.address);
    await metaMorphoVault.setPreviewRevertFlags(true, false);

    const expectedValue = await metaMorphoVault.convertToAssets(shares);
    const actualValue = await adapter.strategyShareValueInDStable(metaMorphoVault.target, shares);

    expect(actualValue).to.equal(expectedValue);
  });

  it("reverts when both previewRedeem and convertToAssets revert", async function () {
    await metaMorphoVault.setPreviewRevertFlags(true, true);

    await expect(
      adapter.strategyShareValueInDStable(metaMorphoVault.target, 1n)
    ).to.be.revertedWithCustomError(adapter, "ValuationUnavailable");
  });
});
