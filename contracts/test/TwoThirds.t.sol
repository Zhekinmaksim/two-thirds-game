// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TwoThirds, IERC20} from "../src/TwoThirds.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockInco} from "./mocks/MockInco.sol";

contract TwoThirdsTest is Test {
    // The Inco executor address that @inco/lightning calls into.
    address constant INCO = 0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624;

    TwoThirds game;
    MockERC20 token;
    MockInco inco;

    uint256 constant FEE = 1_000_000; // 1 USDC (6 decimals)
    uint16  constant RAKE_BPS = 500;  // 5%
    uint64  constant DURATION = 3600; // 1 hour
    address treasury = address(0xBEEF);
    address settler = address(0x5E771E2);

    function setUp() public {
        // stub the Inco executor
        MockInco mock = new MockInco();
        vm.etch(INCO, address(mock).code);
        inco = MockInco(INCO);

        token = new MockERC20();
        game = new TwoThirds(IERC20(address(token)), FEE, RAKE_BPS, DURATION, treasury, settler);
    }

    // -- helpers --------------------------------------------------------------

    function _ct(uint256 guess) internal pure returns (bytes memory) {
        return abi.encode(guess); // mock "ciphertext"
    }

    function _enter(address player, uint256 guess) internal {
        token.mint(player, FEE);
        vm.startPrank(player);
        token.approve(address(game), FEE);
        game.enter(_ct(guess));
        vm.stopPrank();
    }

    function _sigs(uint256 n) internal pure returns (bytes[][] memory s) {
        s = new bytes[][](n);
        for (uint256 i; i < n; ++i) {
            s[i] = new bytes[](1);
            s[i][0] = hex"01"; // placeholder; mock ignores signature bytes
        }
    }

    function _close() internal {
        vm.warp(block.timestamp + DURATION + 1);
    }

    // -- tests ----------------------------------------------------------------

    /// 3 players guess 60/30/15 -> avg 35 -> target floor(2*105/9)=23.
    /// distances 37/7/8 -> the player on 30 wins the whole net pot.
    function test_NormalWin() public {
        address p1 = address(0x1);
        address p2 = address(0x2);
        address p3 = address(0x3);
        _enter(p1, 60);
        _enter(p2, 30);
        _enter(p3, 15);
        _close();

        uint256[] memory values = new uint256[](3);
        values[0] = 60; values[1] = 30; values[2] = 15;
        game.settle(values, _sigs(3));

        uint256 pot = 3 * FEE;
        uint256 rake = (pot * RAKE_BPS) / 10_000; // 150_000
        uint256 net = pot - rake;                  // 2_850_000

        assertEq(token.balanceOf(p2), net, "winner gets net pot");
        assertEq(token.balanceOf(p1), 0, "loser gets nothing");
        assertEq(token.balanceOf(p3), 0, "loser gets nothing");
        assertEq(token.balanceOf(treasury), rake, "treasury gets rake");
        assertEq(game.roundId(), 2, "next round started");
    }

    /// 3 players guess 0/0/30 -> avg 10 -> target floor(2*30/9)=6.
    /// distances 6/6/24 -> the two zeros tie and split the net pot.
    function test_TieSplit() public {
        address p1 = address(0x11);
        address p2 = address(0x22);
        address p3 = address(0x33);
        _enter(p1, 0);
        _enter(p2, 0);
        _enter(p3, 30);
        _close();

        uint256[] memory values = new uint256[](3);
        values[0] = 0; values[1] = 0; values[2] = 30;
        game.settle(values, _sigs(3));

        uint256 net = 3 * FEE - (3 * FEE * RAKE_BPS) / 10_000; // 2_850_000
        uint256 pay = net / 2;                                  // 1_425_000

        assertEq(token.balanceOf(p1), pay, "tie winner 1");
        assertEq(token.balanceOf(p2), pay, "tie winner 2");
        assertEq(token.balanceOf(p3), 0, "non-winner");
        assertEq(token.balanceOf(treasury), (3 * FEE * RAKE_BPS) / 10_000, "rake");
    }

    /// The 51st entrant in a round is rejected with "round full".
    function test_RoundFull_RevertsOn51st() public {
        for (uint256 i; i < 50; ++i) {
            _enter(address(uint160(1000 + i)), 50);
        }
        (, , , uint256 count) = game.getRound(game.roundId());
        assertEq(count, 50, "exactly 50 seated");

        address late = address(uint160(9999));
        token.mint(late, FEE);
        vm.startPrank(late);
        token.approve(address(game), FEE);
        vm.expectRevert(bytes("round full"));
        game.enter(_ct(50));
        vm.stopPrank();

        assertEq(token.balanceOf(late), FEE, "no fee taken on rejected entry");
    }

    /// With fewer than MIN_PLAYERS (2), settle rolls the pot into the next round.
    function test_Rollover_UnderMinPlayers() public {
        address p1 = address(0xA1);
        _enter(p1, 40);
        _close();

        uint256[] memory values = new uint256[](1);
        values[0] = 40;
        game.settle(values, _sigs(1));

        (, bool settled1, , ) = game.getRound(1);
        assertTrue(settled1, "round 1 marked settled");
        assertEq(game.roundId(), 2, "advanced to round 2");

        (, , uint256 pot2, ) = game.getRound(2);
        assertEq(pot2, FEE, "pot carried into round 2");
        assertEq(token.balanceOf(p1), 0, "no payout, stake carried");
        assertEq(token.balanceOf(treasury), 0, "no rake on rollover");
    }

    /// Bonus: an empty round also rolls over cleanly.
    function test_Rollover_NoPlayers() public {
        _close();
        uint256[] memory values = new uint256[](0);
        bytes[][] memory sigs = new bytes[][](0);
        game.settle(values, sigs);

        assertEq(game.roundId(), 2, "advanced");
        (, , uint256 pot2, ) = game.getRound(2);
        assertEq(pot2, 0, "empty pot carried");
    }

    function test_SettlerDecryption_OnlyAuthorizedAfterClose() public {
        address player = address(0x44);
        _enter(player, 42);

        bytes32[] memory handles = game.guessHandles(1);
        assertEq(handles.length, 1, "one handle");
        assertFalse(inco.isAllowed(handles[0], settler), "settler must not decrypt open round");

        _close();
        game.authorizeSettlerDecryption(1);

        assertTrue(inco.isAllowed(handles[0], settler), "settler may decrypt only after close");
    }

    function test_Settlement_QueuesWinnerCredit_WhenTransferFails() public {
        address p1 = address(0x1);
        address p2 = address(0x2);
        address p3 = address(0x3);
        address alt = address(0xB0B);

        _enter(p1, 60);
        _enter(p2, 30);
        _enter(p3, 15);
        _close();

        token.setTransferBlocked(p2, true);

        uint256[] memory values = new uint256[](3);
        values[0] = 60; values[1] = 30; values[2] = 15;
        game.settle(values, _sigs(3));

        uint256 pot = 3 * FEE;
        uint256 rake = (pot * RAKE_BPS) / 10_000;
        uint256 net = pot - rake;

        assertEq(token.balanceOf(p2), 0, "blocked winner not auto-paid");
        assertEq(game.pendingPayouts(p2), net, "winner credited instead of freezing");
        assertEq(game.roundId(), 2, "next round still starts");

        token.setTransferBlocked(p2, false);
        vm.prank(p2);
        game.withdrawPayout(alt);

        assertEq(token.balanceOf(alt), net, "winner may redirect payout");
        assertEq(game.pendingPayouts(p2), 0, "credit cleared");
    }

    function test_Settlement_QueuesTreasuryCredit_WhenTransferFails() public {
        address p1 = address(0x11);
        address p2 = address(0x22);
        address p3 = address(0x33);
        address altTreasury = address(0xCAFE);

        _enter(p1, 0);
        _enter(p2, 0);
        _enter(p3, 30);
        _close();

        token.setTransferBlocked(treasury, true);

        uint256[] memory values = new uint256[](3);
        values[0] = 0; values[1] = 0; values[2] = 30;
        game.settle(values, _sigs(3));

        uint256 rake = (3 * FEE * RAKE_BPS) / 10_000;
        assertEq(game.pendingTreasury(), rake, "treasury credit queued");
        assertEq(game.roundId(), 2, "round advances despite treasury failure");

        token.setTransferBlocked(treasury, false);
        game.withdrawTreasury(altTreasury);

        assertEq(token.balanceOf(altTreasury), rake, "owner may recover treasury credit");
        assertEq(game.pendingTreasury(), 0, "treasury credit cleared");
    }
}
