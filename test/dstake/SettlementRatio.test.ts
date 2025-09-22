import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

import { DStakeTokenV2, TestMintableERC20 } from "../../typechain-types";
import { SDUSD_CONFIG } from "./fixture";
import { createDStakeRouterV2Fixture } from "./routerFixture";

const ONE = ethers.parseUnits("1", 18);
const BPS_SCALE = 1_000_000n; // Matches BasisPointConstants.ONE_HUNDRED_PERCENT_BPS

describe("DStakeTokenV2 settlement ratio", function () {
  const setupFixture = createDStakeRouterV2Fixture(SDUSD_CONFIG);

  let dStakeToken: DStakeTokenV2;
  let dStable: TestMintableERC20;
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  interface FixtureResult {
    dStakeToken: DStakeTokenV2;
    dStable: TestMintableERC20;
    owner: SignerWithAddress;
    alice: SignerWithAddress;
    bob: SignerWithAddress;
  }

  beforeEach(async function () {
    const fixture = await setupFixture();
    ({ dStakeToken, dStable, owner, alice, bob } = fixture as unknown as FixtureResult);
  });

  it("defaults to 100% and emits on update", async function () {
    expect(await dStakeToken.settlementRatio()).to.equal(ONE);

    const newRatio = ethers.parseUnits("0.8", 18);
    await expect(dStakeToken.connect(owner).setSettlementRatio(newRatio))
      .to.emit(dStakeToken, "SettlementRatioUpdated")
      .withArgs(ONE, newRatio);

    expect(await dStakeToken.settlementRatio()).to.equal(newRatio);
  });

  it("scales withdrawable assets and maxWithdraw", async function () {
    const depositAmount = ethers.parseEther("100");
    await dStable.connect(alice).approve(dStakeToken, depositAmount);
    await dStakeToken.connect(alice).deposit(depositAmount, alice.address);

    const haircut = ethers.parseUnits("0.8", 18);
    await dStakeToken.connect(owner).setSettlementRatio(haircut);

    const aliceShares = await dStakeToken.balanceOf(alice.address);
    const grossConvertible = await dStakeToken.convertToAssets(aliceShares);
    const expectedGross = (depositAmount * haircut) / ONE;
    const tolerance = 1_000_000_000_000_000n;
    expect(grossConvertible).to.be.closeTo(expectedGross, tolerance);

    const feeBps = await dStakeToken.withdrawalFeeBps();
    const expectedFee = (grossConvertible * feeBps) / BPS_SCALE;
    const expectedNet = grossConvertible - expectedFee;

    const maxWithdraw = await dStakeToken.maxWithdraw(alice.address);
    expect(maxWithdraw).to.be.closeTo(expectedNet, tolerance);

    const dStableBefore = await dStable.balanceOf(alice.address);
    await dStakeToken.connect(alice).withdraw(maxWithdraw, alice.address, alice.address);
    const dStableAfter = await dStable.balanceOf(alice.address);

    const netDelta = dStableAfter - dStableBefore;
    expect(netDelta).to.be.closeTo(maxWithdraw, tolerance);
    expect(await dStakeToken.balanceOf(alice.address)).to.equal(0n);
  });

  it("maintains share price for new deposits after haircut", async function () {
    const initialDeposit = ethers.parseEther("100");
    await dStable.connect(alice).approve(dStakeToken, initialDeposit);
    await dStakeToken.connect(alice).deposit(initialDeposit, alice.address);

    const haircut = ethers.parseUnits("0.8", 18);
    await dStakeToken.connect(owner).setSettlementRatio(haircut);

    const expectedShareValue = haircut;
    const tolerance = 1_000_000_000_000_000n;
    const shareValueBefore = await dStakeToken.convertToAssets(ONE);
    expect(shareValueBefore).to.be.closeTo(expectedShareValue, tolerance);

    const bobDeposit = ethers.parseEther("10");
    await dStable.connect(bob).approve(dStakeToken, bobDeposit);
    await dStakeToken.connect(bob).deposit(bobDeposit, bob.address);

    const shareValueAfter = await dStakeToken.convertToAssets(ONE);
    expect(shareValueAfter).to.be.closeTo(expectedShareValue, tolerance);
  });

  it("rejects settlement ratios above 100%", async function () {
    const ratio = ethers.parseUnits("1.01", 18);
    await expect(dStakeToken.connect(owner).setSettlementRatio(ratio)).to.be.revertedWithCustomError(
      dStakeToken,
      "InvalidSettlementRatio"
    );
  });

  it("blocks new deposits when ratio is zero", async function () {
    await dStakeToken.connect(owner).setSettlementRatio(0n);

    const amount = ethers.parseEther("1");
    await dStable.connect(bob).approve(dStakeToken, amount);
    await expect(dStakeToken.connect(bob).deposit(amount, bob.address)).to.be.revertedWithCustomError(
      dStakeToken,
      "SettlementRatioDisabled"
    );
  });
});
