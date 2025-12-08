import { expect } from "chai";
import hre, { ethers, getNamedAccounts } from "hardhat";

import { ERC20StablecoinUpgradeable, FlashMintCollateralExchanger, MockLiFiRouter, TestERC20 } from "../../typechain-types";
import { DUSD_COLLATERAL_VAULT_CONTRACT_ID, DUSD_ISSUER_V2_CONTRACT_ID, DUSD_REDEEMER_CONTRACT_ID } from "../../typescript/deploy-ids";
import { getTokenContractForSymbol } from "../../typescript/token/utils";
import { createDStableFixture, DUSD_CONFIG } from "./fixtures";

describe("FlashMintCollateralExchanger", () => {
  const fixture = createDStableFixture(DUSD_CONFIG);
  let deployer: string;
  let user1: string;

  let dstable: ERC20StablecoinUpgradeable;
  let fromToken: TestERC20;
  let toToken: TestERC20;
  let exchanger: FlashMintCollateralExchanger;
  let router: MockLiFiRouter;
  let dstableDecimals: number;
  let fromDecimals: number;
  let toDecimals: number;

  beforeEach(async () => {
    await fixture();
    ({ deployer, user1 } = await getNamedAccounts());
    const deployerSigner = await ethers.getSigner(deployer);

    // Tokens
    const dstableResult = await getTokenContractForSymbol(hre, deployer, "dUSD");
    dstable = (await ethers.getContractAt(
      "ERC20StablecoinUpgradeable",
      dstableResult.tokenInfo.address,
      deployerSigner,
    )) as unknown as ERC20StablecoinUpgradeable;

    const fromResult = await getTokenContractForSymbol(hre, deployer, "USDC");
    fromToken = fromResult.contract as TestERC20;

    const toResult = await getTokenContractForSymbol(hre, deployer, "USDT");
    toToken = toResult.contract as TestERC20;
    dstableDecimals = Number(await dstable.decimals());
    fromDecimals = Number(await fromToken.decimals());
    toDecimals = Number(await toToken.decimals());

    // Core dependencies
    const redeemerAddress = (await hre.deployments.get(DUSD_REDEEMER_CONTRACT_ID)).address;
    const issuerAddress = (await hre.deployments.get(DUSD_ISSUER_V2_CONTRACT_ID)).address;
    const vaultAddress = (await hre.deployments.get(DUSD_COLLATERAL_VAULT_CONTRACT_ID)).address;

    // Deploy mock router
    router = (await (await ethers.getContractFactory("MockLiFiRouter", deployerSigner)).deploy()) as MockLiFiRouter;
    await router.waitForDeployment();

    // Deploy exchanger
    exchanger = (await (
      await ethers.getContractFactory("FlashMintCollateralExchanger", deployerSigner)
    ).deploy(
      await dstable.getAddress(),
      await dstable.getAddress(),
      redeemerAddress,
      issuerAddress,
      vaultAddress,
      deployer,
    )) as FlashMintCollateralExchanger;
    await exchanger.waitForDeployment();

    // Allowlist setup
    await exchanger.allowCollateral(fromResult.tokenInfo.address, true);
    await exchanger.allowCollateral(toResult.tokenInfo.address, true);
    await exchanger.setSwapRouter(await router.getAddress());
    // Recipient is exchanger itself (already allowlisted in constructor)

    // Fund vault with fromCollateral
    const depositAmount = ethers.parseUnits("100000", fromResult.tokenInfo.decimals);
    await fromToken.approve(vaultAddress, depositAmount);
    const vault = await ethers.getContractAt("CollateralHolderVault", vaultAddress, deployerSigner);
    await vault.deposit(depositAmount, fromResult.tokenInfo.address);

    // Fund router with toCollateral liquidity
    const routerLiquidity = ethers.parseUnits("200000", toResult.tokenInfo.decimals);
    await toToken.transfer(await router.getAddress(), routerLiquidity);

    // Give user some dUSD to test top-ups if needed
    await dstable.mint(user1, ethers.parseUnits("1000", dstableResult.tokenInfo.decimals));
  });

  const buildLiFiData = async (
    amountIn: bigint,
    amountOut: bigint,
    overrides: Partial<FlashMintCollateralExchanger.LiFiDataStruct> = {},
  ): Promise<FlashMintCollateralExchanger.LiFiDataStruct> => {
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 1000);
    const chainId = BigInt((await ethers.provider.getNetwork()).chainId);
    const recipient = overrides.recipient ?? (await exchanger.getAddress());

    return {
      callTo: overrides.callTo ?? (await router.getAddress()),
      approveTo: overrides.approveTo ?? (await router.getAddress()),
      value: overrides.value ?? 0n,
      data:
        overrides.data ?? router.interface.encodeFunctionData("swap", [fromToken.target, toToken.target, recipient, amountIn, amountOut]),
      deadline: overrides.deadline ?? deadline,
      recipient,
      fromChainId: overrides.fromChainId ?? chainId,
      toChainId: overrides.toChainId ?? chainId,
    };
  };

  const buildParams = async (
    overrides: Partial<FlashMintCollateralExchanger.FlashExchangeParamsStruct> = {},
  ): Promise<FlashMintCollateralExchanger.FlashExchangeParamsStruct> => {
    const defaultAmountIn = ethers.parseUnits("900", fromDecimals);
    const defaultAmountOut = ethers.parseUnits("900", toDecimals);
    const lifiData = overrides.lifiData ?? (await buildLiFiData(defaultAmountIn, defaultAmountOut));

    return {
      fromCollateral: overrides.fromCollateral ?? fromToken.target,
      toCollateral: overrides.toCollateral ?? toToken.target,
      flashAmount: overrides.flashAmount ?? ethers.parseUnits("1000", dstableDecimals),
      minCollateralOut: overrides.minCollateralOut ?? 0n,
      minToAmount: overrides.minToAmount ?? defaultAmountOut,
      minMinted: overrides.minMinted ?? defaultAmountOut,
      shortfallPayer: overrides.shortfallPayer ?? user1,
      useProtocolRedeem: overrides.useProtocolRedeem ?? false,
      lifiData,
    };
  };

  it("reverts when swap output is below minimum", async () => {
    const flashAmount = ethers.parseUnits("1000", dstableDecimals);
    const amountIn = ethers.parseUnits("900", fromDecimals);
    const amountOut = ethers.parseUnits("800", toDecimals); // below minToAmount we set

    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 1000);
    const lifiData = {
      callTo: await router.getAddress(),
      approveTo: await router.getAddress(),
      value: 0n,
      data: router.interface.encodeFunctionData("swap", [
        fromToken.target,
        toToken.target,
        await exchanger.getAddress(),
        amountIn,
        amountOut,
      ]),
      deadline,
      recipient: await exchanger.getAddress(),
      fromChainId: BigInt((await ethers.provider.getNetwork()).chainId),
      toChainId: BigInt((await ethers.provider.getNetwork()).chainId),
    };

    const params = {
      fromCollateral: fromToken.target,
      toCollateral: toToken.target,
      flashAmount,
      minCollateralOut: 0n,
      minToAmount: ethers.parseUnits("850", toDecimals), // higher than swap out
      minMinted: amountOut,
      shortfallPayer: user1,
      useProtocolRedeem: false,
      lifiData,
    };

    await expect(exchanger.executeFlashExchange(params)).to.be.revertedWithCustomError(exchanger, "AmountOutTooLow");
  });

  it("reverts when minted amount is below minMinted", async () => {
    const amountIn = ethers.parseUnits("900", fromDecimals);
    const amountOut = ethers.parseUnits("900", toDecimals);
    const params = await buildParams({
      minMinted: ethers.parseUnits("1000", dstableDecimals), // higher than possible mint
      minToAmount: amountOut,
      lifiData: await buildLiFiData(amountIn, amountOut),
    });

    const issuer = await ethers.getContractAt("IssuerV2", await exchanger.issuer());
    await expect(exchanger.executeFlashExchange(params)).to.be.revertedWithCustomError(issuer, "SlippageTooHigh");
  });

  it("reverts when swap recipient is not the exchanger", async () => {
    const amountIn = ethers.parseUnits("100", fromDecimals);
    const amountOut = ethers.parseUnits("100", toDecimals);
    const lifiData = await buildLiFiData(amountIn, amountOut, { recipient: user1 });
    const params = await buildParams({
      minToAmount: amountOut,
      minMinted: amountOut,
      flashAmount: ethers.parseUnits("100", dstableDecimals),
      lifiData,
    });

    await expect(exchanger.executeFlashExchange(params)).to.be.revertedWithCustomError(exchanger, "RecipientNotAllowed");
  });

  it("reverts on chainId mismatch", async () => {
    const amountIn = ethers.parseUnits("50", fromDecimals);
    const amountOut = ethers.parseUnits("50", toDecimals);
    const wrongChainId = BigInt((await ethers.provider.getNetwork()).chainId) + 1n;
    const lifiData = await buildLiFiData(amountIn, amountOut, { fromChainId: wrongChainId, toChainId: wrongChainId });
    const params = await buildParams({
      minToAmount: amountOut,
      minMinted: amountOut,
      flashAmount: ethers.parseUnits("50", dstableDecimals),
      lifiData,
    });

    await expect(exchanger.executeFlashExchange(params)).to.be.revertedWithCustomError(exchanger, "ChainIdMismatch");
  });

  it("reverts when deadline has passed", async () => {
    const amountIn = ethers.parseUnits("50", fromDecimals);
    const amountOut = ethers.parseUnits("50", toDecimals);
    const expiredDeadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp - 1);
    const lifiData = await buildLiFiData(amountIn, amountOut, { deadline: expiredDeadline });
    const params = await buildParams({
      minToAmount: amountOut,
      minMinted: amountOut,
      flashAmount: ethers.parseUnits("50", dstableDecimals),
      lifiData,
    });

    await expect(exchanger.executeFlashExchange(params)).to.be.revertedWithCustomError(exchanger, "DeadlineExpired");
  });

  it("reverts when ETH value sent does not match LiFi expectations", async () => {
    const amountIn = ethers.parseUnits("10", fromDecimals);
    const amountOut = ethers.parseUnits("10", toDecimals);
    const lifiData = await buildLiFiData(amountIn, amountOut, { value: 1n });
    const params = await buildParams({
      minToAmount: amountOut,
      minMinted: amountOut,
      flashAmount: ethers.parseUnits("10", dstableDecimals),
      lifiData,
    });

    await expect(exchanger.executeFlashExchange(params)).to.be.revertedWithCustomError(exchanger, "ValueMismatch").withArgs(1n, 0n);
  });

  it("reverts when shortfall payer is missing", async () => {
    const flashAmount = ethers.parseUnits("1000", dstableDecimals);
    const amountIn = ethers.parseUnits("900", fromDecimals);
    const amountOut = ethers.parseUnits("900", toDecimals);
    const lifiData = await buildLiFiData(amountIn, amountOut);
    const params = await buildParams({
      flashAmount,
      minToAmount: amountOut,
      minMinted: 0n, // allow minting less than flash amount
      shortfallPayer: ethers.ZeroAddress,
      lifiData,
    });

    await expect(exchanger.executeFlashExchange(params)).to.be.revertedWithCustomError(exchanger, "ShortfallNotCovered");
  });

  it("reverts when swap router is not allowlisted", async () => {
    const params = await buildParams({
      lifiData: await buildLiFiData(1n, 1n, { callTo: user1, approveTo: user1 }),
    });
    await exchanger.setSwapRouter(ethers.ZeroAddress);

    await expect(exchanger.executeFlashExchange(params)).to.be.revertedWithCustomError(exchanger, "RouterNotAllowed");
  });

  it("reverts when approveTo does not match swap router", async () => {
    const params = await buildParams({
      lifiData: await buildLiFiData(1n, 1n, { approveTo: user1 }),
    });

    await expect(exchanger.executeFlashExchange(params)).to.be.revertedWithCustomError(exchanger, "SpenderNotAllowed");
  });

  it("executes flash exchange and settles shortfall from payer", async () => {
    const flashAmount = ethers.parseUnits("1000", dstableDecimals);
    const amountIn = ethers.parseUnits("900", fromDecimals);
    const amountOut = ethers.parseUnits("900", toDecimals);
    const lifiData = await buildLiFiData(amountIn, amountOut);
    const params = await buildParams({
      flashAmount,
      minToAmount: amountOut,
      minMinted: 0n,
      lifiData,
    });

    // Allow exchanger to pull shortfall
    const user1Signer = await ethers.getSigner(user1);
    await dstable.connect(user1Signer).approve(await exchanger.getAddress(), flashAmount);

    const vaultAddress = (await hre.deployments.get(DUSD_COLLATERAL_VAULT_CONTRACT_ID)).address;
    const vaultFromBefore = await fromToken.balanceOf(vaultAddress);
    const vaultToBefore = await toToken.balanceOf(vaultAddress);
    const payerBalanceBefore = await dstable.balanceOf(user1);

    const tx = await exchanger.executeFlashExchange(params);
    const receipt = await tx.wait();

    const event = receipt!.logs
      .map((log) => {
        try {
          return exchanger.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed && parsed.name === "FlashExchangeExecuted");
    expect(event, "FlashExchangeExecuted event missing").to.not.be.undefined;
    const minted = event!.args[4] as bigint;
    const fee = event!.args[5] as bigint;
    const shortfall = event!.args[6] as bigint;
    const emittedFlashAmount = event!.args[3] as bigint;

    const payerBalanceAfter = await dstable.balanceOf(user1);
    expect(payerBalanceBefore - payerBalanceAfter).to.equal(shortfall);
    expect(minted + shortfall).to.equal(emittedFlashAmount + fee, "minted + shortfall should cover flash amount + fee");

    const vaultFromAfter = await fromToken.balanceOf(vaultAddress);
    const vaultToAfter = await toToken.balanceOf(vaultAddress);
    const deltaFrom = vaultFromBefore - vaultFromAfter;
    expect(deltaFrom).to.be.gte(amountIn, "redeemer should supply at least the swap input");
    expect(vaultToAfter).to.equal(vaultToBefore + amountOut, "toCollateral should increase by swap output");
    expect(await dstable.balanceOf(await exchanger.getAddress())).to.equal(0, "exchanger should not retain dStable");
  });

  it("rejects flash loan callbacks when the initiator is not the exchanger", async () => {
    const amountIn = ethers.parseUnits("1", fromDecimals);
    const amountOut = ethers.parseUnits("1", toDecimals);
    const params = await buildParams({
      flashAmount: ethers.parseUnits("1", dstableDecimals),
      minToAmount: amountOut,
      minMinted: amountOut,
      lifiData: await buildLiFiData(amountIn, amountOut),
    });
    const data = ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "tuple(address fromCollateral,address toCollateral,uint256 flashAmount,uint256 minCollateralOut,uint256 minToAmount,uint256 minMinted,address shortfallPayer,bool useProtocolRedeem,tuple(address callTo,address approveTo,uint256 value,bytes data,uint256 deadline,address recipient,uint256 fromChainId,uint256 toChainId) lifiData)",
      ],
      [params],
    );

    const dstableWithFlash = await ethers.getContractAt("ERC20StablecoinUpgradeable", dstable.target, await ethers.getSigner(deployer));

    await expect(
      dstableWithFlash.flashLoan(exchanger, dstable.target, ethers.parseUnits("1", dstableDecimals), data),
    ).to.be.revertedWithCustomError(exchanger, "InvalidInitiator");
  });

  it("rejects direct callback invocation by non-lender", async () => {
    const data = ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "tuple(address fromCollateral,address toCollateral,uint256 flashAmount,uint256 minCollateralOut,uint256 minToAmount,uint256 minMinted,address shortfallPayer,bool useProtocolRedeem,tuple(address callTo,address approveTo,uint256 value,bytes data,uint256 deadline,address recipient,uint256 fromChainId,uint256 toChainId) lifiData)",
      ],
      [
        {
          fromCollateral: fromToken.target,
          toCollateral: toToken.target,
          flashAmount: 0,
          minCollateralOut: 0,
          minToAmount: 0,
          minMinted: 0,
          shortfallPayer: user1,
          useProtocolRedeem: false,
          lifiData: {
            callTo: await router.getAddress(),
            approveTo: await router.getAddress(),
            value: 0,
            data: "0x",
            deadline: 0,
            recipient: await exchanger.getAddress(),
            fromChainId: 0,
            toChainId: 0,
          },
        },
      ],
    );

    await expect(exchanger.onFlashLoan(await exchanger.getAddress(), dstable.target, 0, 0, data)).to.be.revertedWithCustomError(
      exchanger,
      "NotFlashLender",
    );
  });
});
