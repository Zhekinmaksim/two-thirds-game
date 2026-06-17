// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Inco Lightning mainnet library.
//   install:  npm i @inco/lightning
//   inco executor (mainnet): 0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624
import {euint256, ebool, e} from "@inco/lightning/Lib.sol";

/**
 * TwoThirds — a confidential "guess 2/3 of the average" game.
 *
 * HOW IT WORKS
 *  - Rounds run on a fixed schedule (default 1 hour).
 *  - To play you pay a fixed entry fee (e.g. 1 USDC) and submit your guess 0..63
 *    ENCRYPTED. While the round is open nobody — not other players, not the RPC,
 *    not the contract owner — can read any guess. That is the whole point: on a
 *    transparent chain the last player could read everyone else and win for free.
 *  - When the round closes, the encrypted guesses are decrypted by Inco's network,
 *    after the contract explicitly opens decryption for the configured settler.
 *    The network returns each value together with a signed attestation. Anyone may
 *    call settle() with those attested values; the contract verifies every signature
 *    on chain (e.verifyDecryption) so the settler CANNOT lie about the numbers.
 *  - target = floor( 2 * sum(guesses) / (3 * n) ). Closest guess wins the pot.
 *    Ties split the pot equally. The house takes a small rake.
 *
 * TRUST MODEL
 *  - Fairness does not depend on the settler learning guesses during an open round:
 *    decrypt permission is granted only after closesAt. The winning number is
 *    derived from the players' own guesses, and every decrypted value is verified
 *    against an Inco attestation before it is used. Settlement remains permissionless.
 *  - The owner controls only economic parameters (fee, rake, schedule) and pause,
 *    and can never see guesses or pick the winner.
 *
 * NOT AUDITED. Review and test on testnet before mainnet money.
 */
contract TwoThirds {
    using e for *;

    // ---- config ----
    IERC20  public immutable token;       // payment token (e.g. USDC)
    uint256 public entryFee;              // fixed entry, in token's smallest unit (1 USDC = 1e6)
    uint16  public rakeBps;               // house cut in basis points (500 = 5%), capped at 10%
    uint64  public roundDuration;         // seconds (default 1 hour)
    address public treasury;              // receives the rake
    address public settler;               // keeper allowed to decrypt guesses for settlement
    address public owner;
    bool    public paused;

    uint16  public constant MAX_GUESS   = 63;   // 64 cards, numbered 0..63
    uint16  public constant MAX_RAKE    = 1000; // 10%
    uint16  public constant MIN_PLAYERS = 2;    // below this, the pot rolls into the next round
    uint16  public constant MAX_PLAYERS = 50;   // matches the 8x8 board UI and keeps settle() bounded

    // ---- round state ----
    struct Round {
        uint64  closesAt;
        bool    settled;
        uint256 pot;
        address[] players;
    }
    uint256 public roundId;
    mapping(uint256 => Round) private rounds;
    mapping(uint256 => mapping(address => bool))     public entered;     // rid => player => joined?
    mapping(uint256 => mapping(address => euint256)) private guessOf;    // rid => player => encrypted guess
    mapping(uint256 => bool) public decryptionAuthorized;
    mapping(address => uint256) public pendingPayouts;
    uint256 public pendingTreasury;

    // ---- reentrancy guard ----
    uint256 private _lock = 1;
    modifier nonReentrant() { require(_lock == 1, "reentrant"); _lock = 2; _; _lock = 1; }
    modifier onlyOwner()    { require(msg.sender == owner, "not owner"); _; }

    // ---- events ----
    event Entered(uint256 indexed rid, address indexed player, uint256 pot);
    event Settled(uint256 indexed rid, uint16 target, uint16 avgX1, uint256 netPot, uint256 payPerWinner, uint256 winners);
    event RolledOver(uint256 indexed rid, uint256 carriedPot, uint256 players);
    event RoundStarted(uint256 indexed rid, uint64 closesAt, uint256 seedPot);
    event ParamsChanged(uint256 entryFee, uint16 rakeBps, uint64 roundDuration, address treasury);
    event DecryptionAuthorized(uint256 indexed rid, address indexed settler);
    event PayoutQueued(uint256 indexed rid, address indexed account, uint256 amount);
    event TreasuryQueued(uint256 indexed rid, uint256 amount);
    event PayoutWithdrawn(address indexed account, address indexed to, uint256 amount);
    event TreasuryWithdrawn(address indexed to, uint256 amount);
    event RoundDecrypted(uint256 indexed rid, uint16[] numbers);

    constructor(
        IERC20 _token,
        uint256 _entryFee,
        uint16 _rakeBps,
        uint64 _roundDuration,
        address _treasury,
        address _settler
    ) {
        require(address(_token) != address(0) && _treasury != address(0) && _settler != address(0), "zero addr");
        require(_rakeBps <= MAX_RAKE, "rake too high");
        require(_roundDuration >= 60, "duration too short");
        token = _token;
        entryFee = _entryFee;
        rakeBps = _rakeBps;
        roundDuration = _roundDuration;
        treasury = _treasury;
        settler = _settler;
        owner = msg.sender;
        _startRound(0); // first round, no seed pot
    }

    // ----------------------------------------------------------------- play

    /**
     * Join the current round with an encrypted guess (0..63).
     * @param ciphertext output of the Inco JS SDK encrypt() bound to (msg.sender, this contract).
     *
     * Pull-payment: caller must approve `entryFee` of `token` to this contract first.
     */
    function enter(bytes calldata ciphertext) external nonReentrant {
        require(!paused, "paused");
        Round storage r = rounds[roundId];
        require(block.timestamp < r.closesAt, "round closed");
        require(r.players.length < MAX_PLAYERS, "round full");
        require(!entered[roundId][msg.sender], "already entered");

        // collect the fixed entry fee
        _safeTransferFrom(token, msg.sender, address(this), entryFee);

        // verify + bind the encrypted guess to this player, store the handle
        euint256 g = e.newEuint256(ciphertext, msg.sender);
        g.allowThis();                  // this contract may reference the handle
        guessOf[roundId][msg.sender] = g;

        entered[roundId][msg.sender] = true;
        r.players.push(msg.sender);
        r.pot += entryFee;

        emit Entered(roundId, msg.sender, r.pot);
    }

    // ----------------------------------------------------------------- settle

    /**
     * Settle the current round once it has closed. Permissionless.
     *
     * The caller supplies, IN THE SAME ORDER as getPlayers(roundId), each player's
     * decrypted guess and the Inco attestation signatures for it. Every value is
     * verified on chain, so a dishonest caller cannot alter the outcome.
     *
     * @param values     decrypted guess for players[i]
     * @param signatures Inco covalidator signatures attesting values[i] for the handle
     */
    function settle(uint256[] calldata values, bytes[][] calldata signatures)
        external
        nonReentrant
    {
        uint256 rid = roundId;
        Round storage r = rounds[rid];
        require(block.timestamp >= r.closesAt, "round open");
        require(!r.settled, "settled");

        uint256 n = r.players.length;
        require(values.length == n && signatures.length == n, "len mismatch");

        r.settled = true;

        // not enough players: roll the whole pot into the next round
        if (n < MIN_PLAYERS) {
            uint256 carried = r.pot;
            emit RolledOver(rid, carried, n);
            _startRound(carried);
            return;
        }

        // verify each attested guess and accumulate the (clamped) sum
        uint16[] memory guesses = new uint16[](n);
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            euint256 handle = guessOf[rid][r.players[i]];
            require(handle.verifyDecryption(values[i], signatures[i]), "bad attestation");
            uint16 v = values[i] > MAX_GUESS ? MAX_GUESS : uint16(values[i]); // clamp; no griefing
            guesses[i] = v;
            sum += v;
        }

        // target = floor(2 * sum / (3 * n)); avgX1 kept for the UI (avg rounded)
        uint16 target = uint16((2 * sum) / (3 * n));
        uint16 avgX1  = uint16(sum / n);

        // find minimum distance to target
        uint256 dmin = type(uint256).max;
        for (uint256 i; i < n; ++i) {
            uint256 d = guesses[i] > target ? guesses[i] - target : target - guesses[i];
            if (d < dmin) dmin = d;
        }

        // count winners
        uint256 wCount;
        for (uint256 i; i < n; ++i) {
            uint256 d = guesses[i] > target ? guesses[i] - target : target - guesses[i];
            if (d == dmin) ++wCount;
        }

        // split the pot
        uint256 pot     = r.pot;
        uint256 rake    = (pot * rakeBps) / 10_000;
        uint256 netPot  = pot - rake;
        uint256 pay     = netPot / wCount;
        uint256 dust    = netPot - (pay * wCount);

        if (rake > 0 && !_tryTransfer(token, treasury, rake)) {
            pendingTreasury += rake;
            emit TreasuryQueued(rid, rake);
        }
        for (uint256 i; i < n; ++i) {
            uint256 d = guesses[i] > target ? guesses[i] - target : target - guesses[i];
            if (d == dmin && !_tryTransfer(token, r.players[i], pay)) {
                pendingPayouts[r.players[i]] += pay;
                emit PayoutQueued(rid, r.players[i], pay);
            }
        }

        emit Settled(rid, target, avgX1, netPot, pay, wCount);
        emit RoundDecrypted(rid, guesses);

        // remainder from integer division seeds the next round's pot
        _startRound(dust);
    }

    // ----------------------------------------------------------------- views

    function getRound(uint256 rid)
        external view
        returns (uint64 closesAt, bool settled, uint256 pot, uint256 playerCount)
    {
        Round storage r = rounds[rid];
        return (r.closesAt, r.settled, r.pot, r.players.length);
    }

    function getPlayers(uint256 rid) external view returns (address[] memory) {
        return rounds[rid].players;
    }

    /// Encrypted guess handles for a round, in player order — feed these to the
    /// Inco SDK's attestedDecrypt()/attestedReveal() off chain to produce the
    /// values + signatures that settle() expects.
    function guessHandles(uint256 rid) external view returns (bytes32[] memory out) {
        Round storage r = rounds[rid];
        uint256 n = r.players.length;
        out = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = euint256.unwrap(guessOf[rid][r.players[i]]);
        }
    }

    /**
     * Opens decryption for a closed round by granting the configured settler access
     * to every stored guess handle. This can only happen after the round is closed.
     */
    function authorizeSettlerDecryption(uint256 rid) public {
        Round storage r = rounds[rid];
        require(block.timestamp >= r.closesAt, "round open");
        require(!r.settled, "settled");
        if (decryptionAuthorized[rid]) return;

        uint256 n = r.players.length;
        for (uint256 i; i < n; ++i) {
            guessOf[rid][r.players[i]].allow(settler);
        }

        decryptionAuthorized[rid] = true;
        emit DecryptionAuthorized(rid, settler);
    }

    function withdrawPayout(address to) external nonReentrant {
        require(to != address(0), "zero addr");
        uint256 amount = pendingPayouts[msg.sender];
        require(amount > 0, "nothing owed");

        pendingPayouts[msg.sender] = 0;
        require(_tryTransfer(token, to, amount), "transfer failed");
        emit PayoutWithdrawn(msg.sender, to, amount);
    }

    function withdrawTreasury(address to) external onlyOwner nonReentrant {
        require(to != address(0), "zero addr");
        uint256 amount = pendingTreasury;
        require(amount > 0, "nothing owed");

        pendingTreasury = 0;
        require(_tryTransfer(token, to, amount), "transfer failed");
        emit TreasuryWithdrawn(to, amount);
    }

    // ----------------------------------------------------------------- admin

    function setParams(uint256 _entryFee, uint16 _rakeBps, uint64 _roundDuration, address _treasury)
        external onlyOwner
    {
        require(_rakeBps <= MAX_RAKE, "rake too high");
        require(_roundDuration >= 60, "duration too short");
        require(_treasury != address(0), "zero addr");
        entryFee = _entryFee;
        rakeBps = _rakeBps;
        roundDuration = _roundDuration;
        treasury = _treasury;
        emit ParamsChanged(_entryFee, _rakeBps, _roundDuration, _treasury);
    }

    function setPaused(bool p) external onlyOwner { paused = p; }

    function setSettler(address s) external onlyOwner {
        require(s != address(0), "zero addr");
        settler = s;
    }

    function transferOwnership(address n) external onlyOwner {
        require(n != address(0), "zero addr");
        owner = n;
    }

    // ----------------------------------------------------------------- internal

    function _startRound(uint256 seedPot) internal {
        roundId += 1;
        Round storage r = rounds[roundId];
        r.closesAt = uint64(block.timestamp + roundDuration);
        r.pot = seedPot;
        emit RoundStarted(roundId, r.closesAt, seedPot);
    }

    function _safeTransfer(IERC20 t, address to, uint256 amt) internal {
        (bool ok, bytes memory data) = address(t).call(abi.encodeWithSelector(t.transfer.selector, to, amt));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
    }

    function _tryTransfer(IERC20 t, address to, uint256 amt) internal returns (bool) {
        (bool ok, bytes memory data) = address(t).call(abi.encodeWithSelector(t.transfer.selector, to, amt));
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }

    function _safeTransferFrom(IERC20 t, address from, address to, uint256 amt) internal {
        (bool ok, bytes memory data) = address(t).call(abi.encodeWithSelector(t.transferFrom.selector, from, to, amt));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transferFrom failed");
    }
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
