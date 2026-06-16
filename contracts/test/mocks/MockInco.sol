// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DecryptionAttestation} from "@inco/lightning/lightning-parts/DecryptionAttester.types.sol";

// MockInco - a stand-in for the Inco Lightning executor, FOR LOCAL TESTS ONLY.
//
// The real Inco Lightning library makes external calls to the executor at
// 0x4b9911b0191B0b6a6eA8F2Ed562e20Cff5AC8624 for:
//   - getFee()                          (fee accounting)
//   - newEuint256(bytes, address)       (register an encrypted input -> handle)
//   - allow(bytes32, address)           (access control)
//   - incoVerifier()                    (returns the attestation verifier)
//   - isValidDecryptionAttestation(...) (the verifier checks a decrypted value)
//
// In tests we vm.etch THIS code at the executor address. Because there is no real
// FHE here, the "ciphertext" passed to newEuint256 is abi.encode(uint256 guess);
// the mock records that plaintext per handle and later confirms that the value
// supplied to settle() matches - so settle must provide the true guesses or
// verification fails, exactly like real attestations.
contract MockInco {
    uint256 private nonce;
    mapping(bytes32 => uint256) public valueOf; // handle => plaintext (test-only)

    function getFee() external pure returns (uint256) {
        return 0;
    }

    function newEuint256(bytes calldata ciphertext, address /*user*/)
        external
        payable
        returns (bytes32 handle)
    {
        handle = keccak256(abi.encode(ciphertext, nonce++));
        valueOf[handle] = abi.decode(ciphertext, (uint256));
    }

    function allow(bytes32, address) external {}

    function incoVerifier() external view returns (address) {
        return address(this);
    }

    function isValidDecryptionAttestation(DecryptionAttestation calldata d, bytes[] calldata)
        external
        view
        returns (bool)
    {
        return valueOf[d.handle] == uint256(d.value);
    }
}
