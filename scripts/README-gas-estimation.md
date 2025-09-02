# Katana Deployment Gas Cost Estimation Script

This script analyzes Katana testnet deployment artifacts and estimates the gas costs for deploying the same contracts to Katana mainnet.

## Important Notes About Gas Calculations

### Gas Usage vs Gas Price
- **Gas Usage**: The computational work required (usually fixed for the same bytecode)
- **Gas Price**: The cost per unit of gas (fluctuates based on network demand)
- **Gas Multiplier**: Only use if expecting different EVM implementations between testnet/mainnet

### Katana Network Specifics
- **Native Token**: vbETH (Virtual Bitcoin ETH), not ETH
- **Gas Model**: EVM-compatible but may have different pricing than Ethereum
- **Chain ID**: 747474 (different from Ethereum mainnet)
- **Testnet Gas Price**: Based on real usage, appears to be ~1-2 gwei (much lower than Ethereum)

## Quick Start

```bash
# Basic usage with default parameters
npx tsx scripts/mainnet-gas-estimation.ts

# With custom parameters
npx tsx scripts/mainnet-gas-estimation.ts --gas-price=30 --eth-price=2800 --multiplier=1.8

# Get help
npx tsx scripts/mainnet-gas-estimation.ts --help
```

## Parameters

| Parameter              | Default | Description                                               |
| ---------------------- | ------- | --------------------------------------------------------- |
| `--gas-price=<gwei>`   | 2       | Average Katana gas price in gwei (based on testnet usage) |
| `--eth-price=<usd>`    | 2500    | Current vbETH price in USD (ETH peg)                      |
| `--multiplier=<float>` | 1.0     | Gas usage multiplier (1.0 = same usage)                   |
| `--json`               | -       | Output in JSON format instead of table                    |
| `--help`, `-h`         | -       | Show help message                                         |

## Example Outputs

### Conservative Estimate (Default)
- **Total Gas**: ~36M gas
- **Cost**: ~0.072 vbETH (~$180 USD)

### High Gas Price Scenario
```bash
npm run gas-estimate -- --gas-price=10 --eth-price=3000 --multiplier=1.0
```
- **Total Gas**: ~36M gas
- **Cost**: ~0.361 vbETH (~$1,083 USD)

### Low Gas Price Scenario
```bash
npm run gas-estimate -- --gas-price=1 --eth-price=2000 --multiplier=1.0
```
- **Total Gas**: ~36M gas
- **Cost**: ~0.036 vbETH (~$72 USD)

## Cost Breakdown by Category

The script provides detailed breakdowns by contract type:

- **Implementation Contracts**: Core dStable logic (~$432 USD)
- **Oracle Contracts**: Price feeds and aggregators (~$575 USD)
- **Vault Contracts**: Collateral management (~$242 USD)
- **Token Contracts**: ERC-20 tokens (~$343 USD)
- **Proxy Contracts**: Upgradeable proxy patterns (~$189 USD)

## Important Notes

1. **Gas Price Volatility**: Mainnet gas prices fluctuate significantly. Monitor current prices before deployment.

2. **Network Congestion**: Deploy during off-peak hours for lower costs.

3. **Additional Costs**: This estimate covers only contract deployment. Additional costs include:
   - Contract verification on Etherscan
   - Initial contract interactions/setup
   - Multi-sig transaction fees

4. **Accuracy**: Estimates are based on testnet gas usage and may vary by 20-50% on mainnet due to:
   - Different network conditions
   - Code optimizations
   - Solidity compiler differences

## Methodology

1. **Data Source**: Parses deployment artifacts from `deployments/katana_testnet/`
2. **Gas Multiplier**: Applies configurable multiplier to account for mainnet efficiency differences
3. **Cost Calculation**: `gas_used × gas_price × eth_price`
4. **Categorization**: Groups contracts by functionality for better analysis

## Integration

You can integrate this script into your deployment pipeline:

```typescript
import { estimateMainnetDeploymentCost } from './scripts/mainnet-gas-estimation';

// Use in automated deployment checks
await estimateMainnetDeploymentCost();
```

## Contributing

When adding new contracts:
1. Deploy to testnet first
2. Run this script to update cost estimates
3. Update documentation with new cost ranges
