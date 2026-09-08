// The signer's public surface.
//
// Plain C++ on purpose - no UObject, no FString, no Unreal headers. That keeps it compilable
// outside the editor, which is the only way it can be checked against the golden vectors the
// TypeScript and C# implementations already pass.
//
// The Unreal-facing subsystem wraps this; it does not reimplement it.

#pragma once

#include <cstdint>
#include <initializer_list>
#include <string>
#include <vector>

namespace X402
{
    using Bytes = std::vector<uint8_t>;

    /// An EIP-3009 authorization. Field order matches the ABI encoding order.
    struct FAuthorization
    {
        std::string From;
        std::string To;
        std::string Value;        // atomic units, decimal string - never a float
        std::string ValidAfter;
        std::string ValidBefore;
        std::string Nonce;        // 32 bytes, 0x-prefixed
    };

    /// What the studio's server says must be signed.
    struct FQuote
    {
        std::string Network;      // "eip155:8453" or "base"
        std::string Amount;       // atomic units
        std::string PayTo;
        std::string Asset;        // the USDC contract
        int32_t     MaxTimeoutSeconds = 600;
        std::string DomainName;      // "USD Coin"
        std::string DomainVersion;   // "2"
    };

    struct FSignedPurchase
    {
        FAuthorization Authorization;
        std::string    Signature;      // 65 bytes, 0x-prefixed
        std::string    PlayerAddress;
    };

    /// Keccak-256. NOT SHA3-256 - they differ by one padding byte and every hash would be wrong.
    Bytes Keccak256(const Bytes& Input);
    Bytes Keccak256(std::initializer_list<Bytes> Parts);

    Bytes       FromHex(const std::string& Hex);
    std::string ToHex(const Bytes& B);

    /// EIP-712 domain separator for the asset contract.
    Bytes DomainSeparator(const std::string& Name, const std::string& Version,
                          int64_t ChainId, const std::string& VerifyingContract);

    /// The 32 bytes actually signed: 0x1901 || domainSeparator || structHash.
    Bytes Digest(const Bytes& DomainSep, const FAuthorization& A);

    /// The address a key controls.
    std::string AddressOf(const std::string& PrivateKeyHex);

    /// Recover the signer's address from (digest, r, s, recId) - what a facilitator does.
    /// Declared with void* so the header stays free of OpenSSL includes; pass BIGNUM*.
    std::string RecoverFromBn(const Bytes& Digest32, const void* R, const void* S, int RecId);

    /// Sign 32 bytes. Returns r || s || v with v as 27/28, low-s normalised.
    std::string SignDigest(const Bytes& Digest32, const std::string& PrivateKeyHex);

    /// Sign a quote, minting a fresh nonce and an expiry.
    FSignedPurchase Sign(const FQuote& Quote, const std::string& PrivateKeyHex, int64_t NowUnix);

    int64_t ChainIdFrom(const std::string& Network);
}
