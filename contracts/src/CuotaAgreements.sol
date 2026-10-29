// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title CuotaAgreements
 * @notice Recurring payments in local-currency stablecoins (wARS, wBRL, ...) whose amount
 *         follows an inflation index, the way Argentine rents follow the ICL or IPC.
 *
 * The payee (landlord, tutor, gym) proposes the terms; the payer (tenant, student,
 * member) accepts them onchain. From then on the Cuota agent can do exactly three things:
 *
 *  1. announce an index adjustment, which the contract bounds by a per-step ceiling,
 *     an absolute ceiling the payer agreed to, and a notice period;
 *  2. collect the current amount once per period, never early;
 *  3. forward the dollar proceeds of the payee's chosen conversion share.
 *
 * Either party can cancel at any time. Funds never sit in this contract.
 */
contract CuotaAgreements is Ownable {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Proposed,
        Active,
        Cancelled
    }

    struct Terms {
        address payer;
        address token; // wFIAT the payer is charged in
        uint256 amount; // starting amount per period
        uint256 ceiling; // the payer never pays more than this per period
        uint16 maxStepBps; // max increase per adjustment, e.g. 2500 = +25%
        uint32 period; // seconds between collections
        uint32 notice; // an adjustment applies no earlier than this after it is announced
        uint64 firstDueAt;
        uint16 convertBps; // payee's share converted to dollars by the agent
        uint8 index; // off-chain index id: 1 ICL, 2 IPC-AR, 3 IPCA, 4 IGP-M, 5 fixed step
        bytes32 termsHash; // hash of the human-readable contract
    }

    struct Agreement {
        Terms terms;
        address payee;
        Status status;
        uint256 amount; // current amount per period
        uint64 nextDueAt;
        uint32 cycle; // number of the next period to collect, from 1
        uint256 pendingAmount;
        uint64 pendingFrom; // first due date the pending amount applies to
    }

    uint256 public nextId = 1;
    mapping(uint256 => Agreement) private _agreements;
    mapping(address => bool) public isAgent;

    event AgentSet(address indexed agent, bool allowed);
    event Proposed(uint256 indexed id, address indexed payee, address indexed payer, address token, uint256 amount);
    event Accepted(uint256 indexed id);
    event Cancelled(uint256 indexed id, address by);
    event AdjustmentAnnounced(uint256 indexed id, uint256 oldAmount, uint256 newAmount, uint64 effectiveFrom, bytes32 indexRef);
    event Collected(uint256 indexed id, uint32 indexed cycle, uint256 amount, uint256 toPayee, uint256 toConvert);
    event PaidOffChain(uint256 indexed id, uint32 indexed cycle, bytes32 ref);
    event ConversionSettled(uint256 indexed id, uint32 indexed cycle, address token, uint256 amount, bytes32 swapTx);

    error Unauthorized();
    error BadTerms();
    error BadStatus();
    error NotDue();
    error AboveCeiling();
    error AboveStep();

    modifier onlyAgent() {
        if (!isAgent[msg.sender]) revert Unauthorized();
        _;
    }

    constructor(address owner_) Ownable(owner_) {}

    function setAgent(address agent, bool allowed) external onlyOwner {
        isAgent[agent] = allowed;
        emit AgentSet(agent, allowed);
    }

    // ---------------------------------------------------------------- parties

    function propose(Terms calldata t) external returns (uint256 id) {
        if (
            t.payer == address(0) || t.payer == msg.sender || t.token == address(0) || t.amount == 0
                || t.ceiling < t.amount || t.period < 1 days || t.convertBps > 10_000
                || t.firstDueAt < block.timestamp
        ) revert BadTerms();

        id = nextId++;
        Agreement storage a = _agreements[id];
        a.terms = t;
        a.payee = msg.sender;
        a.status = Status.Proposed;
        a.amount = t.amount;
        a.nextDueAt = t.firstDueAt;
        a.cycle = 1;
        emit Proposed(id, msg.sender, t.payer, t.token, t.amount);
    }

    /// @notice The payer agrees to the terms. They also need to approve this contract on the token.
    function accept(uint256 id) external {
        Agreement storage a = _agreements[id];
        if (msg.sender != a.terms.payer) revert Unauthorized();
        if (a.status != Status.Proposed) revert BadStatus();
        a.status = Status.Active;
        emit Accepted(id);
    }

    function cancel(uint256 id) external {
        Agreement storage a = _agreements[id];
        if (msg.sender != a.payee && msg.sender != a.terms.payer) revert Unauthorized();
        if (a.status != Status.Proposed && a.status != Status.Active) revert BadStatus();
        a.status = Status.Cancelled;
        emit Cancelled(id, msg.sender);
    }

    // ---------------------------------------------------------------- agent

    /**
     * @notice Announce the next index-adjusted amount. It takes effect from the first due
     *         date that is at least `notice` seconds away, so the payer always sees a new
     *         price before it is charged. Decreases are always allowed.
     */
    function announceAdjustment(uint256 id, uint256 newAmount, bytes32 indexRef) external onlyAgent {
        Agreement storage a = _agreements[id];
        if (a.status != Status.Active) revert BadStatus();
        if (newAmount == 0) revert BadTerms();
        if (newAmount > a.terms.ceiling) revert AboveCeiling();
        if (newAmount > a.amount + (a.amount * a.terms.maxStepBps) / 10_000) revert AboveStep();

        uint64 from = a.nextDueAt;
        while (from < block.timestamp + a.terms.notice) from += a.terms.period;

        a.pendingAmount = newAmount;
        a.pendingFrom = from;
        emit AdjustmentAnnounced(id, a.amount, newAmount, from, indexRef);
    }

    /**
     * @notice Collect the current period. The payee's share goes straight to the payee; the
     *         conversion share goes to the calling agent, which owes it back in dollars via
     *         `settleConversion`.
     */
    function collect(uint256 id) external onlyAgent returns (uint256 amount) {
        Agreement storage a = _agreements[id];
        if (a.status != Status.Active) revert BadStatus();
        if (block.timestamp < a.nextDueAt) revert NotDue();

        _applyPending(a);
        amount = a.amount;
        uint32 cycle = a.cycle;
        _advance(a);

        uint256 toConvert = (amount * a.terms.convertBps) / 10_000;
        uint256 toPayee = amount - toConvert;
        IERC20 token = IERC20(a.terms.token);
        if (toPayee > 0) token.safeTransferFrom(a.terms.payer, a.payee, toPayee);
        if (toConvert > 0) token.safeTransferFrom(a.terms.payer, msg.sender, toConvert);
        emit Collected(id, cycle, amount, toPayee, toConvert);
    }

    /// @notice A period paid another way (e.g. a foreign tenant paying in USA₮ over x402).
    function markPaidOffChain(uint256 id, bytes32 ref) external onlyAgent {
        Agreement storage a = _agreements[id];
        if (a.status != Status.Active) revert BadStatus();
        // Only the upcoming period can be settled early; the schedule can't be skipped ahead.
        if (block.timestamp + a.terms.period < a.nextDueAt) revert NotDue();
        _applyPending(a);
        uint32 cycle = a.cycle;
        _advance(a);
        emit PaidOffChain(id, cycle, ref);
    }

    /// @notice Forward converted dollars to the payee. Destination is fixed to the payee.
    function settleConversion(uint256 id, uint32 cycle, address token, uint256 amount, bytes32 swapTx)
        external
        onlyAgent
    {
        Agreement storage a = _agreements[id];
        if (a.status == Status.None || cycle == 0 || cycle >= a.cycle) revert BadStatus();
        IERC20(token).safeTransferFrom(msg.sender, a.payee, amount);
        emit ConversionSettled(id, cycle, token, amount, swapTx);
    }

    // ---------------------------------------------------------------- views

    function get(uint256 id) external view returns (Agreement memory) {
        return _agreements[id];
    }

    /// @notice The amount the next collection will charge.
    function amountDue(uint256 id) external view returns (uint256) {
        Agreement storage a = _agreements[id];
        if (a.pendingAmount != 0 && a.nextDueAt >= a.pendingFrom) return a.pendingAmount;
        return a.amount;
    }

    // ---------------------------------------------------------------- internal

    function _applyPending(Agreement storage a) private {
        if (a.pendingAmount != 0 && a.nextDueAt >= a.pendingFrom) {
            a.amount = a.pendingAmount;
            a.pendingAmount = 0;
            a.pendingFrom = 0;
        }
    }

    function _advance(Agreement storage a) private {
        a.nextDueAt += a.terms.period;
        a.cycle += 1;
    }
}
