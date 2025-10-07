// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title MockMetaMorphoVault
 * @notice Mock implementation of a MetaMorpho vault for testing
 * @dev Simulates a MetaMorpho vault with configurable yield generation and rewards
 *      This mock allows testing of integrations without deploying to mainnet
 *
 *      IMPORTANT - Reward Handling Architecture:
 *      Real MetaMorpho vaults do not handle rewards directly within the vault contract.
 *      Instead, rewards are managed externally through:
 *      1. Universal Rewards Distributor (URD) contracts
 *      2. Curator incentive programs
 *      3. Other external reward mechanisms
 *
 *      In our dSTAKE integration, MetaMorpho rewards are handled by the
 *      DStakeRewardManagerMetaMorpho contract, not by the conversion adapter.
 *      This mock includes basic reward tracking functions for testing scenarios
 *      but should not be confused with production reward handling.
 */
contract MockMetaMorphoVault is ERC4626 {
  using Math for uint256;

  // --- State ---
  uint256 public mockTotalAssets;
  uint256 public yieldRate = 10000; // 100% APY in basis points (for easy testing)
  uint256 public lastYieldUpdate;
  address public owner;

  // Tracking for security testing
  mapping(address => uint256) public lastDepositTimestamp;

  // Mock reward tracking (for testing reward scenarios)
  mapping(address => uint256) public pendingRewards;
  address public rewardToken;
  uint256 public rewardRate; // rewards per second per share

  // Mock skim recipient for MetaMorpho compatibility
  address public skimRecipient;

  // Mock behaviors for testing edge cases
  bool public mockPaused = false;
  bool public mockRevertOnDeposit = false;
  bool public mockRevertOnWithdraw = false;
  bool public mockRevertOnPreviewRedeem = false;
  bool public mockRevertOnConvertToAssets = false;
  uint256 public mockDepositFee = 0; // in basis points
  uint256 public mockWithdrawFee = 0; // in basis points

  // --- Events ---
  event YieldAccrued(uint256 amount);
  event MockBehaviorSet(string behavior, bool value);
  event RewardsClaimed(address indexed user, uint256 amount);

  // --- Constructor ---
  constructor(IERC20 _asset, string memory _name, string memory _symbol) ERC20(_name, _symbol) ERC4626(_asset) {
    lastYieldUpdate = block.timestamp;
    owner = msg.sender;
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
   * @notice Configure preview functions to revert for valuation testing
   */
  function setPreviewRevertFlags(bool _revertPreviewRedeem, bool _revertConvertToAssets) external {
    require(msg.sender == owner, "Not owner");
    mockRevertOnPreviewRedeem = _revertPreviewRedeem;
    mockRevertOnConvertToAssets = _revertConvertToAssets;
    emit MockBehaviorSet("revertPreviewRedeem", _revertPreviewRedeem);
    emit MockBehaviorSet("revertConvertToAssets", _revertConvertToAssets);
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
    require(assets > 0, "Zero assets");

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

    // For consistent ERC4626 behavior, shares should be calculated based on assets going into the vault
    uint256 shares = previewDeposit(assetsAfterFee);

    // Transfer full assets from caller and mint calculated shares
    IERC20(asset()).transferFrom(_msgSender(), address(this), assets);
    _mint(receiver, shares);

    // Update mock state to reflect assets after fees
    mockTotalAssets += assetsAfterFee;

    emit Deposit(_msgSender(), receiver, assets, shares);
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

    // Update total assets after deposit
    uint256 assetsAfterFee = assets - ((mockDepositFee > 0) ? (assets * mockDepositFee) / 10000 : 0);
    mockTotalAssets += assetsAfterFee;

    return assets;
  }

  function withdraw(uint256 assets, address receiver, address owner) public virtual override returns (uint256) {
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

  function redeem(uint256 shares, address receiver, address owner) public virtual override returns (uint256) {
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

  // --- Mock Skim Functions (MetaMorpho compatibility) ---

  /**
   * @notice Transfer ownership of the vault
   * @param newOwner Address of the new owner
   */
  function transferOwnership(address newOwner) external {
    require(msg.sender == owner, "Not owner");
    owner = newOwner;
  }

  /**
   * @notice Set the skim recipient for reward collection
   * @param _skimRecipient Address to receive skimmed rewards
   */
  function setSkimRecipient(address _skimRecipient) external {
    require(msg.sender == owner, "Not owner");
    skimRecipient = _skimRecipient;
  }

  /**
   * @notice Skim rewards to the skim recipient
   * @param token Token to skim
   */
  function skim(address token) external {
    if (skimRecipient != address(0)) {
      uint256 balance = IERC20(token).balanceOf(address(this));
      if (balance > 0) {
        IERC20(token).transfer(skimRecipient, balance);
      }
    }
  }

  // --- Mock Reward Functions ---

  /**
   * @notice Set mock reward token and rate for testing
   * @param _rewardToken Address of the reward token (can be 0 to disable)
   * @param _rewardRate Rewards per second per share
   */
  function setRewardConfig(address _rewardToken, uint256 _rewardRate) external {
    rewardToken = _rewardToken;
    rewardRate = _rewardRate;
  }

  /**
   * @notice Mock function to simulate reward accrual
   * @param user Address to accrue rewards for
   */
  function accrueRewards(address user) external {
    if (rewardToken != address(0) && balanceOf(user) > 0) {
      uint256 timeSinceDeposit = block.timestamp - lastDepositTimestamp[user];
      uint256 rewards = (balanceOf(user) * rewardRate * timeSinceDeposit) / 1e18;
      pendingRewards[user] += rewards;
    }
  }

  /**
   * @notice Mock function to claim accrued rewards
   * @dev In real MetaMorpho, rewards are typically handled externally
   */
  function claimRewards() external returns (uint256) {
    uint256 rewards = pendingRewards[msg.sender];
    if (rewards > 0 && rewardToken != address(0)) {
      pendingRewards[msg.sender] = 0;
      // In a real implementation, would transfer reward tokens
      emit RewardsClaimed(msg.sender, rewards);
    }
    return rewards;
  }

  /**
   * @notice Get pending rewards for a user
   * @param user Address to check
   * @return Amount of pending rewards
   */
  function getPendingRewards(address user) external view returns (uint256) {
    if (rewardToken == address(0) || balanceOf(user) == 0) {
      return pendingRewards[user];
    }
    uint256 timeSinceDeposit = block.timestamp - lastDepositTimestamp[user];
    uint256 accruedRewards = (balanceOf(user) * rewardRate * timeSinceDeposit) / 1e18;
    return pendingRewards[user] + accruedRewards;
  }

  /**
   * @notice Get the current withdrawal fee
   * @return The withdrawal fee in basis points
   */
  function withdrawalFee() external view returns (uint256) {
    return mockWithdrawFee;
  }

  // --- Internal Overrides ---

  function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal virtual override {
    IERC20(asset()).transferFrom(caller, address(this), assets);
    _mint(receiver, shares);
    emit Deposit(caller, receiver, assets, shares);
  }

  function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares) internal virtual override {
    if (caller != owner) {
      _spendAllowance(owner, caller, shares);
    }

    _burn(owner, shares);
    IERC20(asset()).transfer(receiver, assets);

    emit Withdraw(caller, receiver, owner, assets, shares);
  }

  function previewRedeem(uint256 shares) public view virtual override returns (uint256) {
    if (mockRevertOnPreviewRedeem) revert("Mock previewRedeem revert");
    return super.previewRedeem(shares);
  }

  function convertToAssets(uint256 shares) public view virtual override returns (uint256) {
    if (mockRevertOnConvertToAssets) revert("Mock convertToAssets revert");
    return super.convertToAssets(shares);
  }
}
