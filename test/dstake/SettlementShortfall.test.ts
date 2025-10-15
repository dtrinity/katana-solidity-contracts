import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

import { DStakeRouterV2, DStakeTokenV2, TestMintableERC20 } from "../../typechain-types";
import { SDUSD_CONFIG } from "./fixture";
import { createDStakeRouterV2Fixture } from "./routerFixture";

const BPS_SCALE = 1_000_000n; // Matches BasisPointConstants.ONE_HUNDRED_PERCENT_BPS

describe("DStakeTokenV2 settlement shortfall", function () {
  const setupFixture = createDStakeRouterV2Fixture(SDUSD_CONFIG);

  let dStakeToken: DStakeTokenV2;
  let router: DStakeRouterV2;
  let dStable: TestMintableERC20;
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  interface FixtureResult {
    dStakeToken: DStakeTokenV2;
    router: DStakeRouterV2;
    dStable: TestMintableERC20;
    owner: SignerWithAddress;
    alice: SignerWithAddress;
    bob: SignerWithAddress;
  }

  beforeEach(async function () {
    const fixture = await setupFixture();
    ({ dStakeToken, router, dStable, owner, alice, bob } = fixture as unknown as FixtureResult);
  });

  it("defaults to zero and emits on update", async function () {
    expect(await router.currentShortfall()).to.equal(0n);

    const seedDeposit = ethers.parseEther("100");
    await dStable.connect(alice).approve(dStakeToken, seedDeposit);
    await dStakeToken.connect(alice).deposit(seedDeposit, alice.address);

    const newShortfall = ethers.parseEther("20");
    await expect(dStakeToken.connect(owner).setSettlementShortfall(newShortfall))
      .to.emit(router, "SettlementShortfallUpdated")
      .withArgs(0n, newShortfall);

    expect(await router.currentShortfall()).to.equal(newShortfall);
  });

  it("reduces withdrawable assets and maxWithdraw", async function () {
    const depositAmount = ethers.parseEther("100");
    await dStable.connect(alice).approve(dStakeToken, depositAmount);
    await dStakeToken.connect(alice).deposit(depositAmount, alice.address);

    const shortfall = ethers.parseEther("20");
    await dStakeToken.connect(owner).setSettlementShortfall(shortfall);

    expect(await dStakeToken.grossTotalAssets()).to.equal(depositAmount);
    expect(await dStakeToken.totalAssets()).to.equal(depositAmount - shortfall);

    const aliceShares = await dStakeToken.balanceOf(alice.address);
    const redeemable = await dStakeToken.convertToAssets(aliceShares);
    const expectedRedeemable = depositAmount - shortfall;
    const tolerance = 1_000_000_000_000_000n; // 1e15 wei provides headroom for rounding in OZ math
    expect(redeemable).to.be.closeTo(expectedRedeemable, tolerance);

    const feeBps = await dStakeToken.withdrawalFeeBps();
    const expectedFee = (redeemable * feeBps) / BPS_SCALE;
    const expectedNet = redeemable - expectedFee;

    const maxWithdraw = await dStakeToken.maxWithdraw(alice.address);
    expect(maxWithdraw).to.be.closeTo(expectedNet, tolerance);

    const dStableBefore = await dStable.balanceOf(alice.address);
    await dStakeToken.connect(alice).withdraw(maxWithdraw, alice.address, alice.address);
    const dStableAfter = await dStable.balanceOf(alice.address);

    const netDelta = dStableAfter - dStableBefore;
    expect(netDelta).to.be.closeTo(maxWithdraw, tolerance);
    expect(await dStakeToken.balanceOf(alice.address)).to.be.lte(1n);
  });

  it("quotes new deposits against net assets when a shortfall is active", async function () {
    const seedDeposit = ethers.parseEther("100");
    await dStable.connect(alice).approve(dStakeToken, seedDeposit);
    await dStakeToken.connect(alice).deposit(seedDeposit, alice.address);

    const recordedShortfall = ethers.parseEther("20");
    await dStakeToken.connect(owner).setSettlementShortfall(recordedShortfall);

    const supplyBefore = await dStakeToken.totalSupply();
    const netAssetsBefore = await dStakeToken.totalAssets();

    const bobDeposit = ethers.parseEther("10");
    await dStable.connect(bob).approve(dStakeToken, bobDeposit);
    const expectedShares = (bobDeposit * (supplyBefore + 1n)) / (netAssetsBefore + 1n);

    const previewShares = await dStakeToken.previewDeposit(bobDeposit);
    expect(previewShares).to.equal(expectedShares);

    await expect(dStakeToken.connect(bob).deposit(bobDeposit, bob.address))
      .to.emit(dStakeToken, "Deposit")
      .withArgs(bob.address, bob.address, bobDeposit, previewShares);

    const bobShares = await dStakeToken.balanceOf(bob.address);
    expect(bobShares).to.equal(expectedShares);
  });

  it("preserves the ERC4626 totalAssets invariant before and after new deposits", async function () {
    const initialDeposit = ethers.parseEther("100");
    await dStable.connect(alice).approve(dStakeToken, initialDeposit);
    await dStakeToken.connect(alice).deposit(initialDeposit, alice.address);

    const shortfall = ethers.parseEther("30");
    await dStakeToken.connect(owner).setSettlementShortfall(shortfall);

    const supplyBefore = await dStakeToken.totalSupply();
    const assetsBefore = await dStakeToken.totalAssets();
    expect(await dStakeToken.convertToAssets(supplyBefore)).to.equal(assetsBefore);

    const bobDeposit = ethers.parseEther("10");
    await dStable.connect(bob).approve(dStakeToken, bobDeposit);
    await dStakeToken.connect(bob).deposit(bobDeposit, bob.address);

    const supplyAfter = await dStakeToken.totalSupply();
    const assetsAfter = await dStakeToken.totalAssets();
    expect(await dStakeToken.convertToAssets(supplyAfter)).to.equal(assetsAfter);
  });

  it("keeps preview helpers aligned under a shortfall", async function () {
    const seedAssets = ethers.parseUnits("123.456789", 18);
    await dStable.connect(alice).approve(dStakeToken, seedAssets);
    await dStakeToken.connect(alice).deposit(seedAssets, alice.address);

    const shortfall = ethers.parseUnits("12.345678", 18);
    await dStakeToken.connect(owner).setSettlementShortfall(shortfall);

    const probeAssets = ethers.parseUnits("10.5", 18);
    const convertQuote = await dStakeToken.convertToShares(probeAssets);
    const previewDepositQuote = await dStakeToken.previewDeposit(probeAssets);
    expect(convertQuote).to.equal(previewDepositQuote);

    const previewMintQuote = await dStakeToken.previewMint(previewDepositQuote);
    const tolerance = 1n;
    expect(previewMintQuote).to.be.closeTo(probeAssets, tolerance);

    const previewRedeemQuote = await dStakeToken.previewRedeem(previewDepositQuote);
    const sharesForWithdraw = await dStakeToken.previewWithdraw(previewRedeemQuote);
    expect(sharesForWithdraw).to.be.closeTo(previewDepositQuote, 1n);
  });

  it("socializes shortfall recovery pro-rata across all vault shares", async function () {
    const initialDeposit = ethers.parseEther("100");
    await dStable.connect(alice).approve(dStakeToken, initialDeposit);
    await dStakeToken.connect(alice).deposit(initialDeposit, alice.address);

    const shortfall = ethers.parseEther("60");
    await dStakeToken.connect(owner).setSettlementShortfall(shortfall);

    // Bob deposits while the shortfall is active
    const bobDeposit = ethers.parseEther("10");
    await dStable.connect(bob).approve(dStakeToken, bobDeposit);
    const bobPreviewShares = await dStakeToken.previewDeposit(bobDeposit);
    await expect(dStakeToken.connect(bob).deposit(bobDeposit, bob.address))
      .to.emit(dStakeToken, "Deposit")
      .withArgs(bob.address, bob.address, bobDeposit, bobPreviewShares);

    // While the shortfall is still active, Bob's shares are discounted
    const bobShares = await dStakeToken.balanceOf(bob.address);
    const redeemableWithShortfall = await dStakeToken.convertToAssets(bobShares);
    expect(redeemableWithShortfall).to.be.lt(bobDeposit);

    const totalSharesAfterDeposit = await dStakeToken.totalSupply();

    // Governance clears the shortfall
    await dStakeToken.connect(owner).setSettlementShortfall(0);

    const redeemableAfterRecovery = await dStakeToken.convertToAssets(bobShares);
    const expectedAfterRecovery = redeemableWithShortfall + (shortfall * bobShares) / totalSharesAfterDeposit;

    const tolerance = 1_000_000_000_000_000n;
    expect(redeemableAfterRecovery).to.be.closeTo(expectedAfterRecovery, tolerance);
    expect(redeemableAfterRecovery).to.be.gt(bobDeposit);
  });

  it("reverts when the shortfall exceeds gross assets", async function () {
    const depositAmount = ethers.parseEther("50");
    await dStable.connect(alice).approve(dStakeToken, depositAmount);
    await dStakeToken.connect(alice).deposit(depositAmount, alice.address);

    const excessiveShortfall = ethers.parseEther("60");
    await expect(dStakeToken.connect(owner).setSettlementShortfall(excessiveShortfall)).to.be.revertedWithCustomError(
      router,
      "SettlementShortfallTooHigh",
    );
  });
});
