// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {CuotaAgreements} from "../src/CuotaAgreements.sol";

contract Peso is ERC20 {
    constructor() ERC20("Peso Argentino", "wARS") {}

    function mint(address to, uint256 v) external {
        _mint(to, v);
    }
}

contract Dollar is ERC20 {
    constructor() ERC20("Tether USD", "USDT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 v) external {
        _mint(to, v);
    }
}

contract CuotaAgreementsTest is Test {
    CuotaAgreements c;
    Peso wars;
    Dollar usdt;

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address landlord = makeAddr("landlord");
    address tenant = makeAddr("tenant");

    uint256 constant RENT = 650_000e18; // ARS 650k
    uint32 constant MONTH = 30 days;

    function setUp() public {
        vm.warp(1_790_000_000);
        c = new CuotaAgreements(owner);
        wars = new Peso();
        usdt = new Dollar();
        vm.prank(owner);
        c.setAgent(agent, true);
        wars.mint(tenant, 100_000_000e18);
        vm.prank(tenant);
        wars.approve(address(c), type(uint256).max);
    }

    function _terms(uint16 convertBps) internal view returns (CuotaAgreements.Terms memory) {
        return CuotaAgreements.Terms({
            payer: tenant,
            token: address(wars),
            amount: RENT,
            ceiling: RENT * 3,
            maxStepBps: 2_500,
            period: MONTH,
            notice: 10 days,
            firstDueAt: uint64(block.timestamp + 1 days),
            convertBps: convertBps,
            index: 1,
            termsHash: keccak256("contrato de locacion")
        });
    }

    function _active(uint16 convertBps) internal returns (uint256 id) {
        vm.prank(landlord);
        id = c.propose(_terms(convertBps));
        vm.prank(tenant);
        c.accept(id);
    }

    function test_proposeAndAccept() public {
        uint256 id = _active(0);
        CuotaAgreements.Agreement memory a = c.get(id);
        assertEq(a.payee, landlord);
        assertEq(uint8(a.status), uint8(CuotaAgreements.Status.Active));
        assertEq(a.amount, RENT);
        assertEq(a.cycle, 1);
    }

    function test_onlyPayerAccepts() public {
        vm.prank(landlord);
        uint256 id = c.propose(_terms(0));
        vm.prank(landlord);
        vm.expectRevert(CuotaAgreements.Unauthorized.selector);
        c.accept(id);
    }

    function test_rejectsCeilingBelowAmount() public {
        CuotaAgreements.Terms memory t = _terms(0);
        t.ceiling = RENT - 1;
        vm.prank(landlord);
        vm.expectRevert(CuotaAgreements.BadTerms.selector);
        c.propose(t);
    }

    function test_cannotCollectProposedAgreement() public {
        vm.prank(landlord);
        uint256 id = c.propose(_terms(0));
        vm.warp(block.timestamp + 2 days);
        vm.prank(agent);
        vm.expectRevert(CuotaAgreements.BadStatus.selector);
        c.collect(id);
    }

    function test_collectOnDueDateOnly() public {
        uint256 id = _active(0);
        vm.prank(agent);
        vm.expectRevert(CuotaAgreements.NotDue.selector);
        c.collect(id);

        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        c.collect(id);
        assertEq(wars.balanceOf(landlord), RENT);

        // Same period can't be collected twice.
        vm.prank(agent);
        vm.expectRevert(CuotaAgreements.NotDue.selector);
        c.collect(id);
    }

    function test_conversionShareGoesToAgentThenPayeeInDollars() public {
        uint256 id = _active(4_000); // landlord dollarizes 40%
        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        c.collect(id);
        assertEq(wars.balanceOf(landlord), (RENT * 6) / 10);
        assertEq(wars.balanceOf(agent), (RENT * 4) / 10);

        usdt.mint(agent, 158e6);
        vm.startPrank(agent);
        usdt.approve(address(c), type(uint256).max);
        c.settleConversion(id, 1, address(usdt), 158e6, bytes32(uint256(7)));
        vm.stopPrank();
        assertEq(usdt.balanceOf(landlord), 158e6);
    }

    function test_cannotSettleConversionForFutureCycle() public {
        uint256 id = _active(4_000);
        usdt.mint(agent, 1e6);
        vm.startPrank(agent);
        usdt.approve(address(c), type(uint256).max);
        vm.expectRevert(CuotaAgreements.BadStatus.selector);
        c.settleConversion(id, 1, address(usdt), 1e6, bytes32(0));
        vm.stopPrank();
    }

    function test_adjustmentRespectsNotice() public {
        uint256 id = _active(0);
        // Announced 1 day before the first due date: notice is 10 days, so it lands on cycle 2.
        uint256 raised = (RENT * 112) / 100;
        vm.prank(agent);
        c.announceAdjustment(id, raised, keccak256("ICL 37.07/33.10"));

        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        c.collect(id);
        assertEq(wars.balanceOf(landlord), RENT, "cycle 1 at the old amount");
        assertEq(c.amountDue(id), raised);

        vm.warp(block.timestamp + MONTH);
        vm.prank(agent);
        c.collect(id);
        assertEq(wars.balanceOf(landlord), RENT + raised, "cycle 2 at the new amount");
    }

    function test_adjustmentCappedPerStep() public {
        uint256 id = _active(0);
        vm.prank(agent);
        vm.expectRevert(CuotaAgreements.AboveStep.selector);
        c.announceAdjustment(id, (RENT * 126) / 100, bytes32(0));
    }

    function test_adjustmentCappedByCeiling() public {
        CuotaAgreements.Terms memory t = _terms(0);
        t.ceiling = (RENT * 110) / 100;
        vm.prank(landlord);
        uint256 id = c.propose(t);
        vm.prank(tenant);
        c.accept(id);
        vm.prank(agent);
        vm.expectRevert(CuotaAgreements.AboveCeiling.selector);
        c.announceAdjustment(id, (RENT * 115) / 100, bytes32(0));
    }

    function test_onlyAgentAdjusts() public {
        uint256 id = _active(0);
        vm.prank(landlord);
        vm.expectRevert(CuotaAgreements.Unauthorized.selector);
        c.announceAdjustment(id, RENT, bytes32(0));
    }

    function test_paidOffChainAdvancesSchedule() public {
        uint256 id = _active(0);
        vm.prank(agent);
        c.markPaidOffChain(id, keccak256("x402 settlement"));
        CuotaAgreements.Agreement memory a = c.get(id);
        assertEq(a.cycle, 2);
        assertEq(a.nextDueAt, uint64(block.timestamp + 1 days + MONTH));

        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        vm.expectRevert(CuotaAgreements.NotDue.selector);
        c.collect(id);
    }

    function test_cannotMarkPeriodsFarAhead() public {
        uint256 id = _active(0);
        vm.startPrank(agent);
        c.markPaidOffChain(id, bytes32(uint256(1))); // cycle 1, due tomorrow: fine
        vm.expectRevert(CuotaAgreements.NotDue.selector);
        c.markPaidOffChain(id, bytes32(uint256(2))); // cycle 2 is a month out
        vm.stopPrank();
    }

    function test_tenantCancelStopsCollection() public {
        uint256 id = _active(0);
        vm.prank(tenant);
        c.cancel(id);
        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        vm.expectRevert(CuotaAgreements.BadStatus.selector);
        c.collect(id);
    }

    function testFuzz_neverChargesAboveCeiling(uint256 newAmount) public {
        uint256 id = _active(0);
        newAmount = bound(newAmount, 1, RENT * 10);
        vm.prank(agent);
        try c.announceAdjustment(id, newAmount, bytes32(0)) {
            assertLe(newAmount, RENT * 3);
            assertLe(newAmount, (RENT * 12_500) / 10_000);
        } catch {}
    }
}
