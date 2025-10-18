import { expect } from "chai";
import { ethers } from "hardhat";

import { DStakeIdleVault, GenericERC4626ConversionAdapter, TestMintableERC20 } from "../../../typechain-types";

describe("GenericERC4626ConversionAdapter", function () {
  let asset: TestMintableERC20;
  let idleVault: DStakeIdleVault;
  let adapter: GenericERC4626ConversionAdapter;
  let router: string;
  let collateralVault: string;

  beforeEach(async function () {
    const [routerSigner, collateralVaultSigner] = await ethers.getSigners();
    router = routerSigner.address;
    collateralVault = collateralVaultSigner.address;

    const assetFactory = await ethers.getContractFactory("TestMintableERC20");
    asset = (await assetFactory.deploy("Mock dUSD", "dUSD", 18)) as TestMintableERC20;
    await asset.waitForDeployment();

    await asset.mint(router, ethers.parseEther("10000"));

    const idleVaultFactory = await ethers.getContractFactory("DStakeIdleVault");
    idleVault = (await idleVaultFactory.deploy(await asset.getAddress(), "Idle dUSD", "idle-dUSD", router, router)) as DStakeIdleVault;
    await idleVault.waitForDeployment();

    const adapterFactory = await ethers.getContractFactory("GenericERC4626ConversionAdapter");
    adapter = (await adapterFactory.deploy(
      await asset.getAddress(),
      await idleVault.getAddress(),
      collateralVault,
    )) as GenericERC4626ConversionAdapter;
    await adapter.waitForDeployment();
  });

  it("converts deposits into idle vault shares", async function () {
    const routerSigner = await ethers.getSigner(router);
    const depositAmount = ethers.parseEther("1000");

    await asset.connect(routerSigner).approve(await adapter.getAddress(), depositAmount);
    await adapter.connect(routerSigner).depositIntoStrategy(depositAmount);

    expect(await asset.balanceOf(await adapter.getAddress())).to.equal(0);
    expect(await idleVault.balanceOf(collateralVault)).to.equal(depositAmount);
  });

  it("converts idle vault shares back to assets on withdrawal", async function () {
    const routerSigner = await ethers.getSigner(router);
    const depositAmount = ethers.parseEther("500");

    await asset.connect(routerSigner).approve(await adapter.getAddress(), depositAmount);
    await adapter.connect(routerSigner).depositIntoStrategy(depositAmount);
    const mintedShares = await idleVault.balanceOf(collateralVault);
    expect(mintedShares).to.equal(depositAmount);

    // Transfer shares from collateral vault signer to router to simulate router pulling them back
    const collateralSigner = await ethers.getSigner(collateralVault);
    await idleVault.connect(collateralSigner).transfer(router, mintedShares);

    await idleVault.connect(routerSigner).approve(await adapter.getAddress(), mintedShares);
    await adapter.connect(routerSigner).withdrawFromStrategy(mintedShares);

    expect(await asset.balanceOf(router)).to.equal(ethers.parseEther("10000"));
    expect(await idleVault.balanceOf(router)).to.equal(0);
  });

  it("reports strategy share values via preview", async function () {
    const routerSigner = await ethers.getSigner(router);
    const depositAmount = ethers.parseEther("100");
    await asset.connect(routerSigner).approve(await adapter.getAddress(), depositAmount);
    await adapter.connect(routerSigner).depositIntoStrategy(depositAmount);
    const mintedShares = await idleVault.balanceOf(collateralVault);
    expect(mintedShares).to.equal(depositAmount);

    const preview = await adapter.previewWithdrawFromStrategy(mintedShares);
    expect(preview).to.equal(depositAmount);

    const value = await adapter.strategyShareValueInDStable(await idleVault.getAddress(), mintedShares);
    expect(value).to.equal(depositAmount);

    await expect(adapter.strategyShareValueInDStable(ethers.ZeroAddress, mintedShares)).to.be.revertedWithCustomError(
      adapter,
      "IncorrectStrategyShare",
    );
  });

  it("exposes the managed strategy share", async function () {
    expect(await adapter.strategyShare()).to.equal(await idleVault.getAddress());
  });
});
