// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title MockMetaMorphoVault
 * @notice Mock implementation of a MetaMorpho vault for testing
 * @dev Simulates a MetaMorpho vault with configurable yield generation
 *      This mock allows testing of integrations without deploying to mainnet
 */
contract MockMetaMorphoVault is ERC4626 {
  using Math for uint256;

  // --- State ---
  uint256 public mockTotalAssets;
  uint256 public yieldRate = 10000; // 100% APY in basis points (for easy testing)
  uint256 public lastYieldUpdate;
  
  // Tracking for security testing
  mapping(address => uint256) public lastDepositTimestamp;
  
  // Mock behaviors for testing edge cases
  bool public mockPaused = false;
  bool public mockRevertOnDeposit = false;
  bool public mockRevertOnWithdraw = false;
  uint256 public mockDepositFee = 0; // in basis points
  uint256 public mockWithdrawFee = 0; // in basis points

  // --- Events ---
  event YieldAccrued(uint256 amount);
  event MockBehaviorSet(string behavior, bool value);

  // --- Constructor ---
  constructor(
    IERC20 _asset,
    string memory _name,
    string memory _symbol
  ) ERC20(_name, _symbol) ERC4626(_asset) {
    lastYieldUpdate = block.timestamp;
  }

  // --- Mock Controls ---
  
  /**
   * @notice Set the yield rate for testing
   * @param _rate Yield rate in basis points (10000 = 100% APY)
   */
  function setYieldRate(uint256 _rate) external {
    yieldRate = _rate;
  }

  /**
   * @notice Pause the vault for testing error conditions
   */
  function setPaused(bool _paused) external {
    mockPaused = _paused;
    emit MockBehaviorSet("paused", _paused);
  }

  /**
   * @notice Set mock fees for testing
   */
  function setFees(uint256 _depositFee, uint256 _withdrawFee) external {
    require(_depositFee <= 1000, "Fee too high"); // Max 10%
    require(_withdrawFee <= 1000, "Fee too high"); // Max 10%
    mockDepositFee = _depositFee;
    mockWithdrawFee = _withdrawFee;
  }

  /**
   * @notice Set revert behaviors for testing error handling
   */
  function setRevertBehaviors(bool _revertOnDeposit, bool _revertOnWithdraw) external {
    mockRevertOnDeposit = _revertOnDeposit;
    mockRevertOnWithdraw = _revertOnWithdraw;
    emit MockBehaviorSet("revertOnDeposit", _revertOnDeposit);
    emit MockBehaviorSet("revertOnWithdraw", _revertOnWithdraw);
  }

  /**
   * @notice Manually trigger yield accrual for testing
   */
  function accrueYield() public {
    if (block.timestamp > lastYieldUpdate && totalSupply() > 0) {
      uint256 timeElapsed = block.timestamp - lastYieldUpdate;
      uint256 currentAssets = mockTotalAssets;
      
      // Simple interest calculation for predictable testing
      // yield = principal * rate * time / (365 days * 10000)
      uint256 yield = (currentAssets * yieldRate * timeElapsed) / (365 days * 10000);
      
      if (yield > 0) {
        mockTotalAssets += yield;
        emit YieldAccrued(yield);
      }
      
      lastYieldUpdate = block.timestamp;
    }
  }

  /**
   * @notice Simulate a large deposit/withdrawal to test slippage
   */
  function simulateSlippage(int256 assetChange) external {
    if (assetChange > 0) {
      mockTotalAssets += uint256(assetChange);
    } else {
      uint256 decrease = uint256(-assetChange);
      if (decrease >= mockTotalAssets) {
        mockTotalAssets = 0; // Can't go negative
      } else {
        mockTotalAssets -= decrease;
      }
    }
  }

  // --- ERC4626 Overrides ---

  function totalAssets() public view virtual override returns (uint256) {
    // Don't auto-calculate yield - require explicit accrueYield() call for testing
    return mockTotalAssets;
  }

  function deposit(uint256 assets, address receiver) public virtual override returns (uint256) {
    require(!mockPaused, "Vault paused");
    require(!mockRevertOnDeposit, "Mock revert");
    
    // Apply deposit fee if set
    uint256 assetsAfterFee = assets;
    if (mockDepositFee > 0) {
      uint256 fee = (assets * mockDepositFee) / 10000;
      assetsAfterFee = assets - fee;
    }
    
    // Accrue yield before deposit
    accrueYield();
    
    // Track deposit timestamp for testing time-based attacks
    lastDepositTimestamp[receiver] = block.timestamp;
    
    uint256 shares = previewDeposit(assetsAfterFee);
    _deposit(_msgSender(), receiver, assets, shares);
    
    mockTotalAssets += assetsAfterFee;
    
    return shares;
  }

  function mint(uint256 shares, address receiver) public virtual override returns (uint256) {
    require(!mockPaused, "Vault paused");
    require(!mockRevertOnDeposit, "Mock revert");
    
    accrueYield();
    
    uint256 assets = previewMint(shares);
    
    // Apply deposit fee if set
    if (mockDepositFee > 0) {
      uint256 fee = (assets * mockDepositFee) / 10000;
      assets = assets + fee; // User needs to provide more assets to mint exact shares
    }
    
    lastDepositTimestamp[receiver] = block.timestamp;
    
    _deposit(_msgSender(), receiver, assets, shares);
    mockTotalAssets += assets - ((mockDepositFee > 0) ? (assets * mockDepositFee) / 10000 : 0);
    
    return assets;
  }

  function withdraw(
    uint256 assets,
    address receiver,
    address owner
  ) public virtual override returns (uint256) {
    require(!mockPaused, "Vault paused");
    require(!mockRevertOnWithdraw, "Mock revert");
    
    accrueYield();
    
    // Apply withdraw fee if set
    uint256 assetsToUser = assets;
    if (mockWithdrawFee > 0) {
      uint256 fee = (assets * mockWithdrawFee) / 10000;
      assetsToUser = assets - fee;
    }
    
    uint256 shares = previewWithdraw(assets);
    
    // Check for sandwich attack protection (optional test)
    if (lastDepositTimestamp[owner] > 0) {
      // Could implement a minimum holding period here for testing
    }
    
    _withdraw(_msgSender(), receiver, owner, assetsToUser, shares);
    mockTotalAssets -= assets;
    
    return shares;
  }

  function redeem(
    uint256 shares,
    address receiver,
    address owner
  ) public virtual override returns (uint256) {
    require(!mockPaused, "Vault paused");
    require(!mockRevertOnWithdraw, "Mock revert");
    
    accrueYield();
    
    uint256 assets = previewRedeem(shares);
    
    // Apply withdraw fee if set
    uint256 assetsToUser = assets;
    if (mockWithdrawFee > 0) {
      uint256 fee = (assets * mockWithdrawFee) / 10000;
      assetsToUser = assets - fee;
    }
    
    _withdraw(_msgSender(), receiver, owner, assetsToUser, shares);
    mockTotalAssets -= assets;
    
    return assetsToUser;
  }

  // --- View Functions for Testing ---
  
  /**
   * @notice Get the current exchange rate for testing
   */
  function exchangeRate() external view returns (uint256) {
    uint256 supply = totalSupply();
    if (supply == 0) {
      return 1e18;
    }
    return (totalAssets() * 1e18) / supply;
  }

  /**
   * @notice Check if an address would trigger sandwich protection
   */
  function wouldTriggerSandwichProtection(address account) external view returns (bool) {
    return lastDepositTimestamp[account] == block.timestamp;
  }

  // --- Internal Overrides ---
  
  function _deposit(
    address caller,
    address receiver,
    uint256 assets,
    uint256 shares
  ) internal virtual override {
    IERC20(asset()).transferFrom(caller, address(this), assets);
    _mint(receiver, shares);
    emit Deposit(caller, receiver, assets, shares);
  }

  function _withdraw(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
  ) internal virtual override {
    if (caller != owner) {
      _spendAllowance(owner, caller, shares);
    }
    
    _burn(owner, shares);
    IERC20(asset()).transfer(receiver, assets);
    
    emit Withdraw(caller, receiver, owner, assets, shares);
  }
}