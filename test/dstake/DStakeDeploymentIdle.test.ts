import { expect } from "chai";
import { deployments, ethers } from "hardhat";

describe("dSTAKE deployment with idle vault", function () {
  beforeEach(async function () {
    await deployments.fixture(undefined, { keepExistingDeployments: false });
    await deployments.fixture([
      "local-setup",
      "oracle",
      "dusd",
      "dUSD-aTokenWrapper",
      "dlend",
      "dStake"
    ]);
  });

  it("deploys the idle vault and wires the adapter", async function () {
    const idleVaultDeployment = await deployments.get("DStakeIdleVault_sdUSD");
    const adapterDeployment = await deployments.get("GenericERC4626ConversionAdapter_sdUSD");
    const routerDeployment = await deployments.get("DStakeRouterV2_sdUSD");
    const collateralDeployment = await deployments.get("DStakeCollateralVaultV2_sdUSD");

    const router = await ethers.getContractAt("DStakeRouterV2", routerDeployment.address);
    const collateralVault = await ethers.getContractAt("DStakeCollateralVaultV2", collateralDeployment.address);

    expect(await router.strategyShareToAdapter(idleVaultDeployment.address)).to.equal(adapterDeployment.address);
    expect(await router.defaultDepositStrategyShare()).to.equal(idleVaultDeployment.address);

    const supportedShares = await collateralVault.getSupportedStrategyShares();
    expect(supportedShares).to.include(idleVaultDeployment.address);
  });
});
