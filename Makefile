# Make 'help' the default target
.DEFAULT_GOAL := help

help: ## Show this help menu
	@echo "Usage:"
	@grep -E '^[a-zA-Z_.-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

#############
## Linting ##
#############

lint: lint.solidity lint.typescript ## Run the linters

lint.ci: ## Lint but don't fix
	@yarn prettier --check --plugin=prettier-plugin-solidity 'contracts/**/*.sol'
	@yarn solhint "contracts/**/*.sol"
	@yarn eslint .

lint.solidity: ## Run the solidity linter
	@yarn prettier --write --plugin=prettier-plugin-solidity 'contracts/**/*.sol'
	@yarn solhint "contracts/**/*.sol"

lint.typescript: ## Run the typescript linter
	@yarn eslint . --fix

##############
## Testing ##
##############

test: test.hardhat test.typescript ## Run all tests

test.ci: test.hardhat test.typescript.unit ## Run all deterministic tests in CI mode

test.typescript: test.typescript.unit test.typescript.integ ## Run the typescript tests

test.typescript.unit: ## Run the typescript unit tests
	@yarn jest --detectOpenHandles --testPathPattern=test\\.unit\\.ts --passWithNoTests

test.typescript.integ: ## Run the typescript integration tests
	@yarn jest --detectOpenHandles --testPathPattern=test\\.integ\\.ts --passWithNoTests

test.hardhat: ## Run the hardhat tests
	@yarn hardhat test

######################
## Static Analysis ##
######################

slither: ## Run Slither static analysis on all contracts with summaries and loc
	@echo "Running Slither static analysis..."
	@mkdir -p reports/slither
	@mkdir -p reports
	@echo "Generating JSON report..."
	@slither . --config-file slither.config.json \
		--filter-paths "contracts/dlend,contracts/mocks,contracts/testing" \
		--json reports/slither/slither-report.json || true
	@echo "Generating human-readable summary..."
	@slither . --config-file slither.config.json \
		--filter-paths "contracts/dlend,contracts/mocks,contracts/testing" \
		--print human-summary \
		--disable-color > reports/slither-summary.md 2>&1 || true
	@echo "Results saved to reports/slither/slither-report.json and reports/slither-summary.md"

slither.check: ## Run Slither with fail-on-high severity with summaries and loc
	@echo "Running Slither with strict checks..."
	@mkdir -p reports/slither
	@mkdir -p reports
	@slither . --config-file slither.config.json --fail-high \
		--filter-paths "contracts/dlend,contracts/mocks,contracts/testing" \
		--print human-summary \
		--print contract-summary \
		--print loc \
		--json reports/slither/slither-report.json

slither.focused: ## Run Slither on specific contract with summaries and loc (usage: make slither.focused contract=ContractName)
	@if [ "$(contract)" = "" ]; then \
		echo "Must provide 'contract' argument. Example: 'make slither.focused contract=contracts/dlend/core/protocol/pool/Pool.sol'"; \
		exit 1; \
	fi
	@echo "Running Slither on $(contract)..."
	@mkdir -p reports/slither
	@mkdir -p reports
	@slither $(contract) --config-file slither.config.json \
		--filter-paths "contracts/dlend,contracts/mocks,contracts/testing" \
		--print human-summary \
		--print contract-summary \
		--print loc \
		--json reports/slither/slither-focused-report.json

mythril: ## Run Mythril security analysis on all contracts
	@echo "Running Mythril security analysis on all contracts..."
	@./scripts/mythril/run_mythril.py --max-workers 8 --timeout 300 --max-depth 18

	@echo "Generating Mythril analysis summary..."
	@./scripts/mythril/generate_summary.py

mythril.focused: ## Run Mythril on specific contract (usage: make mythril.focused contract=ContractName)
	@if [ "$(contract)" = "" ]; then \
		echo "Must provide 'contract' argument. Example: 'make mythril.focused contract=contracts/dlend/core/protocol/pool/Pool.sol'"; \
		exit 1; \
	fi
	@echo "Running Mythril analysis on $(contract)..."
	@./scripts/mythril/run_mythril.py --contract "$(contract)" --timeout 300 -t 10 --max-depth 18 --call-depth-limit 8

mythril.summary: ## Generate summary from existing Mythril results
	@echo "Generating Mythril analysis summary..."
	@./scripts/mythril/generate_summary.py

audit: slither mythril ## Run full security analysis (Slither + full Mythril)
	@echo "Full security analysis completed!"

################
## Deployment ##
################

deploy: ## Deploy the contracts
	@yarn hardhat deploy

clean-deployments: ## Clean the deployments for a given network which matches at least one keyword in the deployment_keywords
	@if [ "$(network)" = "" ]; then \
		echo "Must provide 'network' argument"; \
		exit 1; \
	fi
	@if [ "$(deployment_keywords)" = "" ]; then \
		echo "Must provide 'deployment_keywords' argument. Example: 'deployment_keywords=ContractA,ContractB,PrefixC,PostfixD'"; \
		exit 1; \
	fi
	@echo "Resetting deployments for $(network)"
	@./scripts/deployment/clean-deployments.sh $(deployment_keywords) $(network)

####################
## Block explorer ##
####################

explorer.verify.katana_testnet:
	@echo "Verifying contracts on Katana testnet (Bokuto)..."
	@yarn hardhat --network katana_testnet etherscan-verify --api-key $${ETHERSCAN_API_KEY} --api-url https://api.etherscan.io/v2/api

explorer.verify.katana_mainnet:
	@echo "Verifying contracts on Katana mainnet..."
	@yarn hardhat --network katana_mainnet etherscan-verify --api-key $${ETHERSCAN_API_KEY} --api-url https://api.etherscan.io/v2/api

##############
## Building ##
##############

compile: ## Compile the contracts
	@yarn hardhat compile

clean: ## When renaming directories or files, run this to clean up
	@rm -rf typechain-types
	@rm -rf artifacts
	@rm -rf cache
	@echo "Cleaned solidity cache and artifacts. Remember to recompile."


####################
## Role Operations ##
####################

ROLE_NETWORK    ?= katana_mainnet
ROLE_MANIFEST   ?= manifests/katana-mainnet-roles.json
ROLE_TS_NODE    = TS_NODE_TRANSPILE_ONLY=1 npx ts-node --project node_modules/@dtrinity/shared-hardhat-tools/tsconfig.json
ROLE_SCRIPT_DIR = node_modules/@dtrinity/shared-hardhat-tools/scripts/roles

roles.scan: ## Scan deployments and enforce manifest coverage (pass EXTRA="--no-drift-check" to skip guardrail)
	@$(ROLE_TS_NODE) $(ROLE_SCRIPT_DIR)/scan-roles.ts \
		-n $(ROLE_NETWORK) \
		--manifest $(ROLE_MANIFEST) \
		--drift-check $(EXTRA)

roles.transfer.plan: ## Dry-run ownership + DEFAULT_ADMIN_ROLE transfers
	@$(ROLE_TS_NODE) $(ROLE_SCRIPT_DIR)/transfer-roles.ts \
		-n $(ROLE_NETWORK) \
		-m $(ROLE_MANIFEST) \
		--dry-run-only $(EXTRA)

roles.transfer.run: ## Execute ownership + DEFAULT_ADMIN_ROLE transfers (set YES=1 to skip confirmation)
	@$(ROLE_TS_NODE) $(ROLE_SCRIPT_DIR)/transfer-roles.ts \
		-n $(ROLE_NETWORK) \
		-m $(ROLE_MANIFEST) \
		$(if $(YES),--yes) $(EXTRA)

roles.revoke.plan: ## Dry-run Safe revoke batch creation
	@$(ROLE_TS_NODE) $(ROLE_SCRIPT_DIR)/revoke-roles.ts \
		-n $(ROLE_NETWORK) \
		-m $(ROLE_MANIFEST) \
		--dry-run-only $(EXTRA)

roles.revoke.run: ## Queue Safe revoke transactions (set YES=1 to skip confirmation)
	@$(ROLE_TS_NODE) $(ROLE_SCRIPT_DIR)/revoke-roles.ts \
		-n $(ROLE_NETWORK) \
		-m $(ROLE_MANIFEST) \
		$(if $(YES),--yes) $(EXTRA)

.PHONY: help compile test deploy clean slither slither.check slither.focused mythril mythril.focused mythril.deep mythril.fast mythril.force mythril.summary audit roles.scan roles.transfer.plan roles.transfer.run roles.revoke.plan roles.revoke.run
