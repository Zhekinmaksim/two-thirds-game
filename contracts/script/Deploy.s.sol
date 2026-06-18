// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TwoThirds, IERC20} from "../src/TwoThirds.sol";

/**
 * Deploy TwoThirds.
 *
 * Required env vars (see .env.example):
 *   PRIVATE_KEY        deployer key (use a throwaway/hardware key, NOT your treasury)
 *   USDC_ADDRESS       the payment token on the target chain
 *   TREASURY_ADDRESS   wallet that receives the rake (use a separate/cold wallet)
 *   SETTLER_ADDRESS    keeper wallet allowed to decrypt guesses at settlement
 *
 * Optional (sensible defaults shown):
 *   ENTRY_FEE          1000000   (1 USDC, 6 decimals)
 *   RAKE_BPS           500       (5%)
 *   ROUND_DURATION     1200      (20 minutes, in seconds)
 *
 * Run:
 *   forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_URL --broadcast -vvvv
 */
contract Deploy is Script {
    function run() external {
        uint256 pk            = vm.envUint("PRIVATE_KEY");
        address token         = vm.envAddress("USDC_ADDRESS");
        address treasury      = vm.envAddress("TREASURY_ADDRESS");
        address settler       = vm.envAddress("SETTLER_ADDRESS");
        uint256 entryFee      = vm.envOr("ENTRY_FEE", uint256(1_000_000));
        uint16  rakeBps       = uint16(vm.envOr("RAKE_BPS", uint256(500)));
        uint64  roundDuration = uint64(vm.envOr("ROUND_DURATION", uint256(1200)));

        vm.startBroadcast(pk);
        TwoThirds game = new TwoThirds(IERC20(token), entryFee, rakeBps, roundDuration, treasury, settler);
        vm.stopBroadcast();

        console2.log("TwoThirds deployed at:", address(game));
        console2.log("  token   :", token);
        console2.log("  treasury:", treasury);
        console2.log("  settler :", settler);
        console2.log("  entryFee:", entryFee);
        console2.log("  rakeBps :", rakeBps);
        console2.log("  round(s):", roundDuration);
    }
}
