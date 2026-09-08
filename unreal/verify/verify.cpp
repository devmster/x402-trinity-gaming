// THE CROSS-CHECK.
//
// The C++ signer must reproduce the TypeScript implementation byte for byte. Every
// intermediate value is asserted separately - keccak, the type hash, the domain separator,
// the digest - so a mismatch names the step that drifted rather than just "signature wrong".
//
// Builds outside Unreal on purpose: the signer has no Unreal dependencies, so it can be
// proven before anything is wired into an engine.

#include "../Source/X402Gaming/Public/X402Signer.h"

#include <cstdio>
#include <string>
#include <vector>

#include <openssl/bn.h>
#include <openssl/ec.h>
#include <openssl/obj_mac.h>

using namespace X402;

static int Passed = 0;
static int Failed = 0;

static void Check(const char* Name, bool Condition, const std::string& Detail = "")
{
    if (Condition) { ++Passed; std::printf("  ok    %s%s%s\n", Name,
                                           Detail.empty() ? "" : "  ", Detail.c_str()); }
    else           { ++Failed; std::printf("  FAIL  %s  %s\n", Name, Detail.c_str()); }
}

static void CheckEqual(const char* Name, const std::string& Expected, const std::string& Got)
{
    if (Expected == Got) { ++Passed; std::printf("  ok    %s\n", Name); }
    else
    {
        ++Failed;
        std::printf("  FAIL  %s\n          expected %s\n          got      %s\n",
                    Name, Expected.c_str(), Got.c_str());
    }
}

// The golden vectors, pinned. These came from the TypeScript signer; they are duplicated here
// rather than parsed from JSON so the harness needs no dependencies to build.
static const char* VEC_KECCAK_EMPTY =
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
static const char* VEC_TYPE_HASH =
    "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267";
static const char* VEC_PRIVATE_KEY =
    "0x1111111111111111111111111111111111111111111111111111111111111111";
static const char* VEC_ADDRESS =
    "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";
static const char* VEC_DOMAIN_SEP =
    "0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f";
static const char* VEC_DIGEST =
    "0x44f032cdbeacccb54264060a058e0cd7197acc0767691e6e60d4e9093196710d";
static const char* USDC_BASE =
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

int main()
{
    std::printf("\nC++ signer against the golden vectors\n");
    std::printf("------------------------------------\n");

    // If this is wrong everything downstream is wrong, and the usual cause is reaching for
    // SHA3-256, which differs from Keccak-256 only in its padding byte.
    CheckEqual("keccak256(\"\") matches the reference", VEC_KECCAK_EMPTY, ToHex(Keccak256(Bytes{})));

    const std::string TypeString =
        "TransferWithAuthorization(address from,address to,uint256 value,"
        "uint256 validAfter,uint256 validBefore,bytes32 nonce)";
    CheckEqual("the struct type hash matches", VEC_TYPE_HASH,
               ToHex(Keccak256(Bytes(TypeString.begin(), TypeString.end()))));

    CheckEqual("address derivation matches", VEC_ADDRESS, AddressOf(VEC_PRIVATE_KEY));

    CheckEqual("the Base mainnet domain separator matches", VEC_DOMAIN_SEP,
               ToHex(DomainSeparator("USD Coin", "2", 8453, USDC_BASE)));

    // The decisive one: the exact 32 bytes signed, for a fully pinned authorization.
    FAuthorization Auth;
    Auth.From        = VEC_ADDRESS;
    Auth.To          = "0x9f2c4a1b3d5e6f708192a3b4c5d6e7f809a1b2c3";
    Auth.Value       = "1500000";
    Auth.ValidAfter  = "1700000000";
    Auth.ValidBefore = "1700003600";
    Auth.Nonce       = "0xabababababababababababababababababababababababababababababababab";
    CheckEqual("the EIP-712 digest matches", VEC_DIGEST,
               ToHex(Digest(FromHex(VEC_DOMAIN_SEP), Auth)));

    // A signature cannot be compared to a fixed vector, so assert what a facilitator checks.
    const std::string Sig = SignDigest(FromHex(VEC_DIGEST), VEC_PRIVATE_KEY);
    Check("a signature is 65 bytes", Sig.size() == 132, Sig.substr(0, 20) + "...");

    BIGNUM* R = nullptr;
    BIGNUM* S = nullptr;
    {
        const Bytes Raw = FromHex(Sig);
        R = BN_bin2bn(Raw.data(), 32, nullptr);
        S = BN_bin2bn(Raw.data() + 32, 32, nullptr);
        const int V = Raw[64];
        Check("v is 27 or 28", V == 27 || V == 28, std::to_string(V));

        const std::string Recovered = RecoverFromBn(FromHex(VEC_DIGEST), R, S, V - 27);
        CheckEqual("the signature recovers to the signer", VEC_ADDRESS, Recovered);

        // Both s and n-s are valid ECDSA; Ethereum rejects the high form.
        BN_CTX* Ctx = BN_CTX_new();
        BIGNUM* Order = BN_new();
        BIGNUM* Half = BN_new();
        EC_GROUP* G = EC_GROUP_new_by_curve_name(NID_secp256k1);
        EC_GROUP_get_order(G, Order, Ctx);
        BN_rshift1(Half, Order);
        Check("the signature is low-s", BN_cmp(S, Half) <= 0);
        EC_GROUP_free(G); BN_free(Half); BN_free(Order); BN_CTX_free(Ctx);
    }
    BN_free(R); BN_free(S);

    // A full sign, checking the authorization is bounded the way it must be.
    FQuote Quote;
    Quote.Network = "eip155:8453";
    Quote.Amount  = "1500000";
    Quote.PayTo   = "0x9f2c4a1b3d5e6f708192a3b4c5d6e7f809a1b2c3";
    Quote.Asset   = USDC_BASE;
    Quote.MaxTimeoutSeconds = 600;
    Quote.DomainName = "USD Coin";
    Quote.DomainVersion = "2";

    const FSignedPurchase A = Sign(Quote, VEC_PRIVATE_KEY, 1700000000);
    const FSignedPurchase B = Sign(Quote, VEC_PRIVATE_KEY, 1700000000);
    Check("it pays the named recipient", A.Authorization.To == Quote.PayTo);
    Check("for exactly the asking amount", A.Authorization.Value == Quote.Amount);
    Check("from the signer", A.Authorization.From == std::string(VEC_ADDRESS));
    Check("and it expires", A.Authorization.ValidBefore == "1700000600", A.Authorization.ValidBefore);
    Check("every purchase carries a fresh nonce", A.Authorization.Nonce != B.Authorization.Nonce);

    std::printf("\n  %d passed, %d failed\n\n", Passed, Failed);
    return Failed ? 1 : 0;
}
