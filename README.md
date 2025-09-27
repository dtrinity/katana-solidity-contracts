# dTRINITY Ethereum Contracts

This repository contains the code and tooling for dTRINITY on Ethereum.

Website: https://dtrinity.org/

Documentation: https://docs.dtrinity.org/

## Manifest-Driven Role Maintenance

This repository relies on the shared role runner (`@dtrinity/shared-hardhat-tools`) to migrate `Ownable` ownership and `DEFAULT_ADMIN_ROLE` assignments to the governance Safe. The manifest for Katana mainnet lives at `manifests/katana-mainnet-roles.json`.

Quick commands:

```bash
# Enforce drift checks against the manifest
make roles.scan

# Preview planned ownership + default-admin transfers
make roles.transfer.plan

# Execute transfers (set YES=1 to skip the confirmation prompt)
make roles.transfer.run YES=1

# Preview Safe revoke batch (requires manifest.safe configuration)
make roles.revoke.plan

# Queue Safe revocations
make roles.revoke.run YES=1
```

The targets default to `katana_mainnet`. Override with `make roles.scan ROLE_NETWORK=katana_testnet ROLE_MANIFEST=manifests/katana-testnet-roles.json` when needed.

Each Hardhat network defines `roles.deployer` and `roles.governance` inside `hardhat.config.ts`; the shared runner falls back to those values, and refuses to execute if neither the network config nor the CLI provides addresses.
