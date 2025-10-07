# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

**dTRINITY** is a DeFi protocol implementing two core financial primitives:
- **dSTABLE**: Overcollateralized stablecoins (dETH, dUSD) with AMO mechanisms
- **dSTAKE**: ERC4626 yield vaults that allocate dSTABLE assets across multiple strategies

## Essential Commands

### Build & Test
```bash
# Compile contracts (uses Hardhat with Solidity 0.8.20/0.8.22)
make compile

# Run all tests
make test

# Run specific test file
yarn hardhat test test/path/to/specific-test.ts

# Clean build artifacts
make clean
```

### Code Quality
```bash
# Lint all code (Solidity + TypeScript)
make lint

# Security analysis
make slither        # Static analysis
make mythril        # Symbolic execution
make audit          # Full audit (both tools)
```

### Deployment for local testing
```bash
# Uses a temporary in-memory network
make deploy
```

## Architecture Key Points

### Contract Structure
The protocol separates concerns into distinct subsystems:

1. **dSTABLE System** (`/contracts/deth/`)
   - `IssuerV2` mints stablecoins against collateral
   - `RedeemerV2` handles redemptions with dynamic fees
   - `CollateralHolderVault` stores collateral and enables exchanges
   - AMO vaults implement capital efficiency strategies

2. **dSTAKE System** (`/contracts/vaults/dstake/`)
   - `DStakeTokenV2` implements ERC4626 with withdrawal fees
   - `DStakeRouterV2` orchestrates deterministic strategy allocation
   - `DStakeCollateralVaultV2` stores strategy shares with enumeration
   - Adapters in `/adapters/` integrate yield protocols (Morpho, Aave, Pendle)
   - Read contracts/vaults/dstake/dstake-design.md for more in-depth explainer

### Critical Design Patterns
- **Upgradeability**: Core tokens use proxy patterns; infrastructure contracts are immutable
- **Access Control**: Role-based permissions via OpenZeppelin AccessControl
- **Oracle Integration**: Configurable price feeds through `OracleAggregatorV2`
- **Deterministic Allocation**: Router uses fixed strategy ordering for predictable deposits/withdrawals
- **Fee Management**: Multiple fee types (withdrawal, performance, management) with reinvestment

### Development Considerations
- **Stack Deep Issues**: Complex contracts require `VIA_IR=true` compilation
- **Testing Strategy**: Mock external protocols in `/contracts/mocks/` for isolated testing
- **Gas Optimization**: Use `immutable` for deployment-time constants, minimize storage reads
- **Security**: All critical functions have reentrancy guards and pause mechanisms
