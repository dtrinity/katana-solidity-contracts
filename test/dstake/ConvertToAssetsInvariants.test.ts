import { expect } from "chai";
import { ethers } from "hardhat";

import { DStakeTokenV2, MockDStakeCollateralVaultV2, MockDStakeRouterV2, TestMintableERC20 } from "../../typechain-types";

const WITHDRAWAL_FEE_BPS = 1_000;

async function deployFixture() {
  const [deployer, user] = await ethers.getSigners();

  const assetFactory = await ethers.getContractFactory("TestMintableERC20");
  const asset = (await assetFactory.deploy("Mock dStable", "mUSD", 18)) as TestMintableERC20;
  await asset.waitForDeployment();

  const dStakeTokenFactory = await ethers.getContractFactory("DStakeTokenV2");
  const implementation = await dStakeTokenFactory.deploy();
  await implementation.waitForDeployment();

  const initData = implementation.interface.encodeFunctionData("initialize", [
    await asset.getAddress(),
    "Staked Mock",
    "smUSD",
    deployer.address,
    deployer.address,
  ]);

  const proxyFactory = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await proxyFactory.deploy(await implementation.getAddress(), initData);
  await proxy.waitForDeployment();

  const dStakeToken = (await ethers.getContractAt("DStakeTokenV2", await proxy.getAddress())) as DStakeTokenV2;

  const collateralFactory = await ethers.getContractFactory("MockDStakeCollateralVaultV2");
  const collateral = (await collateralFactory.deploy(await asset.getAddress())) as MockDStakeCollateralVaultV2;
  await collateral.waitForDeployment();
  await collateral.setDStakeToken(await dStakeToken.getAddress());

  const routerFactory = await ethers.getContractFactory("MockDStakeRouterV2");
  const router = (await routerFactory.deploy(
    await dStakeToken.getAddress(),
    await collateral.getAddress(),
    await asset.getAddress(),
  )) as MockDStakeRouterV2;
  await router.waitForDeployment();

  await collateral.setRouter(await router.getAddress());

  await dStakeToken.connect(deployer).migrateCore(await router.getAddress(), await collateral.getAddress());
  await dStakeToken.connect(deployer).setWithdrawalFee(WITHDRAWAL_FEE_BPS);

  return { deployer, user, asset, dStakeToken, router };
}

describe("DStakeTokenV2 convertToAssets invariants", function () {
  it("returns totalAssets for totalSupply even with withdrawal fees", async function () {
    const { user, asset, dStakeToken } = await deployFixture();

    const depositAmount = ethers.parseEther("1000");
    await asset.mint(user.address, depositAmount);
    await asset.connect(user).approve(await dStakeToken.getAddress(), depositAmount);
    await dStakeToken.connect(user).deposit(depositAmount, user.address);

    const supply = await dStakeToken.totalSupply();
    const assets = await dStakeToken.totalAssets();
    expect(await dStakeToken.convertToAssets(supply)).to.equal(assets);
  });

  it("round-trips shares through convertToAssets/convertToShares under fees", async function () {
    const { user, asset, dStakeToken } = await deployFixture();

    const depositAmount = ethers.parseEther("1000");
    await asset.mint(user.address, depositAmount);
    await asset.connect(user).approve(await dStakeToken.getAddress(), depositAmount);
    await dStakeToken.connect(user).deposit(depositAmount, user.address);

    const shares = await dStakeToken.balanceOf(user.address);
    const assetsFromConvert = await dStakeToken.convertToAssets(shares);
    const roundTrip = await dStakeToken.convertToShares(assetsFromConvert);
    expect(roundTrip).to.equal(shares);
  });
});
