// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BitMaps} from "@openzeppelin/contracts/utils/structs/BitMaps.sol";
import {IEIP3009} from "../interfaces/IEIP3009.sol";

/// @title Agent Safe budget vault
/// @notice Holds an owner's USDC and lets an AI agent spend it only inside budgets the owner signed.
///
///         Security model, in one paragraph: the agent's key can spend, never authorize. Every budget ("intent") is
///         an EIP-712 message signed by the owner, bound to one agent key, one counterparty and (optionally) one
///         payer address, and it only becomes active after a timelock, so a phished or blind-signed intent cannot
///         open a large budget instantly. Shrinking, revoking and pausing are instant. Whatever the model is tricked
///         into, the most it can move is `maxPerTx` per call and `maxPerPeriod` per window (plus the 0.1% fee), and
///         only to the counterparty (`pay`) or to the signed payer address (`fundBurner`, up to `trancheCap`).
///         The owner key itself can always withdraw: protect it like any wallet key, and keep it out of the agent.
///
/// @dev Burner tranches exist so agents can pay through any x402 facilitator: a burner EOA signs a normal EIP-3009
///      authorization. The vault funds only the burner the owner signed, so a stolen agent key cannot redirect
///      tranches. Funds already in a burner can pay anyone if the burner key is also stolen; the SDK binds burner
///      payments to the merchant, and the contract bounds that loss to `trancheCap` per burner and `maxPerPeriod`
///      per window. Windows are fixed (not rolling), so up to 2x `maxPerPeriod` can move around a window boundary.
contract BudgetVault is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using BitMaps for BitMaps.BitMap;

    struct Intent {
        address agent;
        address counterparty;
        address burner; // the only payer address `fundBurner` may top up; zero disables burner funding
        address token;
        uint128 maxPerTx;
        uint128 maxPerPeriod;
        uint128 trancheCap;
        uint32 period;
        uint64 validAfter;
        uint64 expiry;
        uint256 nonce;
    }

    struct IntentState {
        Intent intent;
        uint64 activeAt;
        bool revoked;
        uint64 windowIdx;
        uint128 spentInWindow;
    }

    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "Intent(address agent,address counterparty,address burner,address token,uint128 maxPerTx,uint128 maxPerPeriod,uint128 trancheCap,uint32 period,uint64 validAfter,uint64 expiry,uint256 nonce)"
    );

    uint32 public constant MIN_DELAY = 1 hours;
    uint32 public constant MAX_DELAY = 7 days;
    uint16 public constant FEE_BPS = 10; // 0.1%, charged on top of each payment or tranche
    uint16 public constant BPS = 10_000;

    address public immutable OWNER;
    IERC20 public immutable USDC;
    address public immutable FEE_JAR;
    address public immutable OPS;
    uint16 public immutable JAR_SHARE_BPS;

    uint32 public activationDelay;
    uint32 public pendingDelay;
    uint64 public pendingDelayEta;
    bool public paused;

    mapping(bytes32 id => IntentState) private _intents;
    mapping(address burner => bool) public isBurner;
    uint256 public owedJar;
    uint256 public owedOps;
    BitMaps.BitMap private _usedNonces;

    event IntentProposed(bytes32 indexed id, address indexed agent, address indexed counterparty, uint64 activeAt);
    event IntentReduced(bytes32 indexed id, uint128 maxPerTx, uint128 maxPerPeriod, uint128 trancheCap, uint64 expiry);
    event IntentRevoked(bytes32 indexed id);
    event Paid(bytes32 indexed id, address indexed to, uint256 amount, uint256 fee);
    event BurnerFunded(bytes32 indexed id, address indexed burner, uint256 amount, uint256 fee);
    event BurnerSwept(address indexed burner, uint256 amount);
    event Paused(bool paused);
    event Withdrawn(address indexed to, uint256 amount);
    event NonceInvalidated(uint256 nonce);
    event FeeDeferred(address indexed recipient, uint256 amount);
    event FeesFlushed(uint256 toJar, uint256 toOps);
    event Rescued(address indexed token, address indexed to, uint256 amount);
    event DelayChangeQueued(uint32 delay, uint64 eta);
    event DelayChanged(uint32 delay);

    error NotOwner();
    error NotAgent();
    error IsPaused();
    error BadIntent();
    error NonceUsed();
    error BadSignature();
    error UnknownIntent();
    error IntentInactive();
    error NotAReduction();
    error WrongCounterparty();
    error OverPerTx();
    error OverPeriod();
    error OverTranche();
    error NotSignedBurner();
    error UnknownBurner();
    error OwedFees();
    error CannotRescueUsdc();
    error BadDelay();
    error NoPendingDelay();
    error TooEarly();

    modifier onlyOwner() {
        if (msg.sender != OWNER) revert NotOwner();
        _;
    }

    constructor(address owner_, IERC20 usdc, address feeJar, address ops, uint16 jarShareBps, uint32 initialDelay)
        EIP712("Deep First Search Agent Safe", "1")
    {
        if (owner_ == address(0) || address(usdc) == address(0) || feeJar == address(0)) revert BadIntent();
        if (jarShareBps > BPS || (jarShareBps < BPS && ops == address(0))) revert BadIntent();
        if (initialDelay < MIN_DELAY || initialDelay > MAX_DELAY) revert BadDelay();
        OWNER = owner_;
        USDC = usdc;
        FEE_JAR = feeJar;
        OPS = ops;
        JAR_SHARE_BPS = jarShareBps;
        activationDelay = initialDelay;
    }

    // ---------------------------------------------------------------- views

    function intentId(Intent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(_structHash(intent));
    }

    function getIntent(bytes32 id) external view returns (IntentState memory) {
        return _intents[id];
    }

    function nonceUsed(uint256 nonce) external view returns (bool) {
        return _usedNonces.get(nonce);
    }

    function feeFor(uint256 amount) public pure returns (uint256) {
        return (amount * FEE_BPS) / BPS;
    }

    // ---------------------------------------------------------------- owner: authorize (timelocked)

    /// @notice Registers an owner-signed intent. Anyone may relay it; it activates after `activationDelay`.
    function proposeIntent(Intent calldata intent, bytes calldata ownerSignature) external returns (bytes32 id) {
        if (
            intent.agent == address(0) || intent.counterparty == address(0) || intent.token != address(USDC)
                || intent.period == 0 || intent.maxPerTx == 0 || intent.maxPerTx > intent.maxPerPeriod
                || intent.expiry <= block.timestamp || _isProtocolAddress(intent.counterparty)
                || _isProtocolAddress(intent.burner)
        ) revert BadIntent();
        if (_usedNonces.get(intent.nonce)) revert NonceUsed();

        id = _hashTypedDataV4(_structHash(intent));
        if (!_isOwnerSignature(id, ownerSignature)) revert BadSignature();
        _usedNonces.set(intent.nonce);

        uint64 activeAt = uint64(block.timestamp) + activationDelay;
        if (intent.validAfter > activeAt) activeAt = intent.validAfter;
        if (intent.expiry <= activeAt) revert BadIntent();

        IntentState storage st = _intents[id];
        st.intent = intent;
        st.activeAt = activeAt;
        emit IntentProposed(id, intent.agent, intent.counterparty, activeAt);
    }

    // ---------------------------------------------------------------- owner: restrict (instant)

    function reduceIntent(bytes32 id, uint128 maxPerTx, uint128 maxPerPeriod, uint128 trancheCap, uint64 expiry)
        external
        onlyOwner
    {
        IntentState storage st = _intents[id];
        if (st.activeAt == 0) revert UnknownIntent();
        Intent storage i = st.intent;
        if (
            maxPerTx > i.maxPerTx || maxPerPeriod > i.maxPerPeriod || trancheCap > i.trancheCap || expiry > i.expiry
                || maxPerTx > maxPerPeriod
        ) revert NotAReduction();
        i.maxPerTx = maxPerTx;
        i.maxPerPeriod = maxPerPeriod;
        i.trancheCap = trancheCap;
        i.expiry = expiry;
        emit IntentReduced(id, maxPerTx, maxPerPeriod, trancheCap, expiry);
    }

    function revokeIntent(bytes32 id) external onlyOwner {
        if (_intents[id].activeAt == 0) revert UnknownIntent();
        _intents[id].revoked = true;
        emit IntentRevoked(id);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit Paused(value);
    }

    /// @notice Longer delays apply immediately; shorter ones wait out the current delay.
    function setActivationDelay(uint32 delay) external onlyOwner {
        if (delay < MIN_DELAY || delay > MAX_DELAY) revert BadDelay();
        if (delay >= activationDelay) {
            activationDelay = delay;
            pendingDelayEta = 0;
            emit DelayChanged(delay);
        } else {
            pendingDelay = delay;
            pendingDelayEta = uint64(block.timestamp) + activationDelay;
            emit DelayChangeQueued(delay, pendingDelayEta);
        }
    }

    function applyActivationDelay() external {
        if (pendingDelayEta == 0) revert NoPendingDelay();
        if (block.timestamp < pendingDelayEta) revert TooEarly();
        activationDelay = pendingDelay;
        pendingDelayEta = 0;
        emit DelayChanged(pendingDelay);
    }

    /// @notice The owner can always take funds out, even while paused.
    function withdraw(address to, uint256 amount) external nonReentrant onlyOwner {
        uint256 bal = USDC.balanceOf(address(this));
        uint256 owed = owedJar + owedOps;
        if (amount > (bal > owed ? bal - owed : 0)) revert OwedFees();
        emit Withdrawn(to, amount);
        USDC.safeTransfer(to, amount);
    }

    /// @notice Burns a nonce so a signed but unproposed intent can never be relayed.
    ///         Idempotent, so relaying the intent first cannot make this call fail (revoke that intent instead).
    function invalidateNonce(uint256 nonce) external onlyOwner {
        _usedNonces.set(nonce);
        emit NonceInvalidated(nonce);
    }

    /// @notice Recovers tokens other than the vault's USDC that were sent here by mistake.
    function rescue(IERC20 token, address to, uint256 amount) external nonReentrant onlyOwner {
        if (address(token) == address(USDC)) revert CannotRescueUsdc();
        emit Rescued(address(token), to, amount);
        token.safeTransfer(to, amount);
    }

    /// @notice Pays out fees that could not be transferred when charged. Callable by anyone.
    ///         Each recipient is paid independently, so one that still cannot receive never blocks the other.
    function flushFees() external nonReentrant {
        uint256 bal = USDC.balanceOf(address(this));
        uint256 j = owedJar < bal ? owedJar : bal;
        if (j != 0 && USDC.trySafeTransfer(FEE_JAR, j)) {
            owedJar -= j;
            bal -= j;
        } else {
            j = 0;
        }
        uint256 o = owedOps < bal ? owedOps : bal;
        if (o != 0 && USDC.trySafeTransfer(OPS, o)) owedOps -= o;
        else o = 0;
        emit FeesFlushed(j, o);
    }

    // ---------------------------------------------------------------- agent: spend

    /// @notice Pays the intent's counterparty directly.
    function pay(bytes32 id, address to, uint256 amount) external nonReentrant {
        IntentState storage st = _spend(id, amount);
        if (to != st.intent.counterparty) revert WrongCounterparty();
        _requireFree(amount);
        uint256 fee = _chargeFee(amount);
        emit Paid(id, to, amount, fee);
        USDC.safeTransfer(to, amount);
    }

    /// @notice Tops up the payer address the owner signed into this intent. It never holds more than `trancheCap`.
    function fundBurner(bytes32 id, address burner, uint256 amount) external nonReentrant {
        IntentState storage st = _spend(id, amount);
        if (burner == address(0) || burner != st.intent.burner) revert NotSignedBurner();
        if (USDC.balanceOf(burner) + amount > st.intent.trancheCap) revert OverTranche();
        _requireFree(amount);
        isBurner[burner] = true;
        uint256 fee = _chargeFee(amount);
        emit BurnerFunded(id, burner, amount, fee);
        USDC.safeTransfer(burner, amount);
    }

    /// @notice Pulls a burner's leftover USDC back with the burner's EIP-3009 receive authorization.
    ///         `receiveWithAuthorization` requires the caller to be the receiver (this vault), so the funds always
    ///         come back here; front-running the call only spends the front-runner's gas.
    function sweepBurner(
        address burner,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external nonReentrant {
        if (!isBurner[burner]) revert UnknownBurner();
        IEIP3009(address(USDC))
            .receiveWithAuthorization(burner, address(this), value, validAfter, validBefore, nonce, signature);
        emit BurnerSwept(burner, value);
    }

    // ---------------------------------------------------------------- internals

    function _spend(bytes32 id, uint256 amount) private returns (IntentState storage st) {
        if (paused) revert IsPaused();
        st = _intents[id];
        Intent storage i = st.intent;
        if (st.activeAt == 0) revert UnknownIntent();
        if (msg.sender != i.agent) revert NotAgent();
        if (st.revoked || block.timestamp < st.activeAt || block.timestamp >= i.expiry) revert IntentInactive();
        if (amount == 0 || amount > i.maxPerTx) revert OverPerTx();

        uint64 window = uint64((block.timestamp - st.activeAt) / i.period);
        if (window != st.windowIdx) {
            st.windowIdx = window;
            st.spentInWindow = 0;
        }
        uint256 spent = uint256(st.spentInWindow) + amount;
        if (spent > i.maxPerPeriod) revert OverPeriod();
        // forge-lint: disable-next-line(unsafe-typecast) spent <= maxPerPeriod, which is a uint128
        st.spentInWindow = uint128(spent);
    }

    /// @dev ECDSA first, then ERC-1271. An EIP-7702-delegated EOA has code, so OpenZeppelin's `isValidSignatureNow`
    ///      would only try ERC-1271 and reject the owner's own key whenever the delegate lacks `isValidSignature`.
    ///      Trying ECDSA first is safe: `ecrecover` cannot return a contract (e.g. Safe) address without its key.
    function _isOwnerSignature(bytes32 id, bytes calldata signature) private view returns (bool) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(id, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == OWNER) return true;
        return OWNER.code.length != 0 && SignatureChecker.isValidERC1271SignatureNowCalldata(OWNER, id, signature);
    }

    /// @dev The amount plus its fee must come from funds that are not owed to the fee recipients.
    function _requireFree(uint256 amount) private view {
        if (USDC.balanceOf(address(this)) < owedJar + owedOps + amount + feeFor(amount)) revert OwedFees();
    }

    function _isProtocolAddress(address a) private view returns (bool) {
        return a == address(this) || a == FEE_JAR || a == OPS;
    }

    /// @dev A fee transfer that fails (for example, a fee recipient blacklisted by the token issuer) never blocks
    ///      the payment: it is recorded as owed and can be flushed later by anyone.
    function _chargeFee(uint256 amount) private returns (uint256 fee) {
        fee = feeFor(amount);
        if (fee == 0) return 0;
        uint256 toJar = (fee * JAR_SHARE_BPS) / BPS;
        if (toJar != 0 && !USDC.trySafeTransfer(FEE_JAR, toJar)) {
            owedJar += toJar;
            emit FeeDeferred(FEE_JAR, toJar);
        }
        uint256 toOps = fee - toJar;
        if (toOps != 0 && !USDC.trySafeTransfer(OPS, toOps)) {
            owedOps += toOps;
            emit FeeDeferred(OPS, toOps);
        }
    }

    function _structHash(Intent calldata i) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                i.agent,
                i.counterparty,
                i.burner,
                i.token,
                i.maxPerTx,
                i.maxPerPeriod,
                i.trancheCap,
                i.period,
                i.validAfter,
                i.expiry,
                i.nonce
            )
        );
    }
}
