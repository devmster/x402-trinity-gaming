// THE PLAYER-SIDE PROTOCOL FEE, in C++.
//
// The arithmetic here must match src/player-fee.ts and unity/Runtime/X402PlayerFee.cs
// exactly. An Unreal game, a Unity game and a TypeScript backend can all be clients of the
// same storefront, and a divergence between them would surface as a shortfall in the vault
// rather than as an error anywhere. The verify harness asserts the same figures all three
// produce - 10100 for a hundred purchases of $0.001, 60000 for five of $10.

#include "X402PlayerFee.h"

#include <chrono>
#include <cstdio>
#include <stdexcept>

// Unreal's namespace defines UI, and OpenSSL typedefs it. Same collision the signer hits,
// same fix - and it is invisible outside a real engine build, which is why it is repeated
// here rather than assumed.
#ifndef UI
#define UI OPENSSL_UI_UNUSED
#define X402_UNDEF_UI 1
#endif
#include <openssl/rand.h>
#ifdef X402_UNDEF_UI
#undef UI
#undef X402_UNDEF_UI
#endif

namespace X402
{
    namespace
    {
        /// Where the fee lands. The same vault every other surface pays.
        const char* FEE_VAULT = "0x2f011f21D6Ec758Bc18f0f9142EeD01Ce2d8a0d3";
        const uint64_t FEE_PPM = 1000;          // 0.1% of every purchase
        const int32_t  FEE_EVERY = 100;         // plus a flat charge once every hundred
        const uint64_t FEE_AMOUNT = 10000;      // $0.01
        const uint64_t FEE_SCALE = 1000000;     // tally precision, so sub-unit fees are not lost
        const char* FEE_COLLECTOR =
            "https://x402-trinity-collector.x402trinity.workers.dev/submit";

        std::string U64(uint64_t V)
        {
            char Buf[32];
            std::snprintf(Buf, sizeof(Buf), "%llu", static_cast<unsigned long long>(V));
            return Buf;
        }

        std::string I64(int64_t V)
        {
            char Buf[32];
            std::snprintf(Buf, sizeof(Buf), "%lld", static_cast<long long>(V));
            return Buf;
        }

        uint64_t ParseU64(const std::string& S)
        {
            try { return static_cast<uint64_t>(std::stoull(S)); }
            catch (...) { return 0; }
        }

        int64_t NowUnix()
        {
            using namespace std::chrono;
            return duration_cast<seconds>(system_clock::now().time_since_epoch()).count();
        }
    }

    FPlayerFee::FPlayerFee(const std::string& PrivateKeyHex,
                           const FQuote& Quote,
                           FPoster InPoster,
                           const FSurchargeConfig& Config)
        : PrivateKey(PrivateKeyHex)
        , Every(Config.Every > 0 ? Config.Every : FEE_EVERY)
        , Collector(Config.Collector.empty() ? FEE_COLLECTOR : Config.Collector)
        , Poster(InPoster)
    {
        if (Config.bDisabled || PrivateKeyHex.empty() || !InPoster) return;

        // A chain we cannot name is a chain we cannot sign for. Disable rather than throw:
        // a fee must never be the reason a purchase fails.
        try
        {
            ChainId = ChainIdFrom(Quote.Network);
            Asset = Quote.Asset;
            DomainName = Quote.DomainName.empty() ? "USD Coin" : Quote.DomainName;
            DomainVersion = Quote.DomainVersion.empty() ? "2" : Quote.DomainVersion;
            FromAddress = AddressOf(PrivateKeyHex);
            Caip2 = "eip155:" + I64(ChainId);
            bEnabled = ChainId > 0 && !Asset.empty() && !FromAddress.empty();
        }
        catch (...)
        {
            bEnabled = false;
        }
    }

    void FPlayerFee::Record(
        const std::string& Spent,
        const std::function<void(const std::string&, const std::string&)>& OnDiagnostic)
    {
        if (!bEnabled) return;

        try
        {
            // A previous hand-off never confirmed: re-send that exact authorization first. It
            // is still redeemable until validBefore, and its nonce makes a double-settle
            // impossible, so this is strictly safer than letting it expire.
            if (bHasPending)
            {
                const int64_t Expiry = static_cast<int64_t>(ParseU64(Pending.ValidBefore));
                if (Expiry > NowUnix() + 5)
                {
                    FAuthorization Held = Pending;
                    std::string HeldSig = PendingSig;
                    Poster(Collector, BuildBody(Held, HeldSig), [this, Held](bool bOk)
                    {
                        if (bOk)
                        {
                            Collected += ParseU64(Held.Value);
                            bHasPending = false;
                            PendingSig.clear();
                        }
                    });
                }
                else
                {
                    Lost += ParseU64(Pending.Value);
                    if (OnDiagnostic)
                        OnDiagnostic("fee_expired",
                            "a held fee authorization for " + Pending.Value + " expired uncollected");
                    bHasPending = false;
                    PendingSig.clear();
                }
            }

            // The percentage is owed on THIS purchase; the flat charge on the hundredth. Both
            // accrue and go out together in ONE authorization.
            Accrued += ParseU64(Spent) * FEE_PPM;
            Count += 1;
            if (Count < Every) return;

            const uint64_t Owed = Accrued / FEE_SCALE + FEE_AMOUNT;
            // Reset BEFORE signing, so a failed hand-off cannot charge the player twice.
            Accrued = Accrued % FEE_SCALE;
            Count = 0;
            if (Owed == 0) return;

            Sweep(Owed, OnDiagnostic);
        }
        catch (const std::exception& E)
        {
            if (OnDiagnostic) OnDiagnostic("fee_error", E.what());
        }
        catch (...)
        {
            if (OnDiagnostic) OnDiagnostic("fee_error", "unknown failure");
        }
    }

    void FPlayerFee::Sweep(
        uint64_t Owed,
        const std::function<void(const std::string&, const std::string&)>& OnDiagnostic)
    {
        Bytes NonceBytes(32);
        if (RAND_bytes(NonceBytes.data(), 32) != 1)
        {
            if (OnDiagnostic) OnDiagnostic("fee_error", "no secure randomness available");
            return;
        }

        const int64_t Now = NowUnix();
        FAuthorization Auth;
        Auth.From = FromAddress;
        Auth.To = FEE_VAULT;
        Auth.Value = U64(Owed);
        Auth.ValidAfter = I64(Now - 60);
        Auth.ValidBefore = I64(Now + 3600);
        Auth.Nonce = ToHex(NonceBytes);

        const Bytes DSep = DomainSeparator(DomainName, DomainVersion, ChainId, Asset);
        const std::string Sig = SignDigest(Digest(DSep, Auth), PrivateKey);

        Poster(Collector, BuildBody(Auth, Sig), [this, Auth, Sig, OnDiagnostic, Owed](bool bOk)
        {
            if (bOk)
            {
                Collected += Owed;
            }
            else
            {
                Pending = Auth;
                PendingSig = Sig;
                bHasPending = true;
                if (OnDiagnostic)
                    OnDiagnostic("fee_held", "fee authorization for " + Auth.Value + " held for retry");
            }
        });
    }

    std::string FPlayerFee::BuildBody(const FAuthorization& Auth, const std::string& Signature) const
    {
        // Hand-built rather than a JSON library: the plugin must not drag a dependency into
        // an engine build, and every value here is a known-safe token.
        std::string B;
        B.reserve(1024);
        B += "{\"x402Version\":1,\"paymentPayload\":{\"x402Version\":1,\"scheme\":\"exact\",";
        B += "\"network\":\"" + Caip2 + "\",\"payload\":{\"signature\":\"" + Signature + "\",";
        B += "\"authorization\":{";
        B += "\"from\":\"" + Auth.From + "\",";
        B += "\"to\":\"" + Auth.To + "\",";
        B += "\"value\":\"" + Auth.Value + "\",";
        B += "\"validAfter\":\"" + Auth.ValidAfter + "\",";
        B += "\"validBefore\":\"" + Auth.ValidBefore + "\",";
        B += "\"nonce\":\"" + Auth.Nonce + "\"}}},";
        B += "\"paymentRequirements\":{\"scheme\":\"exact\",\"network\":\"" + Caip2 + "\",";
        B += "\"payTo\":\"" + std::string(FEE_VAULT) + "\",";
        B += "\"asset\":\"" + Asset + "\",";
        B += "\"maxAmountRequired\":\"" + Auth.Value + "\",";
        B += "\"amount\":\"" + Auth.Value + "\",";
        B += "\"resource\":\"https://x402-trinity.dev/fee\",";
        B += "\"description\":\"x402 protocol fee\",";
        B += "\"mimeType\":\"application/json\",\"maxTimeoutSeconds\":300,";
        B += "\"extra\":{\"name\":\"" + DomainName + "\",\"version\":\"" + DomainVersion + "\"}}}";
        return B;
    }

    FFeeStats FPlayerFee::Stats() const
    {
        FFeeStats S;
        S.bEnabled = bEnabled;
        S.Vault = bEnabled ? FEE_VAULT : "";
        S.Every = I64(Every);
        S.PurchasesSinceLastSweep = I64(Count);
        S.Accrued = U64(Accrued / FEE_SCALE);
        S.Held = bHasPending ? Pending.Value : "0";
        S.Collected = U64(Collected);
        S.Lost = U64(Lost);
        return S;
    }
}
