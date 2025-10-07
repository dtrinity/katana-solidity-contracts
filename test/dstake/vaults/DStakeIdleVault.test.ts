import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { DStakeIdleVault, TestMintableERC20 } from "../../../typechain-types";

const ONE = ethers.parseEther("1");

describe("DStakeIdleVault", function () {
  let asset: TestMintableERC20;
  let vault: DStakeIdleVault;
  let deployer: string;
  let depositor: string;
  let rewardManager: string;

  beforeEach(async function () {
    const [deployerSigner, depositorSigner, rewardManagerSigner] = await ethers.getSigners();
    deployer = deployerSigner.address;
    depositor = depositorSigner.address;
    rewardManager = rewardManagerSigner.address;

    const assetFactory = await ethers.getContractFactory("TestMintableERC20");
    asset = (await assetFactory.deploy("Mock dUSD", "dUSD", 18)) as TestMintableERC20;
    await asset.waitForDeployment();

    await asset.mint(depositor, ethers.parseEther("1000"));
    await asset.mint(rewardManager, ethers.parseEther("1000"));

    const vaultFactory = await ethers.getContractFactory("DStakeIdleVault");
    vault = (await vaultFactory.deploy(
      await asset.getAddress(),
      "Staked dUSD Idle",
      "sdUSD-idle",
      deployer,
      rewardManager
    )) as DStakeIdleVault;
    await vault.waitForDeployment();
  });

  it("allows basic deposits and withdrawals", async function () {
    const depositorSigner = await ethers.getSigner(depositor);
    await asset.connect(depositorSigner).approve(await vault.getAddress(), ethers.MaxUint256);

    const depositAmount = ethers.parseEther("100");
    await expect(vault.connect(depositorSigner).deposit(depositAmount, depositor))
      .to.emit(vault, "Deposit")
      .withArgs(depositor, depositor, depositAmount, depositAmount);

    expect(await vault.totalAssets()).to.equal(depositAmount);

    await expect(vault.connect(depositorSigner).redeem(depositAmount, depositor, depositor))
      .to.emit(vault, "Withdraw")
      .withArgs(depositor, depositor, depositor, depositAmount, depositAmount);

    expect(await vault.totalAssets()).to.equal(0);
  });

  it("tracks emissions and releases them on accrue", async function () {
    const depositorSigner = await ethers.getSigner(depositor);
    await asset.connect(depositorSigner).approve(await vault.getAddress(), ethers.MaxUint256);

    const depositAmount = ethers.parseEther("100");
    await vault.connect(depositorSigner).deposit(depositAmount, depositor);

    const rewardManagerSigner = await ethers.getSigner(rewardManager);
    const rewardAmount = ethers.parseEther("10");
    await asset.connect(rewardManagerSigner).approve(await vault.getAddress(), rewardAmount);
    await vault.connect(rewardManagerSigner).fundRewards(rewardAmount);

    const now = await time.latest();
    const emissionStart = now + 10;
    const emissionEnd = emissionStart + 100;
    const emissionRate = rewardAmount / BigInt(emissionEnd - emissionStart);

    await vault.connect(rewardManagerSigner).setEmissionSchedule(emissionStart, emissionEnd, emissionRate);

    await time.increaseTo(emissionStart + 50);

    const pendingBefore = await vault.pendingEmission();
    expect(pendingBefore).to.be.gt(0);

    const reserveBefore = await vault.rewardReserve();

    await vault.connect(depositorSigner).accrueRewards();

    const pendingAfter = await vault.pendingEmission();
    expect(pendingAfter).to.equal(0);

    const reserveAfter = await vault.rewardReserve();
    const released = reserveBefore - reserveAfter;
    expect(released).to.be.gt(0);

    const totalAfter = await vault.totalAssets();
    const expectedTotal = depositAmount + (rewardAmount - reserveAfter);
    expect(totalAfter).to.equal(expectedTotal);
  });

  it("restricts reward operations to the reward manager", async function () {
    const [, nonManagerSigner] = await ethers.getSigners();
    await expect(vault.connect(nonManagerSigner).fundRewards(ONE)).to.be.revertedWithCustomError(
      vault,
      "AccessControlUnauthorizedAccount"
    );

    await expect(
      vault.connect(nonManagerSigner).withdrawUnreleasedRewards(nonManagerSigner.address, ONE)
    ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");

    await expect(vault.connect(nonManagerSigner).setEmissionSchedule(0, 0, 0)).to.be.revertedWithCustomError(
      vault,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("blocks withdrawing more rewards than reserved", async function () {
    const rewardManagerSigner = await ethers.getSigner(rewardManager);
    await asset.connect(rewardManagerSigner).approve(await vault.getAddress(), ONE);
    await vault.connect(rewardManagerSigner).fundRewards(ONE);

    await expect(
      vault.connect(rewardManagerSigner).withdrawUnreleasedRewards(rewardManager, ONE * 2n)
    ).to.be.revertedWithCustomError(vault, "InsufficientRewardReserve");
  });

  it("clamps pending emission by available reserve", async function () {
    const rewardManagerSigner = await ethers.getSigner(rewardManager);
    const rewards = ethers.parseEther("5");
    await asset.connect(rewardManagerSigner).approve(await vault.getAddress(), rewards);
    await vault.connect(rewardManagerSigner).fundRewards(rewards);

    const now = await time.latest();
    await vault.connect(rewardManagerSigner).setEmissionSchedule(now, now + 1_000_000, rewards * 10n);

    await time.increase(1000);
    const pending = await vault.pendingEmission();
    expect(pending).to.equal(rewards);
  });
});
