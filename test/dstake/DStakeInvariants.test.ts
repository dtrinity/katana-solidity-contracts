import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

import { SDUSD_CONFIG } from "./fixture";
import { createDStakeRouterV2Fixture } from "./routerFixture";
import {
  DStakeRouterV2,
  DStakeTokenV2,
  DStakeCollateralVaultV2,
  MetaMorphoConversionAdapter,
  TestMintableERC20,
} from "../../typechain-types";
import { MockMetaMorphoVault } from "../../typechain-types";
import { IERC20 } from "../../typechain-types/@openzeppelin/contracts/token/ERC20/IERC20";

const ONE_HUNDRED_PERCENT_BPS = 1_000_000n;

describe("dSTAKE Invariants", function () {
  const setupRouterFixture = createDStakeRouterV2Fixture(SDUSD_CONFIG);

  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let collateralExchanger: SignerWithAddress;
  let router: DStakeRouterV2;
  let dStakeToken: DStakeTokenV2;
  let collateralVault: DStakeCollateralVaultV2;
  let dStable: TestMintableERC20;
  let adapterAddresses: string[];
  let vaultAddresses: string[];
  let adapters: MetaMorphoConversionAdapter[];

  beforeEach(async function () {
    const fixture = await setupRouterFixture();
    owner = fixture.owner;
    alice = fixture.alice;
    collateralExchanger = fixture.collateralExchanger;
    router = fixture.router;
    dStakeToken = fixture.dStakeToken;
    collateralVault = fixture.collateralVault;
    dStable = fixture.dStable;

    adapterAddresses = [fixture.adapter1Address, fixture.adapter2Address, fixture.adapter3Address];
    vaultAddresses = [fixture.vault1Address, fixture.vault2Address, fixture.vault3Address];
    adapters = [fixture.adapter1, fixture.adapter2, fixture.adapter3];
  });

  describe("Allowance hygiene", function () {
    async function expectNoResidualAllowances() {
      const routerAddress = await router.getAddress();
      const dStakeTokenAddress = await dStakeToken.getAddress();

      expect(await dStable.allowance(dStakeTokenAddress, routerAddress)).to.equal(0n);

      for (const adapter of adapterAddresses) {
        expect(await dStable.allowance(routerAddress, adapter)).to.equal(0n);
      }
    }

    it("clears approvals after deposits, withdrawals, reinvest, and surplus sweeps", async function () {
      const routerAddress = await router.getAddress();
      const dStakeTokenAddress = await dStakeToken.getAddress();
      const depositAmount = ethers.parseEther("1000");

      await dStable.connect(alice).approve(dStakeTokenAddress, depositAmount);
      await dStakeToken.connect(alice).deposit(depositAmount, alice.address);
      await expectNoResidualAllowances();

      const withdrawAmount = depositAmount / 2n;
      await dStakeToken.connect(alice).withdraw(withdrawAmount, alice.address, alice.address);
      await expectNoResidualAllowances();

      const feeBps = BigInt(await dStakeToken.maxWithdrawalFeeBps());
      const feeManagerRole = await dStakeToken.FEE_MANAGER_ROLE();
      if (!(await dStakeToken.hasRole(feeManagerRole, owner.address))) {
        await dStakeToken.connect(owner).grantRole(feeManagerRole, owner.address);
      }
      await dStakeToken.connect(owner).setWithdrawalFee(feeBps / 2n);

      const extraDeposit = ethers.parseEther("500");
      await dStable.connect(alice).approve(dStakeTokenAddress, extraDeposit);
      await dStakeToken.connect(alice).deposit(extraDeposit, alice.address);
      await dStakeToken.connect(alice).withdraw(extraDeposit / 2n, alice.address, alice.address);

      await dStakeToken.connect(owner).reinvestFees();
      await expectNoResidualAllowances();

      if ((await router.defaultDepositStrategyShare()) === ethers.ZeroAddress) {
        await router.connect(owner).setDefaultDepositStrategyShare(vaultAddresses[0]);
      }

      const sweepAmount = ethers.parseEther("250");
      await dStable.connect(owner).mint(routerAddress, sweepAmount);
      await router.connect(owner).sweepSurplus(0);
      await expectNoResidualAllowances();
    });
  });

  describe("Slippage guard consistency", function () {
    it("enforces preview equivalence on successful operator swaps", async function () {
      const routerAddress = await router.getAddress();
      const depositAmount = ethers.parseEther("1000");

      const fromVault = vaultAddresses[0];
      const toVault = vaultAddresses[1];
      const fromAdapterAddress = adapterAddresses[0];
      const toAdapterAddress = adapterAddresses[1];

      await dStable.connect(alice).approve(await dStakeToken.getAddress(), depositAmount);
      await dStakeToken.connect(alice).solverDepositAssets([fromVault], [depositAmount], 0, alice.address);

      const fromAdapter = adapters[0];
      const toAdapter = adapters[1];

      const collateralVaultAddress = await collateralVault.getAddress();
      const fromVaultToken = (await ethers.getContractAt("IERC20", fromVault)) as IERC20;
      const toVaultToken = (await ethers.getContractAt("IERC20", toVault)) as IERC20;

      const fromBalance = await fromVaultToken.balanceOf(collateralVaultAddress);
      expect(fromBalance).to.be.gt(0n, "insufficient shares to swap");

      const fromShareAmount = fromBalance / 2n;
      const toBalanceBefore = await toVaultToken.balanceOf(collateralVaultAddress);

      await router.connect(collateralExchanger).exchangeStrategySharesInternal(fromVault, toVault, fromShareAmount, 0);

      const toBalanceAfter = await toVaultToken.balanceOf(collateralVaultAddress);
      const resultingToShares = toBalanceAfter - toBalanceBefore;

      const fromValue = await fromAdapter.previewWithdrawFromStrategy(fromShareAmount);
      const toValue = await toAdapter.previewWithdrawFromStrategy(resultingToShares);
      const dustTolerance = await router.dustTolerance();
      const minRequired = fromValue > dustTolerance ? fromValue - dustTolerance : 0n;
      expect(toValue).to.be.gte(minRequired);

      expect(await dStable.allowance(routerAddress, fromAdapterAddress)).to.equal(0n);
      expect(await dStable.allowance(routerAddress, toAdapterAddress)).to.equal(0n);
    });
  });

  describe("Atomic failure semantics", function () {
    it("surfaces SlippageCheckFailed for vault shortfalls", async function () {
      const dStakeTokenAddress = await dStakeToken.getAddress();
      const depositAmount = ethers.parseEther("400");
      const targetVault = vaultAddresses[0];
      const routerAddress = await router.getAddress();

      const feeManagerRole = await dStakeToken.FEE_MANAGER_ROLE();
      if (!(await dStakeToken.hasRole(feeManagerRole, owner.address))) {
        await dStakeToken.connect(owner).grantRole(feeManagerRole, owner.address);
      }
      await dStakeToken.connect(owner).setWithdrawalFee(0);

      await dStable.connect(alice).approve(dStakeTokenAddress, depositAmount);
      await dStakeToken.connect(alice).solverDepositAssets([targetVault], [depositAmount], 0, alice.address);

      const shareToken = (await ethers.getContractAt("IERC20", targetVault)) as IERC20;
      expect(await dStable.balanceOf(targetVault)).to.equal(depositAmount);

      const mockVault = (await ethers.getContractAt("MockMetaMorphoVault", targetVault)) as MockMetaMorphoVault;
      await mockVault.connect(owner).setFees(0, 100);
      expect(await mockVault.withdrawalFee()).to.equal(100);

      const spareAmount = depositAmount * 2n;
      await dStable.connect(owner).mint(owner.address, spareAmount);
      await dStable.connect(owner).approve(targetVault, spareAmount);
      await mockVault.connect(owner).deposit(spareAmount, routerAddress);
      expect(await shareToken.balanceOf(routerAddress)).to.be.gte(depositAmount);

      const dStakeTokenSigner = await ethers.getImpersonatedSigner(dStakeTokenAddress);
      await ethers.provider.send("hardhat_setBalance", [dStakeTokenAddress, ethers.toBeHex(ethers.parseEther("10"))]);

      await expect(router.connect(dStakeTokenSigner).solverWithdrawAssets([targetVault], [depositAmount])).to.be.revertedWithCustomError(
        router,
        "SlippageCheckFailed"
      );
    });
  });

  describe("Collateral vault liveness", function () {
    it("returns zero when router is unset", async function () {
      const collateralVaultFactory = await ethers.getContractFactory("DStakeCollateralVaultV2", owner);
      const dStakeTokenAddress = await dStakeToken.getAddress();
      const dStableAddress = await dStable.getAddress();

      const freshVault = await collateralVaultFactory.deploy(dStakeTokenAddress, dStableAddress);
      await freshVault.waitForDeployment();

      expect(await freshVault.totalValueInDStable()).to.equal(0n);
    });
  });

  describe("Adapter round-trip", function () {
    it("redeems at least declared slippage across all adapters", async function () {
      const collateralVaultAddress = await collateralVault.getAddress();
      const routerAddress = await router.getAddress();
      const routerSigner = await ethers.getImpersonatedSigner(routerAddress);
      await ethers.provider.send("hardhat_setBalance", [routerAddress, ethers.toBeHex(ethers.parseEther("10"))]);

      for (let i = 0; i < vaultAddresses.length; i++) {
        const vaultAddress = vaultAddresses[i];
        const adapterAddress = adapterAddresses[i];
        const depositAmount = ethers.parseEther("200");

        const adapter = adapters[i];
        const mockVault = (await ethers.getContractAt("MockMetaMorphoVault", vaultAddress)) as MockMetaMorphoVault;
        await mockVault.connect(owner).setYieldRate(0);
        const vaultToken = (await ethers.getContractAt("IERC20", vaultAddress)) as IERC20;

        const sharesBefore = await vaultToken.balanceOf(collateralVaultAddress);
        await dStable.connect(alice).approve(adapterAddress, depositAmount);
        const [expectedShareAsset, expectedShareAmount] = await adapter.previewDepositIntoStrategy(depositAmount);
        expect(expectedShareAsset).to.equal(vaultAddress);
        await adapter.connect(alice).depositIntoStrategy(depositAmount);
        const sharesAfter = await vaultToken.balanceOf(collateralVaultAddress);

        const mintedStrategyShares = sharesAfter - sharesBefore;
        expect(mintedStrategyShares).to.be.gte(expectedShareAmount);

        await collateralVault.connect(routerSigner).transferStrategyShares(vaultAddress, mintedStrategyShares, alice.address);

        await vaultToken.connect(alice).approve(adapterAddress, mintedStrategyShares);
        const expectedReturn = await adapter.previewWithdrawFromStrategy(mintedStrategyShares);
        const aliceBalanceBefore = await dStable.balanceOf(alice.address);
        await adapter.connect(alice).withdrawFromStrategy(mintedStrategyShares);
        const aliceBalanceAfter = await dStable.balanceOf(alice.address);

        const netAssets = aliceBalanceAfter - aliceBalanceBefore;
        const delta = depositAmount > netAssets ? depositAmount - netAssets : 0n;

        let declaredSlippage = 0n;
        const maybeMeta = await ethers
          .getContractAt("MetaMorphoConversionAdapter", adapterAddress)
          .then((contract) => contract as MetaMorphoConversionAdapter)
          .catch(() => null);
        if (maybeMeta) {
          declaredSlippage = BigInt(await maybeMeta.getMaxSlippage());
        }

        const slippageBound = (depositAmount * declaredSlippage) / ONE_HUNDRED_PERCENT_BPS + 1n;

        expect(delta).to.be.lte(slippageBound, `adapter ${adapterAddress} exceeded declared slippage`);
      }
    });
  });

  describe("Dust handling", function () {
    it("handles preview and 1 wei withdrawals without underflow", async function () {
      const dStakeTokenAddress = await dStakeToken.getAddress();
      const depositAmount = ethers.parseEther("50");

      await dStable.connect(alice).approve(dStakeTokenAddress, depositAmount);
      await dStakeToken.connect(alice).deposit(depositAmount, alice.address);

      const previewWithdraw = await dStakeToken.previewWithdraw(1n);
      expect(previewWithdraw).to.be.gte(1n);

      const previewRedeem = await dStakeToken.previewRedeem(1n);
      expect(previewRedeem).to.be.gte(0n);

      const sharesBefore = await dStakeToken.balanceOf(alice.address);
      await dStakeToken.connect(alice).withdraw(1n, alice.address, alice.address);
      const sharesAfter = await dStakeToken.balanceOf(alice.address);
      expect(sharesBefore - sharesAfter).to.be.gte(1n);
    });
  });
});
