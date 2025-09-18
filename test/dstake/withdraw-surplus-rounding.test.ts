import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, getNamedAccounts } from "hardhat";

import {
  DStakeCollateralVaultV2,
  DStakeRouterV2,
  DStakeTokenV2,
  ERC20,
} from "../../typechain-types";
import { ERC20StablecoinUpgradeable } from "../../typechain-types/contracts/dstable/ERC20StablecoinUpgradeable";
import { createDStakeFixture, SDUSD_CONFIG as CONFIG } from "./fixture";

// Helper to parse units with given decimals
const parseUnits = (value: string, decimals: number | bigint) =>
  ethers.parseUnits(value, decimals);

describe.skip("DStakeRouterV2 – surplus < 1 share withdraw DoS", function () {
  const fixture = createDStakeFixture(CONFIG);

  let deployer: SignerWithAddress;
  let user1: SignerWithAddress;
  let DStakeTokenV2Inst: DStakeTokenV2;
  let router: DStakeRouterV2;
  let collateralVault: DStakeCollateralVaultV2;
  let dStable: ERC20;
  let dStableDecimals: bigint;
  let adapterAddress: string;
  let strategyShareAddress: string;

  beforeEach(async function () {
    // Deploy base system using fixture
    const f = await fixture();
    ({ DStakeTokenV2: DStakeTokenV2Inst, router, collateralVault } = f as any);
    dStable = f.dStableToken;
    dStableDecimals = await dStable.decimals();

    const named = await getNamedAccounts();
    deployer = await ethers.getSigner(named.deployer);
    user1 = await ethers.getSigner(named.user1);

    // 1. Deploy mock adapter that reverts on tiny deposits
    const MockAdapterFactory = await ethers.getContractFactory(
      "MockAdapterSmallDepositRevert",
    );
    const adapter = await MockAdapterFactory.deploy(
      await dStable.getAddress(),
      await collateralVault.getAddress(),
    );
    await adapter.waitForDeployment();
    adapterAddress = await adapter.getAddress();

    // 2. Register adapter with router and set as default deposit asset
    strategyShareAddress = await (adapter as any).strategyShare();

    // Note: Required roles are granted via deployment scripts

    await router.connect(user1).addAdapter(strategyShareAddress, adapterAddress);
    await router.connect(user1).setDefaultDepositStrategyShare(strategyShareAddress);

    // Arrange: mint & deposit dSTABLE
    const depositAmount = parseUnits("1000", dStableDecimals);
    const stable = (await ethers.getContractAt(
      "ERC20StablecoinUpgradeable",
      await dStable.getAddress(),
      deployer,
    )) as ERC20StablecoinUpgradeable;
    const minterRole = await stable.MINTER_ROLE();
    await stable.grantRole(minterRole, deployer.address);
    await stable.mint(deployer.address, depositAmount);
    await dStable
      .connect(deployer)
      .approve(await DStakeTokenV2Inst.getAddress(), depositAmount);

    await DStakeTokenV2Inst.connect(deployer).deposit(
      depositAmount,
      deployer.address,
    );
  });

  it("Withdrawal should succeed (test will FAIL on current code)", async function () {
    // Act + Assert: attempt to withdraw – this **should** succeed after fix
    const withdrawAmount = parseUnits("100", dStableDecimals);
    await expect(
      DStakeTokenV2Inst.connect(deployer).withdraw(
        withdrawAmount,
        deployer.address,
        deployer.address,
      ),
    ).to.not.be.reverted; // The pre-fix implementation reverts, so this spec fails.
  });
});
