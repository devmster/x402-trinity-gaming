// THE SIGNER.
//
// One job: take the challenge the studio's server issued, produce one EIP-712 signature.
// No network, no Unreal types, no state - so it compiles and runs outside the editor and can
// be checked against the same golden vectors the TypeScript and C# implementations pass.
//
// The curve math is OpenSSL's, which Unreal already bundles in Engine/Source/ThirdParty. Two
// reasons: hand-rolling secp256k1 is the riskiest thing we could do here, and a studio should
// not have to vendor a crypto library to take a payment.
//
// KECCAK IS NOT SHA3. OpenSSL ships SHA3-256, which differs from Keccak-256 by a single
// padding byte (0x06 against 0x01). Every hash would be wrong and nothing would crash - the
// contract would simply reject every signature. So Keccak is implemented here, and the vector
// test catches it immediately if it drifts.

#include "X402Signer.h"

#include <cstring>
#include <cstdio>
#include <stdexcept>

// Unreal declares `namespace UI` and OpenSSL declares `typedef struct ui_st UI`, so the two
// cannot be included together as-is. Renaming OpenSSL's type is safe here - nothing in this
// file touches it - and it keeps the collision contained to these five lines.
#define UI OPENSSL_UI_UNUSED
#include <openssl/bn.h>
#include <openssl/ec.h>
#include <openssl/ecdsa.h>
#include <openssl/obj_mac.h>
#include <openssl/rand.h>
#undef UI

namespace X402
{

// ---------------------------------------------------------------------------
// Keccak-256 (FIPS-202 permutation, original Keccak padding)
// ---------------------------------------------------------------------------

namespace
{
    constexpr uint64_t RoundConstants[24] = {
        0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL, 0x8000000080008000ULL,
        0x000000000000808bULL, 0x0000000080000001ULL, 0x8000000080008081ULL, 0x8000000000008009ULL,
        0x000000000000008aULL, 0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
        0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL, 0x8000000000008003ULL,
        0x8000000000008002ULL, 0x8000000000000080ULL, 0x000000000000800aULL, 0x800000008000000aULL,
        0x8000000080008081ULL, 0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL
    };

    constexpr int Rotations[24] = { 1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14,
                                    27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44 };
    constexpr int PiLanes[24]  = { 10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4,
                                   15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1 };

    inline uint64_t Rotl64(uint64_t x, int n) { return (x << n) | (x >> (64 - n)); }

    void KeccakF1600(uint64_t State[25])
    {
        for (int Round = 0; Round < 24; ++Round)
        {
            uint64_t C[5], D;
            for (int i = 0; i < 5; ++i)
                C[i] = State[i] ^ State[i + 5] ^ State[i + 10] ^ State[i + 15] ^ State[i + 20];
            for (int i = 0; i < 5; ++i)
            {
                D = C[(i + 4) % 5] ^ Rotl64(C[(i + 1) % 5], 1);
                for (int j = 0; j < 25; j += 5) State[i + j] ^= D;
            }

            uint64_t Last = State[1];
            for (int i = 0; i < 24; ++i)
            {
                const int Lane = PiLanes[i];
                const uint64_t Tmp = State[Lane];
                State[Lane] = Rotl64(Last, Rotations[i]);
                Last = Tmp;
            }

            for (int j = 0; j < 25; j += 5)
            {
                uint64_t Row[5];
                for (int i = 0; i < 5; ++i) Row[i] = State[j + i];
                for (int i = 0; i < 5; ++i)
                    State[j + i] = Row[i] ^ ((~Row[(i + 1) % 5]) & Row[(i + 2) % 5]);
            }

            State[0] ^= RoundConstants[Round];
        }
    }
}

Bytes Keccak256(const Bytes& Input)
{
    uint64_t State[25] = { 0 };
    const size_t Rate = 136;                 // 1088 bits for Keccak-256

    size_t Offset = 0;
    while (Input.size() - Offset >= Rate)
    {
        for (size_t i = 0; i < Rate / 8; ++i)
        {
            uint64_t Lane = 0;
            for (int b = 0; b < 8; ++b)
                Lane |= static_cast<uint64_t>(Input[Offset + i * 8 + b]) << (8 * b);
            State[i] ^= Lane;
        }
        KeccakF1600(State);
        Offset += Rate;
    }

    uint8_t Block[Rate] = { 0 };
    const size_t Remaining = Input.size() - Offset;
    std::memcpy(Block, Input.data() + Offset, Remaining);
    Block[Remaining] ^= 0x01;                // Keccak padding. SHA3 uses 0x06 here.
    Block[Rate - 1] ^= 0x80;

    for (size_t i = 0; i < Rate / 8; ++i)
    {
        uint64_t Lane = 0;
        for (int b = 0; b < 8; ++b)
            Lane |= static_cast<uint64_t>(Block[i * 8 + b]) << (8 * b);
        State[i] ^= Lane;
    }
    KeccakF1600(State);

    Bytes Out(32);
    for (size_t i = 0; i < 4; ++i)
        for (int b = 0; b < 8; ++b)
            Out[i * 8 + b] = static_cast<uint8_t>((State[i] >> (8 * b)) & 0xff);
    return Out;
}

Bytes Keccak256(std::initializer_list<Bytes> Parts)
{
    Bytes Joined;
    for (const auto& P : Parts) Joined.insert(Joined.end(), P.begin(), P.end());
    return Keccak256(Joined);
}

// ---------------------------------------------------------------------------
// Hex
// ---------------------------------------------------------------------------

Bytes FromHex(const std::string& Hex)
{
    size_t Start = (Hex.size() >= 2 && Hex[0] == '0' && (Hex[1] == 'x' || Hex[1] == 'X')) ? 2 : 0;
    std::string H = Hex.substr(Start);
    if (H.size() % 2 != 0) H.insert(H.begin(), '0');
    Bytes Out(H.size() / 2);
    for (size_t i = 0; i < Out.size(); ++i)
        Out[i] = static_cast<uint8_t>(std::stoul(H.substr(i * 2, 2), nullptr, 16));
    return Out;
}

std::string ToHex(const Bytes& B)
{
    std::string Out = "0x";
    char Buf[3];
    for (uint8_t X : B) { std::snprintf(Buf, sizeof(Buf), "%02x", X); Out += Buf; }
    return Out;
}

// ---------------------------------------------------------------------------
// EIP-712 encoding
// ---------------------------------------------------------------------------

namespace
{
    // Every EIP-712 value occupies a 32-byte big-endian word.
    Bytes Word(const Bytes& V)
    {
        if (V.size() > 32) throw std::runtime_error("value wider than a 32-byte word");
        Bytes W(32, 0);
        std::memcpy(W.data() + (32 - V.size()), V.data(), V.size());
        return W;
    }

    Bytes WordFromDecimal(const std::string& Decimal)
    {
        BIGNUM* N = nullptr;
        if (BN_dec2bn(&N, Decimal.c_str()) == 0 || N == nullptr)
            throw std::runtime_error("not a decimal integer: " + Decimal);
        Bytes W(32, 0);
        // BN_bn2binpad writes big-endian, left-padded - the exact layout a word needs.
        BN_bn2binpad(N, W.data(), 32);
        BN_free(N);
        return W;
    }

    Bytes WordFromAddress(const std::string& Address)
    {
        Bytes A = FromHex(Address);
        if (A.size() != 20) throw std::runtime_error("address must be 20 bytes: " + Address);
        return Word(A);
    }

    Bytes Utf8(const std::string& S) { return Bytes(S.begin(), S.end()); }

    const char* Eip712DomainTypeHash =
        "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f";
    const char* TransferTypeHash =
        "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267";
}

Bytes DomainSeparator(const std::string& Name, const std::string& Version,
                      int64_t ChainId, const std::string& VerifyingContract)
{
    return Keccak256({
        FromHex(Eip712DomainTypeHash),
        Keccak256(Utf8(Name)),
        Keccak256(Utf8(Version)),
        WordFromDecimal(std::to_string(ChainId)),
        WordFromAddress(VerifyingContract),
    });
}

Bytes Digest(const Bytes& DomainSep, const FAuthorization& A)
{
    const Bytes StructHash = Keccak256({
        FromHex(TransferTypeHash),
        WordFromAddress(A.From),
        WordFromAddress(A.To),
        WordFromDecimal(A.Value),
        WordFromDecimal(A.ValidAfter),
        WordFromDecimal(A.ValidBefore),
        Word(FromHex(A.Nonce)),
    });
    return Keccak256({ Bytes{ 0x19, 0x01 }, DomainSep, StructHash });
}

// ---------------------------------------------------------------------------
// secp256k1, via OpenSSL
// ---------------------------------------------------------------------------

namespace
{
    struct FGroup
    {
        EC_GROUP* G = nullptr;
        FGroup()  { G = EC_GROUP_new_by_curve_name(NID_secp256k1); }
        ~FGroup() { if (G) EC_GROUP_free(G); }
    };

    const EC_GROUP* Group()
    {
        static FGroup Instance;
        return Instance.G;
    }

    Bytes PublicKeyBytes(const BIGNUM* Priv)
    {
        EC_POINT* Q = EC_POINT_new(Group());
        BN_CTX* Ctx = BN_CTX_new();
        EC_POINT_mul(Group(), Q, Priv, nullptr, nullptr, Ctx);

        BIGNUM* X = BN_new();
        BIGNUM* Y = BN_new();
        EC_POINT_get_affine_coordinates(Group(), Q, X, Y, Ctx);

        Bytes Pub(64, 0);
        BN_bn2binpad(X, Pub.data(), 32);
        BN_bn2binpad(Y, Pub.data() + 32, 32);

        BN_free(X); BN_free(Y); BN_CTX_free(Ctx); EC_POINT_free(Q);
        return Pub;
    }
}

std::string AddressOf(const std::string& PrivateKeyHex)
{
    const Bytes Key = FromHex(PrivateKeyHex);
    BIGNUM* D = BN_bin2bn(Key.data(), static_cast<int>(Key.size()), nullptr);
    if (!D) throw std::runtime_error("invalid key material");

    const Bytes Pub = PublicKeyBytes(D);
    BN_free(D);

    const Bytes H = Keccak256(Pub);
    return ToHex(Bytes(H.begin() + 12, H.end()));
}

std::string Recover(const Bytes& Digest32, const BIGNUM* R, const BIGNUM* S, int RecId)
{
    // Reconstructs the public key from (r, s, recId) - the same operation a facilitator
    // performs to learn who signed.
    BN_CTX* Ctx = BN_CTX_new();
    BIGNUM* Order = BN_new();
    BIGNUM* X = BN_new();
    EC_POINT* RPoint = nullptr;
    EC_POINT* Q = nullptr;
    std::string Result;

    EC_GROUP_get_order(Group(), Order, Ctx);

    // x = r + (recId / 2) * n
    BN_copy(X, R);
    if (RecId / 2 > 0)
    {
        BIGNUM* Add = BN_new();
        BN_copy(Add, Order);
        BN_mul_word(Add, static_cast<BN_ULONG>(RecId / 2));
        BN_add(X, X, Add);
        BN_free(Add);
    }

    RPoint = EC_POINT_new(Group());
    if (EC_POINT_set_compressed_coordinates(Group(), RPoint, X, RecId & 1, Ctx) == 1)
    {
        BIGNUM* E     = BN_bin2bn(Digest32.data(), 32, nullptr);
        BIGNUM* EInv  = BN_new();
        BIGNUM* RInv  = BN_new();
        BIGNUM* SrInv = BN_new();
        BIGNUM* ErInv = BN_new();

        BN_zero(EInv);
        BN_mod_sub(EInv, EInv, E, Order, Ctx);
        BN_mod_inverse(RInv, R, Order, Ctx);
        BN_mod_mul(SrInv, RInv, S, Order, Ctx);
        BN_mod_mul(ErInv, RInv, EInv, Order, Ctx);

        Q = EC_POINT_new(Group());
        // Q = (e^-1 * r^-1) * G + (s * r^-1) * R
        if (EC_POINT_mul(Group(), Q, ErInv, RPoint, SrInv, Ctx) == 1)
        {
            BIGNUM* QX = BN_new();
            BIGNUM* QY = BN_new();
            if (EC_POINT_get_affine_coordinates(Group(), Q, QX, QY, Ctx) == 1)
            {
                Bytes Pub(64, 0);
                BN_bn2binpad(QX, Pub.data(), 32);
                BN_bn2binpad(QY, Pub.data() + 32, 32);
                const Bytes H = Keccak256(Pub);
                Result = ToHex(Bytes(H.begin() + 12, H.end()));
            }
            BN_free(QX); BN_free(QY);
        }

        BN_free(E); BN_free(EInv); BN_free(RInv); BN_free(SrInv); BN_free(ErInv);
    }

    if (Q) EC_POINT_free(Q);
    if (RPoint) EC_POINT_free(RPoint);
    BN_free(X); BN_free(Order); BN_CTX_free(Ctx);
    return Result;
}

std::string SignDigest(const Bytes& Digest32, const std::string& PrivateKeyHex)
{
    const Bytes KeyBytes = FromHex(PrivateKeyHex);
    BIGNUM* D = BN_bin2bn(KeyBytes.data(), static_cast<int>(KeyBytes.size()), nullptr);
    if (!D) throw std::runtime_error("invalid key material");

    EC_KEY* Key = EC_KEY_new_by_curve_name(NID_secp256k1);
    EC_KEY_set_private_key(Key, D);

    ECDSA_SIG* Sig = ECDSA_do_sign(Digest32.data(), 32, Key);
    if (!Sig) { EC_KEY_free(Key); BN_free(D); throw std::runtime_error("signing failed"); }

    const BIGNUM* R = nullptr;
    const BIGNUM* S = nullptr;
    ECDSA_SIG_get0(Sig, &R, &S);

    BN_CTX* Ctx = BN_CTX_new();
    BIGNUM* Order = BN_new();
    BIGNUM* HalfOrder = BN_new();
    EC_GROUP_get_order(Group(), Order, Ctx);
    BN_rshift1(HalfOrder, Order);

    // Both s and n-s are valid ECDSA; Ethereum rejects the high form.
    BIGNUM* SNorm = BN_dup(S);
    if (BN_cmp(SNorm, HalfOrder) > 0) BN_sub(SNorm, Order, SNorm);

    const std::string Expected = AddressOf(PrivateKeyHex);
    int RecId = -1;
    for (int i = 0; i < 4; ++i)
    {
        const std::string Got = Recover(Digest32, R, SNorm, i);
        if (!Got.empty() && Got == Expected) { RecId = i; break; }
    }

    std::string Out;
    if (RecId >= 0)
    {
        Bytes Signature(65, 0);
        BN_bn2binpad(R, Signature.data(), 32);
        BN_bn2binpad(SNorm, Signature.data() + 32, 32);
        Signature[64] = static_cast<uint8_t>(27 + RecId);
        Out = ToHex(Signature);
    }

    BN_free(SNorm); BN_free(HalfOrder); BN_free(Order); BN_CTX_free(Ctx);
    ECDSA_SIG_free(Sig); EC_KEY_free(Key); BN_free(D);

    if (Out.empty()) throw std::runtime_error("could not derive a recovery id");
    return Out;
}

std::string RecoverFromBn(const Bytes& Digest32, const void* R, const void* S, int RecId)
{
    return Recover(Digest32, static_cast<const BIGNUM*>(R), static_cast<const BIGNUM*>(S), RecId);
}

int64_t ChainIdFrom(const std::string& Network)
{
    if (Network.rfind("eip155:", 0) == 0) return std::stoll(Network.substr(7));
    if (Network == "base") return 8453;
    throw std::runtime_error("unknown network: " + Network);
}

FSignedPurchase Sign(const FQuote& Quote, const std::string& PrivateKeyHex, int64_t NowUnix)
{
    FAuthorization Auth;
    Auth.From  = AddressOf(PrivateKeyHex);
    Auth.To    = Quote.PayTo;
    Auth.Value = Quote.Amount;

    // Sixty seconds of slack: a player's clock is not the chain's, and a validAfter in the
    // future makes the transfer revert.
    Auth.ValidAfter  = std::to_string(NowUnix - 60);
    Auth.ValidBefore = std::to_string(NowUnix + (Quote.MaxTimeoutSeconds > 0 ? Quote.MaxTimeoutSeconds : 600));

    Bytes NonceBytes(32);
    if (RAND_bytes(NonceBytes.data(), 32) != 1)
        throw std::runtime_error("no secure randomness available");
    Auth.Nonce = ToHex(NonceBytes);

    const Bytes DSep = DomainSeparator(
        Quote.DomainName.empty() ? "USD Coin" : Quote.DomainName,
        Quote.DomainVersion.empty() ? "2" : Quote.DomainVersion,
        ChainIdFrom(Quote.Network),
        Quote.Asset);

    FSignedPurchase Result;
    Result.Authorization = Auth;
    Result.Signature     = SignDigest(Digest(DSep, Auth), PrivateKeyHex);
    Result.PlayerAddress = Auth.From;
    return Result;
}

} // namespace X402
