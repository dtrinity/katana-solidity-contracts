import { expect } from "chai";
import { ethers } from "hardhat";

import { createDStakeRouterV2Fixture } from "./routerFixture";

const VaultStatus = {
  Active: 0,
  Suspended: 1,
  Impaired: 2
} as const;

describe("Deterministic Withdraw Selector", function () {
  const setupFixture = createDStakeRouterV2Fixture();

  let owner: any;
  let alice: any;
  let dStable: any;
  let router: any;
  let dStakeToken: any;
  let vault1Address: string;
  let vault2Address: string;
  let adapter1Address: string;
  let adapter2Address: string;

  beforeEach(async function () {
    const fixture = await setupFixture();
    owner = fixture.owner;
    alice = fixture.alice;
    dStable = fixture.dStable;
    router = fixture.router;
    dStakeToken = fixture.dStakeToken;
    vault1Address = fixture.vault1Address;
    vault2Address = fixture.vault2Address;
    adapter1Address = fixture.adapter1Address;
    adapter2Address = fixture.adapter2Address;

    const routerAddress = await router.getAddress();
    await dStable.connect(alice).approve(routerAddress, ethers.MaxUint256);
    await dStakeToken.connect(alice).approve(routerAddress, ethers.MaxUint256);
  });

  it("routes withdrawals to a vault with sufficient liquidity when allocations match targets", async function () {
    await router.connect(owner).setVaultConfigs([
      {
        strategyVault: vault1Address,
        adapter: adapter1Address,
        targetBps: 100000,
        status: VaultStatus.Active
      },
      {
        strategyVault: vault2Address,
        adapter: adapter2Address,
        targetBps: 900000,
        status: VaultStatus.Active
      }
    ]);

    const depositAmounts = [ethers.parseEther("100"), ethers.parseEther("900")];
    const depositVaults = [vault1Address, vault2Address];

    await router
      .connect(alice)
      .solverDepositAssets(depositVaults, depositAmounts, 0n, alice.address);

    const [, currentAllocations, targetAllocations] = await router.getCurrentAllocations();
    expect(currentAllocations).to.deep.equal(targetAllocations);

    const withdrawAssets = ethers.parseEther("600");
    const tx = await dStakeToken
      .connect(alice)
      .withdraw(withdrawAssets, alice.address, alice.address);

    const receipt = await tx.wait();
    const withdrawEvent = receipt.logs
      .map((log: any) => {
        try {
          return router.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((decoded: any) => decoded && decoded.name === "RouterWithdrawSettled");

    expect(withdrawEvent, "RouterWithdrawSettled event not found").to.not.be.undefined;
    if (withdrawEvent) {
      const strategyVault = withdrawEvent.args.strategyVault as string;
      const grossAssets = withdrawEvent.args.grossAssets as bigint;
      const netAssets = withdrawEvent.args.netAssets as bigint;

      expect(strategyVault).to.equal(vault2Address);
      expect(grossAssets).to.be.gte(withdrawAssets);
      expect(netAssets).to.be.gte(withdrawAssets);

      const allowableRounding = 10n ** 15n; // ~1e-3 dStable tolerance for preview rounding
      expect(grossAssets - withdrawAssets).to.be.lte(allowableRounding);
      expect(netAssets - withdrawAssets).to.be.lte(allowableRounding);
    }
  });
});
