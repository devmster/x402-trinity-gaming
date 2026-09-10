// THE PLAYER-SIDE PROTOCOL FEE, in C++.
//
// A direct port of src/player-fee.ts and unity/Runtime/X402PlayerFee.cs. All three must agree
// on what is owed - an Unreal game, a Unity game and a TypeScript backend can be clients of
// the same storefront, and a divergence would show up as a shortfall in the vault rather than
// as an error anywhere.
//
// ON BY DEFAULT. It signs with the PLAYER's key, which the client already holds because it
// cannot sign a purchase without it. Nothing to configure, nothing to switch on. The
// merchant-side fee needs the STUDIO's key and so only ever runs for a studio that volunteers
// one, which in practice none do.
//
// Plain C++ on purpose - no UObject, no FString, no Unreal headers - so it compiles outside
// the editor and can be checked against the same golden figures the other two implementations
// pass. HTTP is injected; X402StorefrontBridge supplies the Unreal implementation.

#pragma once

#include <cstdint>
#include <functional>
#include <string>

#include "X402Signer.h"

namespace X402
{
    /// Tuning for the protocol fee. Defaults match the TypeScript client exactly.
    struct FSurchargeConfig
    {
        /// Off entirely. The fee is on unless this is set.
        bool bDisabled = false;

        /// Purchases between sweeps. Default 100.
        ///
        /// A hundred suits a client that transacts constantly. A player who buys eight
        /// cosmetics in the lifetime of a game never reaches it, and everything they accrued
        /// stays uncollected - lower it for games with low per-player volume.
        int32_t Every = 100;

        /// Point the batch elsewhere. Any x402 facilitator speaks this shape.
        std::string Collector;
    };

    /// What the fee has done so far. Mirrors the TypeScript `stats()`.
    struct FFeeStats
    {
        bool        bEnabled = false;
        std::string Vault;
        std::string Every;
        std::string PurchasesSinceLastSweep;
        std::string Accrued;
        std::string Held;
        std::string Collected;
        std::string Lost;
    };

    /// Reports true only on a confirmed success - anything else is ambiguous, and the caller
    /// holds the authorization to re-send verbatim rather than re-mint it.
    using FPostDone = std::function<void(bool)>;
    /// How the batch reaches the collector. Injected so this header stays Unreal-free.
    using FPoster = std::function<void(const std::string& Url, const std::string& Body, FPostDone Done)>;

    class FPlayerFee
    {
    public:
        FPlayerFee(const std::string& PrivateKeyHex,
                   const FQuote& Quote,
                   FPoster Poster,
                   const FSurchargeConfig& Config = FSurchargeConfig());

        /// False when opted out, or when the chain has no domain we can sign for.
        bool IsEnabled() const { return bEnabled; }
        /// The wallet the fee is debited from - the player's own.
        const std::string& From() const { return FromAddress; }

        /// Record one purchase. Sweeps once `Every` is reached.
        ///
        /// Never throws: a fee problem must not break a purchase the player has already made.
        /// `Spent` is atomic units as a decimal string, matching the authorization's `value`.
        void Record(const std::string& Spent,
                    const std::function<void(const std::string& Code, const std::string& Message)>& OnDiagnostic = nullptr);

        FFeeStats Stats() const;

        /// The exact JSON body posted to the collector. Public so it can be checked against
        /// the other implementations' payloads.
        std::string BuildBody(const FAuthorization& Auth, const std::string& Signature) const;

    private:
        void Sweep(uint64_t Owed,
                   const std::function<void(const std::string&, const std::string&)>& OnDiagnostic);

        std::string PrivateKey;
        std::string FromAddress;
        int64_t     ChainId = 0;
        std::string Asset, DomainName, DomainVersion, Caip2;
        int32_t     Every = 100;
        std::string Collector;
        FPoster     Poster;
        bool        bEnabled = false;

        // The tally. `Accrued` is scaled by 1e6 so sub-unit fees are not lost to rounding.
        //
        // 64 bits is ample: a hundred purchases of $10 accrue 1e12, and the type holds ~1.8e19
        // - roughly eighteen trillion dollars of volume between sweeps. Nothing a storefront
        // does approaches it, and using a bignum here would buy nothing.
        uint64_t Accrued = 0;
        int64_t  Count = 0;
        uint64_t Collected = 0, Lost = 0;

        bool           bHasPending = false;
        FAuthorization Pending;
        std::string    PendingSig;
    };
}
