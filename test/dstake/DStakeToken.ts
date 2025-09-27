import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { deployments, ethers, getNamedAccounts } from "hardhat";

import {
  DStakeCollateralVaultV2,
  DStakeRouterV2,
  DStakeTokenV2,
  ERC20,
} from "../../typechain-types";
import { ERC20StablecoinUpgradeable } from "../../typechain-types/contracts/dstable/ERC20StablecoinUpgradeable";
import { MetaMorphoConversionAdapter } from "../../typechain-types/contracts/vaults/dstake/adapters/MetaMorphoConversionAdapter";
import { MetaMorphoConversionAdapter__factory } from "../../typechain-types/factories/contracts/vaults/dstake/adapters/MetaMorphoConversionAdapter__factory";
import {
  createDStakeFixture,
  DSTAKE_CONFIGS,
  DStakeFixtureConfig,
} from "./fixture";

const parseUnits = (value: string | number, decimals: number | bigint) =>
  ethers.parseUnits(value.toString(), decimals);

DSTAKE_CONFIGS.forEach((config: DStakeFixtureConfig) => {
  describe.skip(`DStakeTokenV2 for ${config.DStakeTokenV2Symbol}`, () => {
    // Create fixture function once per suite for snapshot caching
    const fixture = createDStakeFixture(config);
    let deployer: SignerWithAddress;
    let user1: SignerWithAddress;
    let DStakeTokenV2: DStakeTokenV2;
    let collateralVault: DStakeCollateralVaultV2;
    let router: DStakeRouterV2;
    let dStableToken: ERC20;
    let stable: ERC20StablecoinUpgradeable;
    let minterRole: string;
    let adapterAddress: string;
    let adapter: MetaMorphoConversionAdapter;

    let DStakeTokenV2Address: string;
    let collateralVaultAddress: string;
    let routerAddress: string;
    let dStableDecimals: bigint;

    beforeEach(async () => {
      const named = await getNamedAccounts();
      deployer = await ethers.getSigner(named.deployer);
      user1 = await ethers.getSigner(named.user1 || named.deployer);

      // Revert to snapshot instead of re-deploying
      const out = await fixture();
      adapterAddress = out.adapterAddress;
      adapter = MetaMorphoConversionAdapter__factory.connect(
        adapterAddress,
        deployer,
      );
      DStakeTokenV2 = out.DStakeTokenV2 as unknown as DStakeTokenV2;
      collateralVault = out.collateralVault as unknown as DStakeCollateralVaultV2;
      router = out.router as unknown as DStakeRouterV2;
      dStableToken = out.dStableToken;
      dStableDecimals = await dStableToken.decimals();

      // Prepare stablecoin for minting
      stable = (await ethers.getContractAt(
        "ERC20StablecoinUpgradeable",
        await dStableToken.getAddress(),
        deployer,
      )) as ERC20StablecoinUpgradeable;
      minterRole = await stable.MINTER_ROLE();
      await stable.grantRole(minterRole, deployer.address);

      DStakeTokenV2Address = await DStakeTokenV2.getAddress();
      collateralVaultAddress = await collateralVault.getAddress();
      routerAddress = await router.getAddress();
    });

    describe("Initialization & State", () => {
      it("Should set immutable dStable address via asset()", async () => {
        expect(await DStakeTokenV2.asset()).to.equal(
          await dStableToken.getAddress(),
        );
      });

      it("Should revert initialize if dStable address is zero", async () => {
        const tokenFactory = await ethers.getContractFactory("DStakeTokenV2");
        await expect(
          deployments.deploy("InvalidDStakeTokenV2", {
            from: deployer.address,
            contract: "DStakeTokenV2",
            proxy: {
              proxyContract: "OpenZeppelinTransparentProxy",
              execute: {
                init: {
                  methodName: "initialize",
                  args: [
                    ZeroAddress,
                    "TestName",
                    "TST",
                    deployer.address,
                    deployer.address,
                  ],
                },
              },
            },
            log: false,
          }),
        ).to.be.revertedWithCustomError(tokenFactory, "ZeroAddress");
      });

      it("Should grant DEFAULT_ADMIN_ROLE to initialAdmin", async () => {
        const adminRole = await DStakeTokenV2.DEFAULT_ADMIN_ROLE();
        expect(await DStakeTokenV2.hasRole(adminRole, user1.address)).to.be.true;
      });

      it("Should have collateralVault and router set from fixture", async () => {
        expect(await DStakeTokenV2.collateralVault()).to.equal(
          collateralVaultAddress,
        );
        expect(await DStakeTokenV2.router()).to.equal(routerAddress);
      });

      it("Should set maxWithdrawalFeeBps constant", async () => {
        expect(await DStakeTokenV2.maxWithdrawalFeeBps()).to.equal(10000);
      });

      it("New instance withdrawalFeeBps should be zero by default", async () => {
        const deployResult = await deployments.deploy("FreshDStakeTokenV2", {
          from: deployer.address,
          contract: "DStakeTokenV2",
          proxy: {
            proxyContract: "OpenZeppelinTransparentProxy",
            execute: {
              init: {
                methodName: "initialize",
                args: [
                  await dStableToken.getAddress(),
                  "Fresh",
                  "FRS",
                  deployer.address,
                  deployer.address,
                ],
              },
            },
          },
          log: false,
        });
        const fresh = await ethers.getContractAt(
          "DStakeTokenV2",
          deployResult.address,
        );
        expect(await fresh.withdrawalFeeBps()).to.equal(0);
      });

      it("Fixture withdrawalFeeBps should equal initial config value", async () => {
        expect(await DStakeTokenV2.withdrawalFeeBps()).to.equal(10);
      });

      it("Should have correct name and symbol", async () => {
        const expectedName = `Staked ${config.DStakeTokenV2Symbol.substring(1)}`;
        const expectedSymbol = config.DStakeTokenV2Symbol;
        expect(await DStakeTokenV2.name()).to.equal(expectedName);
        expect(await DStakeTokenV2.symbol()).to.equal(expectedSymbol);
      });

      it("Should use same decimals as underlying dStable", async () => {
        expect(await DStakeTokenV2.decimals()).to.equal(dStableDecimals);
      });
    });

    describe("Role-Based Access Control & Configuration", () => {
      let DEFAULT_ADMIN_ROLE: string;
      let FEE_MANAGER_ROLE: string;

      beforeEach(async () => {
        DEFAULT_ADMIN_ROLE = await DStakeTokenV2.DEFAULT_ADMIN_ROLE();
        FEE_MANAGER_ROLE = await DStakeTokenV2.FEE_MANAGER_ROLE();
      });

      describe("migrateCore", () => {
        const deployNewCore = async () => {
          const vaultFactory = await ethers.getContractFactory(
            "DStakeCollateralVaultV2",
            user1,
          );
          const deployedVault = await vaultFactory.deploy(
            DStakeTokenV2Address,
            await dStableToken.getAddress(),
          );
          await deployedVault.waitForDeployment();

          const routerFactory = await ethers.getContractFactory(
            "DStakeRouterV2",
            user1,
          );
          const deployedRouter = await routerFactory.deploy(
            DStakeTokenV2Address,
            await deployedVault.getAddress(),
          );
          await deployedRouter.waitForDeployment();

          await deployedVault.setRouter(await deployedRouter.getAddress());

          return { deployedVault, deployedRouter };
        };

        it("Should allow admin to migrate router and collateral vault", async () => {
          const { deployedVault, deployedRouter } = await deployNewCore();
          const newVaultAddress = await deployedVault.getAddress();
          const newRouterAddress = await deployedRouter.getAddress();

           const recordedShortfall = ethers.parseEther("15");
           await DStakeTokenV2.connect(user1).setSettlementShortfall(recordedShortfall);

          await expect(
            DStakeTokenV2.connect(user1).migrateCore(
              newRouterAddress,
              newVaultAddress,
            ),
          )
            .to.emit(DStakeTokenV2, "RouterSet")
            .withArgs(newRouterAddress)
            .and.to.emit(DStakeTokenV2, "CollateralVaultSet")
            .withArgs(newVaultAddress);

          expect(await DStakeTokenV2.router()).to.equal(newRouterAddress);
          expect(await DStakeTokenV2.collateralVault()).to.equal(newVaultAddress);
          expect(await deployedRouter.currentShortfall()).to.equal(recordedShortfall);
        });

        it("Should revert if non-admin calls migrateCore", async () => {
          await expect(
            DStakeTokenV2.connect(deployer).migrateCore(
              routerAddress,
              collateralVaultAddress,
            ),
          ).to.be.revertedWithCustomError(
            DStakeTokenV2,
            "AccessControlUnauthorizedAccount",
          );
        });

        it("Should revert if any address is zero", async () => {
          await expect(
            DStakeTokenV2.connect(user1).migrateCore(
              ZeroAddress,
              collateralVaultAddress,
            ),
          ).to.be.revertedWithCustomError(DStakeTokenV2, "ZeroAddress");

          await expect(
            DStakeTokenV2.connect(user1).migrateCore(routerAddress, ZeroAddress),
          ).to.be.revertedWithCustomError(DStakeTokenV2, "ZeroAddress");
        });

        it("Should revert when router collateral vault does not match", async () => {
          const { deployedRouter } = await deployNewCore();
          await expect(
            DStakeTokenV2.connect(user1).migrateCore(
              await deployedRouter.getAddress(),
              collateralVaultAddress,
            ),
          ).to.be.revertedWithCustomError(
            DStakeTokenV2,
            "RouterCollateralMismatch",
          );
        });

        it("Should revert when collateral vault does not grant the router role", async () => {
          const vaultFactory = await ethers.getContractFactory(
            "DStakeCollateralVaultV2",
            user1,
          );
          const freshVault = await vaultFactory.deploy(
            DStakeTokenV2Address,
            await dStableToken.getAddress(),
          );
          await freshVault.waitForDeployment();

          const routerFactory = await ethers.getContractFactory(
            "DStakeRouterV2",
            user1,
          );
          const freshRouter = await routerFactory.deploy(
            DStakeTokenV2Address,
            await freshVault.getAddress(),
          );
          await freshRouter.waitForDeployment();

          await expect(
            DStakeTokenV2.connect(user1).migrateCore(
              await freshRouter.getAddress(),
              await freshVault.getAddress(),
            ),
          ).to.be.revertedWithCustomError(
            DStakeTokenV2,
            "CollateralVaultRouterMismatch",
          );
        });

        it("Should revert when router is configured for a different token", async () => {
          const routerFactory = await ethers.getContractFactory(
            "DStakeRouterV2",
            user1,
          );
          const mismatchedRouter = await routerFactory.deploy(
            user1.address,
            collateralVaultAddress,
          );
          await mismatchedRouter.waitForDeployment();

          await expect(
            DStakeTokenV2.connect(user1).migrateCore(
              await mismatchedRouter.getAddress(),
              collateralVaultAddress,
            ),
          ).to.be.revertedWithCustomError(
            DStakeTokenV2,
            "RouterTokenMismatch",
          );
        });
      });

      describe("Role Management", () => {
        it("Should allow admin to grant and revoke FEE_MANAGER_ROLE", async () => {
          await expect(
            DStakeTokenV2.connect(user1).grantRole(
              FEE_MANAGER_ROLE,
              deployer.address,
            ),
          ).to.not.be.reverted;
          expect(await DStakeTokenV2.hasRole(FEE_MANAGER_ROLE, deployer.address))
            .to.be.true;
          await expect(
            DStakeTokenV2.connect(user1).revokeRole(
              FEE_MANAGER_ROLE,
              deployer.address,
            ),
          ).to.not.be.reverted;
          expect(await DStakeTokenV2.hasRole(FEE_MANAGER_ROLE, deployer.address))
            .to.be.false;
        });
      });

      describe("setWithdrawalFee", () => {
        it("Should allow fee manager to set withdrawal fee", async () => {
          await expect(DStakeTokenV2.connect(user1).setWithdrawalFee(100))
            .to.emit(router, "WithdrawalFeeSet")
            .withArgs(0, 100);
          expect(await DStakeTokenV2.withdrawalFeeBps()).to.equal(100);
        });

        it("Should revert if non-fee-manager sets withdrawal fee", async () => {
          await expect(
            DStakeTokenV2.connect(deployer).setWithdrawalFee(100),
          ).to.be.revertedWithCustomError(
            DStakeTokenV2,
            "AccessControlUnauthorizedAccount",
          );
        });

        it("Should revert if fee exceeds maxWithdrawalFeeBps", async () => {
          await expect(
            DStakeTokenV2.connect(user1).setWithdrawalFee(10001),
          ).to.be.revertedWithCustomError(router, "InvalidWithdrawalFee");
        });

        it("Should allow setting fee to 0", async () => {
          await DStakeTokenV2.connect(user1).setWithdrawalFee(0);
          expect(await DStakeTokenV2.withdrawalFeeBps()).to.equal(0);
        });
      });
    });

    describe("ERC4626 Core Functionality (Deposits & Minting)", () => {
      const assetsToDeposit = parseUnits("100", dStableDecimals);
      let fresh: DStakeTokenV2;

      beforeEach(async () => {
        const deployResult = await deployments.deploy("FreshDStakeTokenV22", {
          from: deployer.address,
          contract: "DStakeTokenV2",
          proxy: {
            proxyContract: "OpenZeppelinTransparentProxy",
            execute: {
              init: {
                methodName: "initialize",
                args: [
                  await dStableToken.getAddress(),
                  "Fresh",
                  "FRS",
                  user1.address,
                  user1.address,
                ],
              },
            },
          },
          log: false,
        });
        fresh = await ethers.getContractAt("DStakeTokenV2", deployResult.address);
      });

      it("totalAssets returns 0 if collateralVault not set", async () => {
        expect(await fresh.totalAssets()).to.equal(0);
      });

      it("totalAssets returns 0 if collateralVault has no assets", async () => {
        expect(await DStakeTokenV2.totalAssets()).to.equal(0);
      });

      it("totalAssets delegates correctly to collateralVault", async () => {
        await stable.mint(user1.address, assetsToDeposit);
        await dStableToken
          .connect(user1)
          .approve(DStakeTokenV2Address, assetsToDeposit);
        await DStakeTokenV2.connect(user1).deposit(
          assetsToDeposit,
          user1.address,
        );
        const expected = await collateralVault.totalValueInDStable();
        expect(await DStakeTokenV2.totalAssets()).to.equal(expected);
      });

      describe("convertToShares & convertToAssets", () => {
        it("should handle zero correctly", async () => {
          expect(await DStakeTokenV2.convertToShares(0n)).to.equal(0n);
          expect(await DStakeTokenV2.convertToAssets(0n)).to.equal(0n);
        });

        it("should convert assets to shares 1:1 when empty", async () => {
          const shares = await DStakeTokenV2.convertToShares(assetsToDeposit);
          expect(shares).to.equal(assetsToDeposit);
          const assets = await DStakeTokenV2.convertToAssets(assetsToDeposit);
          expect(assets).to.equal(assetsToDeposit);
        });

        it("should reflect share price change when vault has extra assets", async () => {
          // initial deposit to set base share price
          await stable.mint(user1.address, assetsToDeposit);
          await dStableToken
            .connect(user1)
            .approve(DStakeTokenV2Address, assetsToDeposit);
          await DStakeTokenV2.connect(user1).deposit(
            assetsToDeposit,
            user1.address,
          );

          // simulate additional yield by adapter
          const extra = parseUnits("50", dStableDecimals);
          await stable.mint(user1.address, extra);
          await dStableToken.connect(user1).approve(adapterAddress, extra);
          await adapter.connect(user1).depositIntoStrategy(extra);

          // now share price > 1:1, so convertToShares returns less shares
          const newShares = await DStakeTokenV2.convertToShares(assetsToDeposit);
          expect(newShares).to.be.lt(assetsToDeposit);

          // convertToAssets on newShares should not exceed original assets due to rounding
          const newAssets = await DStakeTokenV2.convertToAssets(newShares);
          expect(newAssets).to.be.lte(assetsToDeposit);
        });
      });

      it("previewDeposit returns expected shares", async () => {
        expect(await DStakeTokenV2.previewDeposit(assetsToDeposit)).to.equal(
          assetsToDeposit,
        );
      });

      it("maxDeposit returns uint256 max", async () => {
        expect(await DStakeTokenV2.maxDeposit(user1.address)).to.equal(
          ethers.MaxUint256,
        );
      });

      describe("deposit function", () => {
        it("should revert if router not set", async () => {
          await stable.mint(user1.address, assetsToDeposit);
          await dStableToken
            .connect(user1)
            .approve(await fresh.getAddress(), assetsToDeposit);
          await expect(
            fresh.connect(user1).deposit(assetsToDeposit, user1.address),
          ).to.be.revertedWithCustomError(fresh, "ZeroAddress");
        });

        // zero-asset deposit allowed by default OpenZeppelin behavior
        it("should revert with ERC20InvalidReceiver when receiver is zero", async () => {
          await stable.mint(user1.address, assetsToDeposit);
          await dStableToken
            .connect(user1)
            .approve(DStakeTokenV2Address, assetsToDeposit);
          await expect(
            DStakeTokenV2.connect(user1).deposit(assetsToDeposit, ZeroAddress),
          )
            .to.be.revertedWithCustomError(DStakeTokenV2, "ERC20InvalidReceiver")
            .withArgs(ZeroAddress);
        });

        it("should revert on insufficient balance", async () => {
          await dStableToken
            .connect(user1)
            .approve(DStakeTokenV2Address, assetsToDeposit);
          await expect(
            DStakeTokenV2.connect(user1).deposit(assetsToDeposit, user1.address),
          ).to.be.reverted;
        });

        it("should mint shares and emit Deposit event", async () => {
          await stable.mint(user1.address, assetsToDeposit);
          await dStableToken
            .connect(user1)
            .approve(DStakeTokenV2Address, assetsToDeposit);
          const shares = await DStakeTokenV2.previewDeposit(assetsToDeposit);
          await expect(
            DStakeTokenV2.connect(user1).deposit(assetsToDeposit, user1.address),
          )
            .to.emit(DStakeTokenV2, "Deposit")
            .withArgs(user1.address, user1.address, assetsToDeposit, shares);
          expect(await DStakeTokenV2.balanceOf(user1.address)).to.equal(shares);
        });
      });

      describe("mint function", () => {
        it("should mint shares and emit Deposit event via mint", async () => {
          const sharesToMint = parseUnits("50", dStableDecimals);
          const assetsToProvide = await DStakeTokenV2.previewMint(sharesToMint);
          await stable.mint(user1.address, assetsToProvide);
          await dStableToken
            .connect(user1)
            .approve(DStakeTokenV2Address, assetsToProvide);
          await expect(
            DStakeTokenV2.connect(user1).mint(sharesToMint, user1.address),
          )
            .to.emit(DStakeTokenV2, "Deposit")
            .withArgs(
              user1.address,
              user1.address,
              assetsToProvide,
              sharesToMint,
            );
          expect(await DStakeTokenV2.balanceOf(user1.address)).to.equal(
            sharesToMint,
          );
        });
      });
    });

    describe("ERC4626 Core Functionality (Withdrawals & Redeeming)", () => {
      // Tests for withdraw, redeem, preview, and max functions
      const assetsToDeposit = parseUnits("100", dStableDecimals);
      let shares: bigint;

      beforeEach(async () => {
        // Disable withdrawal fee for simplicity
        await DStakeTokenV2.connect(user1).setWithdrawalFee(0);
        // Mint and deposit assets for user1
        await stable.mint(user1.address, assetsToDeposit);
        await dStableToken
          .connect(user1)
          .approve(DStakeTokenV2Address, assetsToDeposit);
        shares = await DStakeTokenV2.previewDeposit(assetsToDeposit);
        await DStakeTokenV2.connect(user1).deposit(
          assetsToDeposit,
          user1.address,
        );
      });

      it("previewWithdraw returns expected shares", async () => {
        expect(await DStakeTokenV2.previewWithdraw(assetsToDeposit)).to.equal(
          shares,
        );
      });

      it("previewRedeem returns expected assets", async () => {
        expect(await DStakeTokenV2.previewRedeem(shares)).to.equal(
          assetsToDeposit,
        );
      });

      it("maxWithdraw returns deposit amount", async () => {
        expect(await DStakeTokenV2.maxWithdraw(user1.address)).to.equal(
          assetsToDeposit,
        );
      });

      it("maxRedeem returns share balance", async () => {
        expect(await DStakeTokenV2.maxRedeem(user1.address)).to.equal(shares);
      });

      it("allows zero-amount withdraw probes", async () => {
        await expect(
          DStakeTokenV2.connect(user1).withdraw(0, user1.address, user1.address),
        )
          .to.emit(DStakeTokenV2, "Withdraw")
          .withArgs(user1.address, user1.address, user1.address, 0, 0);
      });

      it("allows zero-share redeem probes", async () => {
        await expect(
          DStakeTokenV2.connect(user1).redeem(0, user1.address, user1.address),
        )
          .to.emit(DStakeTokenV2, "Withdraw")
          .withArgs(user1.address, user1.address, user1.address, 0, 0);
      });

      it("should withdraw assets and burn shares", async () => {
        const assetsToWithdraw = assetsToDeposit;
        const sharesToBurn =
          await DStakeTokenV2.previewWithdraw(assetsToWithdraw);
        await expect(
          DStakeTokenV2.connect(user1).withdraw(
            assetsToWithdraw,
            user1.address,
            user1.address,
          ),
        )
          .to.emit(DStakeTokenV2, "Withdraw")
          .withArgs(
            user1.address,
            user1.address,
            user1.address,
            assetsToWithdraw,
            sharesToBurn,
          );
        expect(await DStakeTokenV2.balanceOf(user1.address)).to.equal(0);
        expect(await dStableToken.balanceOf(user1.address)).to.equal(
          assetsToWithdraw,
        );
      });

      it("should redeem shares and transfer assets", async () => {
        const sharesToRedeem = shares;
        const assetsToReceive = await DStakeTokenV2.previewRedeem(sharesToRedeem);
        await expect(
          DStakeTokenV2.connect(user1).redeem(
            sharesToRedeem,
            user1.address,
            user1.address,
          ),
        )
          .to.emit(DStakeTokenV2, "Withdraw")
          .withArgs(
            user1.address,
            user1.address,
            user1.address,
            assetsToReceive,
            sharesToRedeem,
          );
        expect(await DStakeTokenV2.balanceOf(user1.address)).to.equal(0);
        expect(await dStableToken.balanceOf(user1.address)).to.equal(
          assetsToReceive,
        );
      });
    });

    describe("ERC4626 Withdrawals & Redeeming with Fees", () => {
      const assetsToDeposit = parseUnits("100", dStableDecimals);
      let shares: bigint;

      beforeEach(async () => {
        // Set withdrawal fee to 1% (10000 BPS)
        await DStakeTokenV2.connect(user1).setWithdrawalFee(10000);

        // Calculate the correct gross deposit amount needed to have enough shares
        // to withdraw 100 assets net. We need to deposit enough so that after
        // fees are deducted, we can still withdraw 100 assets.
        //
        // For mathematical correctness:
        // grossAmount = netAmount * ONE_HUNDRED_PERCENT_BPS / (ONE_HUNDRED_PERCENT_BPS - feeBps)
        // grossAmount = 100 * 1000000 / (1000000 - 10000) = 100 * 1000000 / 990000
        const grossDeposit = (assetsToDeposit * 1000000n) / (1000000n - 10000n);

        // Mint and deposit gross assets for user1
        await stable.mint(user1.address, grossDeposit);
        await dStableToken
          .connect(user1)
          .approve(DStakeTokenV2Address, grossDeposit);
        shares = await DStakeTokenV2.previewDeposit(grossDeposit);
        await DStakeTokenV2.connect(user1).deposit(grossDeposit, user1.address);
      });

      it("should withdraw assets with fee deducted", async () => {
        // When we call withdraw(100), the user wants 100 net assets
        // The contract calculates the gross amount needed and takes a fee from that
        const grossAmountNeeded =
          (assetsToDeposit * 1000000n) / (1000000n - 10000n);
        const fee = (grossAmountNeeded * 10000n) / 1000000n;
        // The user should receive exactly the amount they requested (100 assets)
        const netAssets = assetsToDeposit; // This should be exactly 100

        await DStakeTokenV2.connect(user1).withdraw(
          assetsToDeposit,
          user1.address,
          user1.address,
        );
        expect(await dStableToken.balanceOf(user1.address)).to.equal(netAssets);
        expect(await DStakeTokenV2.balanceOf(user1.address)).to.equal(0n);
      });

      it("should redeem shares with fee deducted", async () => {
        // previewRedeem already returns the net amount the user should receive.
        const previewAssets = await DStakeTokenV2.previewRedeem(shares);

        // Calculate the expected fee on the **gross** assets (convertToAssets(shares)).
        const grossAssets = await DStakeTokenV2.convertToAssets(shares);
        const fee = (grossAssets * 10000n) / 1000000n;
        await DStakeTokenV2.connect(user1).redeem(
          shares,
          user1.address,
          user1.address,
        );
        // User balance should increase by the previewRedeem amount (net assets)
        expect(await dStableToken.balanceOf(user1.address)).to.equal(
          previewAssets,
        );
        expect(await DStakeTokenV2.balanceOf(user1.address)).to.equal(0n);
      });

      // Preview functions should account for the withdrawal fee
      it("previewWithdraw returns expected shares including fee", async () => {
        // For mathematically correct fee calculation:
        // grossAmount = netAmount * ONE_HUNDRED_PERCENT_BPS / (ONE_HUNDRED_PERCENT_BPS - feeBps)
        const expectedGrossAmount =
          (assetsToDeposit * 1000000n) / (1000000n - 10000n);
        expect(await DStakeTokenV2.previewWithdraw(assetsToDeposit)).to.equal(
          expectedGrossAmount,
        );
      });

      it("previewRedeem returns expected assets after fee", async () => {
        // previewRedeem should return net amount after fee deduction
        const grossAssets = shares; // 1:1 ratio in this test setup
        const fee = (grossAssets * 10000n) / 1000000n;
        const expectedAssets = grossAssets - fee;
        expect(await DStakeTokenV2.previewRedeem(shares)).to.equal(
          expectedAssets,
        );
      });

      it("maxWithdraw returns net amount after fee and allows full withdrawal", async () => {
        // The maximum a user can withdraw (net) should be 100 assets in this setup
        const netMax = await DStakeTokenV2.maxWithdraw(user1.address);
        expect(netMax).to.equal(assetsToDeposit);

        const sharesToBurn = await DStakeTokenV2.previewWithdraw(netMax);

        await expect(
          DStakeTokenV2.connect(user1).withdraw(
            netMax,
            user1.address,
            user1.address,
          ),
        )
          .to.emit(DStakeTokenV2, "Withdraw")
          .withArgs(
            user1.address,
            user1.address,
            user1.address,
            netMax,
            sharesToBurn,
          );

        // User should now hold zero shares and exactly `netMax` more assets.
        expect(await DStakeTokenV2.balanceOf(user1.address)).to.equal(0n);
        expect(await dStableToken.balanceOf(user1.address)).to.equal(netMax);
      });
    });

    describe("Security: Unauthorized withdrawal protection", () => {
      let user2: SignerWithAddress;
      let assetsToDeposit: bigint;
      let shares: bigint;

      beforeEach(async () => {
        // Get a second user (attacker)
        const signers = await ethers.getSigners();
        user2 = signers[2]; // Use third signer as attacker

        // Set up for test: user1 deposits assets
        assetsToDeposit = parseUnits(100, dStableDecimals); // Reduced from 1000 to 100 to stay within supply caps

        // Give user1 some dStable tokens
        await stable.connect(deployer).mint(user1.address, assetsToDeposit);
        await dStableToken
          .connect(user1)
          .approve(DStakeTokenV2.target, assetsToDeposit);

        // User1 deposits assets
        await DStakeTokenV2.connect(user1).deposit(
          assetsToDeposit,
          user1.address,
        );
        shares = await DStakeTokenV2.balanceOf(user1.address);
      });

      it("should prevent unauthorized withdrawal without allowance", async () => {
        // user2 (attacker) tries to withdraw user1's assets to themselves
        // Should revert with insufficient allowance
        await expect(
          DStakeTokenV2.connect(user2).withdraw(
            1, // minimal amount to avoid max withdraw check
            user2.address, // attacker as receiver
            user1.address, // victim as owner
          ),
        ).to.be.revertedWithCustomError(
          DStakeTokenV2,
          "ERC20InsufficientAllowance",
        );
      });

      it("should prevent unauthorized redeem without allowance", async () => {
        // user2 (attacker) tries to redeem user1's shares to themselves
        // Should revert with insufficient allowance
        await expect(
          DStakeTokenV2.connect(user2).redeem(
            1, // minimal amount to avoid max redeem check
            user2.address, // attacker as receiver
            user1.address, // victim as owner
          ),
        ).to.be.revertedWithCustomError(
          DStakeTokenV2,
          "ERC20InsufficientAllowance",
        );
      });

      it("should allow withdrawal with proper allowance", async () => {
        // user1 grants allowance to user2
        await DStakeTokenV2.connect(user1).approve(user2.address, shares);

        // Get the net amount user can withdraw (after fees)
        const netAmount = await DStakeTokenV2.previewRedeem(shares);

        // Now user2 can withdraw on behalf of user1
        await expect(
          DStakeTokenV2.connect(user2).withdraw(
            netAmount,
            user2.address, // user2 as receiver
            user1.address, // user1 as owner
          ),
        ).to.not.be.reverted;

        // Verify user1's shares were burned
        expect(await DStakeTokenV2.balanceOf(user1.address)).to.equal(0);

        // Verify user2 received the assets
        expect(await dStableToken.balanceOf(user2.address)).to.be.greaterThan(
          0,
        );
      });
    });
  });
});
