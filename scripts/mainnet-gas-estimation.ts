#!/usr/bin/env tsx

import { promises as fs } from "fs";
import path from "path";

// Command line argument parsing
const args = process.argv.slice(2);
const gasPriceArg = args.find((arg) => arg.startsWith("--gas-price="))?.split("=")[1];
const ethPriceArg = args.find((arg) => arg.startsWith("--eth-price="))?.split("=")[1];
const multiplierArg = args.find((arg) => arg.startsWith("--multiplier="))?.split("=")[1];
const formatArg = args.find((arg) => arg.includes("--json")) ? "json" : "table";

interface DeploymentReceipt {
  gasUsed: string;
  transactionHash: string;
  contractAddress?: string;
  from: string;
  to: string | null;
}

interface DeploymentArtifact {
  address: string;
  abi: any[];
  receipt: DeploymentReceipt;
  transactionHash: string;
  metadata?: any;
}

interface GasEstimationResult {
  contractName: string;
  gasUsed: bigint;
  estimatedMainnetGas: bigint;
  estimatedCostWei: bigint;
  estimatedCostETH: number;
  estimatedCostUSD: number;
}

interface SummaryStats {
  totalGasUsed: bigint;
  totalEstimatedMainnetGas: bigint;
  totalEstimatedCostWei: bigint;
  totalEstimatedCostETH: number;
  totalEstimatedCostUSD: number;
  contractCount: number;
}

// Gas cost assumptions (configurable via CLI)
// Note: Katana uses vbETH as native token, not ETH
// Based on user's testnet experience (<0.05 vbETH for ~36M gas deployment)
// Calculation: 0.05 vbETH / 36,090,381 gas ≈ 1.39e-9 vbETH/gas = ~1.4 gwei
// Using conservative 2 gwei default for mainnet (higher than testnet)
const GAS_MULTIPLIER = parseFloat(multiplierArg || "1.0"); // Usually 1.0 since gas usage is fixed
const AVERAGE_GAS_PRICE_GWEI = parseFloat(gasPriceArg || "2"); // Conservative estimate based on real testnet usage
const VBETH_USD_PRICE = parseFloat(ethPriceArg || "2500"); // vbETH price in USD (assuming pegged to ETH)

/**
 * Parse gas usage from deployment artifact
 */
function parseGasUsage(artifact: DeploymentArtifact): bigint {
  return BigInt(artifact.receipt.gasUsed);
}

/**
 * Calculate gas cost estimation (with optional multiplier for network differences)
 */
function estimateGas(testnetGas: bigint): bigint {
  return BigInt(Math.ceil(Number(testnetGas) * GAS_MULTIPLIER));
}

/**
 * Calculate cost in wei
 */
function calculateCostWei(gasUsed: bigint, gasPriceGwei: number = AVERAGE_GAS_PRICE_GWEI): bigint {
  const gasPriceWei = BigInt(gasPriceGwei * 1e9); // Convert gwei to wei
  return gasUsed * gasPriceWei;
}

/**
 * Calculate cost in ETH
 */
function calculateCostETH(costWei: bigint): number {
  return Number(costWei) / 1e18;
}

/**
 * Calculate cost in USD
 */
function calculateCostUSD(costVbETH: number, vbethPrice: number = VBETH_USD_PRICE): number {
  return costVbETH * vbethPrice;
}

/**
 * Read and parse deployment artifact
 */
async function readDeploymentArtifact(filePath: string): Promise<DeploymentArtifact | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error);
    return null;
  }
}

/**
 * Get all deployment files from testnet directory
 */
async function getDeploymentFiles(testnetDir: string): Promise<string[]> {
  try {
    const files = await fs.readdir(testnetDir);
    return files.filter((file) => file.endsWith(".json") && !file.startsWith(".")).map((file) => path.join(testnetDir, file));
  } catch (error) {
    console.error("Error reading deployment directory:", error);
    return [];
  }
}

/**
 * Categorize contracts by type
 */
function categorizeContract(contractName: string): string {
  if (contractName.includes("Proxy")) return "Proxy Contracts";
  if (contractName.includes("Implementation")) return "Implementation Contracts";
  if (contractName.includes("Oracle") || contractName.includes("Wrapper")) return "Oracle Contracts";
  if (contractName.includes("Issuer")) return "Issuer Contracts";
  if (contractName.includes("Redeemer")) return "Redeemer Contracts";
  if (contractName.includes("AmoManager")) return "AMO Manager Contracts";
  if (contractName.includes("CollateralHolderVault")) return "Vault Contracts";
  if (contractName.includes("DStake")) return "Staking Contracts";
  if (contractName.includes("Mock")) return "Mock Contracts";
  if (
    contractName.includes("USDC") ||
    contractName.includes("USDT") ||
    contractName.includes("AUSD") ||
    contractName.includes("WETH") ||
    contractName.includes("stETH") ||
    contractName.includes("frxUSD") ||
    contractName.includes("sfrxUSD") ||
    contractName.includes("yUSD")
  ) {
    return "Token Contracts";
  }
  return "Other Contracts";
}

/**
 * Main estimation function
 */
async function estimateMainnetDeploymentCost(): Promise<void> {
  const testnetDir = path.join(__dirname, "..", "deployments", "katana_testnet");
  const deploymentFiles = await getDeploymentFiles(testnetDir);

  console.log("🚀 Katana Deployment Gas Cost Estimation Script");
  console.log("================================================\n");

  // Show usage if requested
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: tsx scripts/mainnet-gas-estimation.ts [options]");
    console.log("");
    console.log("Options:");
    console.log("  --gas-price=<gwei>    Average gas price in gwei (default: 2)");
    console.log("  --eth-price=<usd>     vbETH price in USD (default: 2500)");
    console.log("  --multiplier=<float>  Gas usage multiplier (default: 1.0)");
    console.log("  --json                Output in JSON format");
    console.log("  --help, -h            Show this help message");
    console.log("");
    return;
  }

  console.log(`📁 Found ${deploymentFiles.length} deployment files in testnet directory`);
  console.log(`⚙️  Using parameters:`);
  console.log(`   • Gas Multiplier: ${GAS_MULTIPLIER}x`);
  console.log(`   • Gas Price: ${AVERAGE_GAS_PRICE_GWEI} gwei`);
  console.log(`   • vbETH Price: $${VBETH_USD_PRICE} USD\n`);

  const results: GasEstimationResult[] = [];
  const categories: { [key: string]: GasEstimationResult[] } = {};

  // Process each deployment file
  for (const filePath of deploymentFiles) {
    const contractName = path.basename(filePath, ".json");
    const artifact = await readDeploymentArtifact(filePath);

    if (!artifact || !artifact.receipt) {
      console.warn(`⚠️  Skipping ${contractName} - no receipt data found`);
      continue;
    }

    const gasUsed = parseGasUsage(artifact);
    const estimatedMainnetGas = estimateGas(gasUsed);
    const estimatedCostWei = calculateCostWei(estimatedMainnetGas);
    const estimatedCostETH = calculateCostETH(estimatedCostWei);
    const estimatedCostUSD = calculateCostUSD(estimatedCostETH);

    const result: GasEstimationResult = {
      contractName,
      gasUsed,
      estimatedMainnetGas,
      estimatedCostWei,
      estimatedCostETH,
      estimatedCostUSD,
    };

    results.push(result);

    // Categorize by contract type
    const category = categorizeContract(contractName);
    if (!categories[category]) {
      categories[category] = [];
    }
    categories[category].push(result);
  }

  // Sort results by gas usage (descending)
  results.sort((a, b) => Number(b.gasUsed - a.gasUsed));

  // Display individual contract costs
  console.log("📊 Individual Contract Gas Costs:");
  console.log("==================================");

  console.log("┌─────────────────────────────────────────────────┬─────────────┬─────────────┬────────────┬─────────────┐");
  console.log("│ Contract Name                                   │ Testnet Gas │ Est. Gas   │ Cost (vbETH) │ Cost (USD) │");
  console.log("├─────────────────────────────────────────────────┼─────────────┼─────────────┼────────────┼─────────────┤");

  for (const result of results) {
    const name = result.contractName.padEnd(47);
    const testnetGas = result.gasUsed.toLocaleString().padStart(11);
    const mainnetGas = result.estimatedMainnetGas.toLocaleString().padStart(11);
    const ethCost = result.estimatedCostETH.toFixed(6).padStart(10);
    const usdCost = result.estimatedCostUSD.toFixed(2).padStart(11);

    console.log(`│ ${name} │ ${testnetGas} │ ${mainnetGas} │ ${ethCost} │ $ ${usdCost} │`);
  }

  console.log("└─────────────────────────────────────────────────┴─────────────┴─────────────┴────────────┴─────────────┘\n");

  // Display category summaries
  console.log("📈 Category Breakdown:");
  console.log("=====================");

  const categoryNames = Object.keys(categories).sort();

  for (const categoryName of categoryNames) {
    const categoryResults = categories[categoryName];
    const categorySummary = categoryResults.reduce(
      (acc, result) => ({
        gasUsed: acc.gasUsed + result.gasUsed,
        estimatedMainnetGas: acc.estimatedMainnetGas + result.estimatedMainnetGas,
        estimatedCostETH: acc.estimatedCostETH + result.estimatedCostETH,
        estimatedCostUSD: acc.estimatedCostUSD + result.estimatedCostUSD,
        count: acc.count + 1,
      }),
      {
        gasUsed: 0n,
        estimatedMainnetGas: 0n,
        estimatedCostETH: 0,
        estimatedCostUSD: 0,
        count: 0,
      }
    );

    console.log(`\n${categoryName} (${categorySummary.count} contracts):`);
    console.log(`  Total Testnet Gas: ${categorySummary.gasUsed.toLocaleString()}`);
    console.log(`  Estimated Mainnet Gas: ${categorySummary.estimatedMainnetGas.toLocaleString()}`);
    console.log(
      `  Estimated Cost: ${categorySummary.estimatedCostETH.toFixed(6)} ETH ($${categorySummary.estimatedCostUSD.toFixed(2)} USD)`
    );
  }

  // Calculate and display totals
  const summary: SummaryStats = results.reduce(
    (acc, result) => ({
      totalGasUsed: acc.totalGasUsed + result.gasUsed,
      totalEstimatedMainnetGas: acc.totalEstimatedMainnetGas + result.estimatedMainnetGas,
      totalEstimatedCostWei: acc.totalEstimatedCostWei + result.estimatedCostWei,
      totalEstimatedCostETH: acc.totalEstimatedCostETH + result.estimatedCostETH,
      totalEstimatedCostUSD: acc.totalEstimatedCostUSD + result.estimatedCostUSD,
      contractCount: acc.contractCount + 1,
    }),
    {
      totalGasUsed: 0n,
      totalEstimatedMainnetGas: 0n,
      totalEstimatedCostWei: 0n,
      totalEstimatedCostETH: 0,
      totalEstimatedCostUSD: 0,
      contractCount: 0,
    }
  );

  console.log("\n🏆 Grand Total:");
  console.log("==============");
  console.log(`📋 Total Contracts: ${summary.contractCount}`);
  console.log(`⛽ Total Testnet Gas Used: ${summary.totalGasUsed.toLocaleString()}`);
  console.log(`🚀 Estimated Mainnet Gas: ${summary.totalEstimatedMainnetGas.toLocaleString()}`);
  console.log(`💰 Estimated Cost: ${summary.totalEstimatedCostETH.toFixed(6)} vbETH`);
  console.log(`💵 Estimated Cost: $${summary.totalEstimatedCostUSD.toFixed(2)} USD`);

  console.log("\n📝 Assumptions:");
  console.log("==============");
  console.log(`• Gas multiplier: ${GAS_MULTIPLIER}x (1.0 = same gas usage)`);
  console.log(`• Average gas price: ${AVERAGE_GAS_PRICE_GWEI} gwei`);
  console.log(`• vbETH price: $${VBETH_USD_PRICE} USD (Katana native token)`);
  console.log(`• Estimates are conservative and actual costs may vary`);

  console.log("\n⚠️  Important Notes:");
  console.log("==================");
  console.log("• Gas prices fluctuate - monitor Katana gas prices before deployment");
  console.log("• Consider network congestion and deploy during optimal times");
  console.log("• Account for additional costs (verification, initial interactions)");
  console.log("• vbETH price may differ from ETH price - check current market rates");
  console.log("• Only use gas multiplier > 1.0 if expecting different EVM implementations");
  console.log("• Default 2 gwei based on real testnet usage (<0.05 vbETH for 36M gas)");
}

// Run the estimation
if (require.main === module) {
  estimateMainnetDeploymentCost().catch(console.error);
}

export { estimateMainnetDeploymentCost };
