import { expect } from "chai";
import { ethers } from "hardhat";

describe("WrappedDLendConversionAdapter invariants", function () {
  const depositAmount = ethers.parseEther("100");

  let deployer: any;
  let router: any;
  let collateral: any;

  let dStable: any;
  let staticToken: any;
  let adapter: any;

  beforeEach(async function () {
    [deployer, router, collateral] = await ethers.getSigners();

    const TestMintableERC20 = await ethers.getContractFactory("TestMintableERC20");
    dStable = await TestMintableERC20.deploy("dUSD", "dUSD", 18);
    await dStable.waitForDeployment();

    const MockERC4626Simple = await ethers.getContractFactory("MockERC4626Simple");
    staticToken = await MockERC4626Simple.deploy(await dStable.getAddress());
    await staticToken.waitForDeployment();

    const WrappedAdapter = await ethers.getContractFactory("WrappedDLendConversionAdapter");
    adapter = await WrappedAdapter.deploy(await dStable.getAddress(), await staticToken.getAddress(), collateral.address);
    await adapter.waitForDeployment();

    await dStable.mint(router.address, depositAmount);
    await dStable.connect(router).approve(await adapter.getAddress(), depositAmount);
  });

  it("mints static shares exclusively to the collateral vault during deposits", async function () {
    await adapter.connect(router).depositIntoStrategy(depositAmount);

    const totalShares = await staticToken.totalSupply();
    const collateralShares = await staticToken.balanceOf(collateral.address);
    const routerShares = await staticToken.balanceOf(router.address);
    const adapterShares = await staticToken.balanceOf(await adapter.getAddress());

    expect(totalShares).to.equal(depositAmount);
    expect(collateralShares).to.equal(totalShares);
    expect(routerShares).to.equal(0n);
    expect(adapterShares).to.equal(0n);
  });

  it("burns static shares before releasing underlying on withdrawals", async function () {
    await adapter.connect(router).depositIntoStrategy(depositAmount);

    const sharesHeld = await staticToken.balanceOf(collateral.address);

    await staticToken.connect(collateral).approve(router.address, sharesHeld);
    await staticToken.connect(router).transferFrom(collateral.address, router.address, sharesHeld);
    await staticToken.connect(router).approve(await adapter.getAddress(), sharesHeld);

    // Mock vault adds a 10% bonus on redeem, so seed extra liquidity to satisfy payout.
    await dStable.mint(await staticToken.getAddress(), depositAmount / 10n);

    const routerBalanceBefore = await dStable.balanceOf(router.address);
    await adapter.connect(router).withdrawFromStrategy(sharesHeld);
    const routerBalanceAfter = await dStable.balanceOf(router.address);

    const totalSharesAfter = await staticToken.totalSupply();
    const collateralSharesAfter = await staticToken.balanceOf(collateral.address);
    const routerSharesAfter = await staticToken.balanceOf(router.address);
    const adapterSharesAfter = await staticToken.balanceOf(await adapter.getAddress());

    expect(routerBalanceAfter).to.be.gt(routerBalanceBefore);
    expect(totalSharesAfter).to.equal(0n);
    expect(collateralSharesAfter).to.equal(0n);
    expect(routerSharesAfter).to.equal(0n);
    expect(adapterSharesAfter).to.equal(0n);
  });
});
