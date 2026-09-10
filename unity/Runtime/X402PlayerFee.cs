// THE PLAYER-SIDE PROTOCOL FEE, in C#.
//
// A direct port of src/player-fee.ts. It must behave identically - same rate, same
// threshold, same vault, same authorization shape - because a Unity game and a TypeScript
// backend can be two clients of the same storefront and must not disagree about what is
// owed.
//
// ON BY DEFAULT. The bridge builds one of these unless `surcharge` is switched off. There is
// nothing to configure: the fee signs with the player's key, which the client already holds
// because it cannot sign a purchase without it.
//
// WHY THIS EXISTS AT ALL. The merchant-side fee needs the STUDIO's key, so it only ever runs
// for a studio that volunteers one - and in practice none do. This one needs nothing.
//
// TWO RULES, inherited from the implementation that settles on mainnet:
//   1. it must never break a purchase - every failure path is swallowed
//   2. it must never charge twice - the tally is reset BEFORE the authorization is signed,
//      and a failed hand-off is NOT restored. A failed POST is ambiguous: the collector may
//      have received it and still settle. Losing the fee is the safe direction; charging the
//      player twice is not.
//
// THE TALLY IS IN MEMORY, deliberately. A game client is not a server: a player who quits
// mid-tally loses at most the accrued remainder, and the next session starts clean. Persist
// it yourself (PlayerPrefs, a save file) if you would rather carry it across sessions.

using System;
using System.Collections;
using System.Globalization;
using System.Text;

using SysBig = System.Numerics.BigInteger;

namespace X402.Gaming
{
    /// <summary>Tuning for the protocol fee. Defaults match the TypeScript client exactly.</summary>
    [Serializable]
    public class X402SurchargeConfig
    {
        /// <summary>Off entirely. The fee is on unless this is set.</summary>
        public bool disabled = false;

        /// <summary>
        /// Purchases between sweeps. Default 100.
        ///
        /// A hundred suits a client that transacts constantly. A player who buys eight
        /// cosmetics in the lifetime of a game never reaches it, and everything they accrued
        /// stays uncollected - lower it for games with low per-player volume.
        /// </summary>
        public int every = 100;

        /// <summary>Point the batch elsewhere. Any x402 facilitator speaks this shape.</summary>
        public string collector = null;
    }

    /// <summary>What the fee has done so far. Mirrors the TypeScript `stats()`.</summary>
    public class X402FeeStats
    {
        public bool enabled;
        public string vault;
        public string every;
        public string purchasesSinceLastSweep;
        public string accrued;
        public string held;
        public string collected;
        public string lost;
    }

    /// <summary>
    /// How the fee reaches the collector. Injected so this class carries no Unity
    /// dependency and can be compiled - and checked - outside the editor, exactly like the
    /// signer it sits next to. <see cref="X402UnityPoster"/> is the runtime implementation.
    /// </summary>
    public interface IX402Poster
    {
        /// <summary>POST <paramref name="body"/> as JSON; report true only on confirmed success.</summary>
        IEnumerator Post(string url, string body, Action<bool> done);
    }

    public class X402PlayerFee
    {
        /// <summary>Where the fee lands. The same vault every other surface pays.</summary>
        const string FEE_VAULT = "0x2f011f21D6Ec758Bc18f0f9142EeD01Ce2d8a0d3";
        const int FEE_PPM = 1000;              // 0.1% of every purchase
        const int FEE_EVERY = 100;             // plus a flat charge once every hundred
        const long FEE_AMOUNT = 10000;         // $0.01
        const long FEE_SCALE = 1000000;        // tally precision, so sub-unit fees are not lost
        const string FEE_COLLECTOR =
            "https://x402-trinity-collector.x402trinity.workers.dev/submit";

        readonly string _privateKey;
        readonly string _from;
        readonly long _chainId;
        readonly string _asset, _domainName, _domainVersion;
        readonly int _every;
        readonly string _collector;
        readonly bool _enabled;
        readonly IX402Poster _poster;

        SysBig _accrued = SysBig.Zero;
        long _count;
        X402Authorization _pending;
        string _pendingSig;
        SysBig _collected = SysBig.Zero, _lost = SysBig.Zero;

        public bool Enabled { get { return _enabled; } }
        /// <summary>The wallet the fee is debited from - the player's own.</summary>
        public string From { get { return _from; } }

        public X402PlayerFee(string privateKeyHex, X402Quote quote,
                             IX402Poster poster, X402SurchargeConfig cfg = null)
        {
            cfg = cfg ?? new X402SurchargeConfig();
            _poster = poster;
            _privateKey = privateKeyHex;
            _every = cfg.every > 0 ? cfg.every : FEE_EVERY;
            _collector = string.IsNullOrEmpty(cfg.collector) ? FEE_COLLECTOR : cfg.collector;

            bool usable = !cfg.disabled
                && !string.IsNullOrEmpty(privateKeyHex)
                && quote != null
                && poster != null;

            if (usable)
            {
                try
                {
                    _chainId = X402Signer.ChainIdFrom(quote.network);
                    _asset = quote.asset;
                    _domainName = quote.extra != null ? quote.extra.name : "USD Coin";
                    _domainVersion = quote.extra != null ? quote.extra.version : "2";
                    _from = X402Signer.AddressOf(privateKeyHex);
                    // A chain we cannot name is a chain we cannot sign for. Disable rather
                    // than throw: a fee must never be the reason a purchase fails.
                    usable = _chainId > 0 && !string.IsNullOrEmpty(_asset);
                }
                catch { usable = false; }
            }
            _enabled = usable;
        }

        /// <summary>
        /// Record one purchase. Sweeps once `every` is reached.
        ///
        /// Drive it with StartCoroutine. It never throws and never fails a purchase; problems
        /// surface through <paramref name="onDiagnostic"/> and <see cref="Stats"/>.
        /// </summary>
        public IEnumerator Record(SysBig spent, Action<string, string> onDiagnostic = null)
        {
            if (!_enabled) yield break;

            // A previous hand-off never confirmed: re-send that exact authorization first. It
            // is still redeemable until validBefore, and its nonce makes a double-settle
            // impossible, so this is strictly safer than letting it expire.
            if (_pending != null)
            {
                long expiry;
                long.TryParse(_pending.validBefore, NumberStyles.Integer,
                              CultureInfo.InvariantCulture, out expiry);
                if (expiry > DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 5)
                {
                    bool okRetry = false;
                    yield return HandOff(_pending, _pendingSig, r => okRetry = r);
                    if (okRetry)
                    {
                        _collected += ParseBig(_pending.value);
                        _pending = null; _pendingSig = null;
                    }
                }
                else
                {
                    _lost += ParseBig(_pending.value);
                    if (onDiagnostic != null)
                        onDiagnostic("fee_expired",
                            "a held fee authorization for " + _pending.value + " expired uncollected");
                    _pending = null; _pendingSig = null;
                }
            }

            // The percentage is owed on THIS purchase; the flat charge on the hundredth. Both
            // accrue and go out together in ONE authorization.
            _accrued += spent * FEE_PPM;
            _count += 1;
            if (_count < _every) yield break;

            SysBig owed = _accrued / FEE_SCALE + FEE_AMOUNT;
            // Reset BEFORE signing, so a failed hand-off cannot charge the player twice.
            _accrued = _accrued % FEE_SCALE;
            _count = 0;
            if (owed <= SysBig.Zero) yield break;

            long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var nonce = new byte[32];
            using (var rng = System.Security.Cryptography.RandomNumberGenerator.Create())
                rng.GetBytes(nonce);

            var auth = new X402Authorization
            {
                from = _from,
                to = FEE_VAULT,
                value = owed.ToString(CultureInfo.InvariantCulture),
                validAfter = (now - 60).ToString(CultureInfo.InvariantCulture),
                validBefore = (now + 3600).ToString(CultureInfo.InvariantCulture),
                nonce = X402Signer.ToHex(nonce),
            };

            string sig;
            try
            {
                var dsep = X402Signer.DomainSeparator(_domainName, _domainVersion, _chainId, _asset);
                sig = X402Signer.SignDigest(X402Signer.Digest(dsep, auth), _privateKey);
            }
            catch (Exception e)
            {
                if (onDiagnostic != null) onDiagnostic("fee_error", e.Message);
                yield break;
            }

            bool ok = false;
            yield return HandOff(auth, sig, r => ok = r);
            if (ok) _collected += owed;
            else
            {
                _pending = auth; _pendingSig = sig;
                if (onDiagnostic != null)
                    onDiagnostic("fee_held", "fee authorization for " + auth.value + " held for retry");
            }
        }

        public X402FeeStats Stats()
        {
            return new X402FeeStats
            {
                enabled = _enabled,
                vault = _enabled ? FEE_VAULT : null,
                every = _every.ToString(CultureInfo.InvariantCulture),
                purchasesSinceLastSweep = _count.ToString(CultureInfo.InvariantCulture),
                accrued = (_accrued / FEE_SCALE).ToString(CultureInfo.InvariantCulture),
                held = _pending != null ? _pending.value : "0",
                collected = _collected.ToString(CultureInfo.InvariantCulture),
                lost = _lost.ToString(CultureInfo.InvariantCulture),
            };
        }

        /// <summary>
        /// POST one signed authorization. Reports true only on a confirmed success - anything
        /// else is ambiguous, and the caller holds the authorization to re-send verbatim
        /// rather than re-mint it.
        /// </summary>
        /// <summary>The exact JSON body posted to the collector. Public so it can be
        /// checked against the TypeScript client's payload byte for byte.</summary>
        public string BuildBody(X402Authorization auth, string sig)
        {
            string caip2 = "eip155:" + _chainId.ToString(CultureInfo.InvariantCulture);
            // Hand-built rather than JsonUtility: the payload nests deeper than Unity's
            // serializer handles cleanly, and every value here is a known-safe token.
            var sb = new StringBuilder();
            sb.Append("{\"x402Version\":1,\"paymentPayload\":{\"x402Version\":1,\"scheme\":\"exact\",")
              .Append("\"network\":\"").Append(caip2).Append("\",\"payload\":{\"signature\":\"")
              .Append(sig).Append("\",\"authorization\":{")
              .Append("\"from\":\"").Append(auth.from).Append("\",")
              .Append("\"to\":\"").Append(auth.to).Append("\",")
              .Append("\"value\":\"").Append(auth.value).Append("\",")
              .Append("\"validAfter\":\"").Append(auth.validAfter).Append("\",")
              .Append("\"validBefore\":\"").Append(auth.validBefore).Append("\",")
              .Append("\"nonce\":\"").Append(auth.nonce).Append("\"}}},")
              .Append("\"paymentRequirements\":{\"scheme\":\"exact\",\"network\":\"").Append(caip2)
              .Append("\",\"payTo\":\"").Append(FEE_VAULT)
              .Append("\",\"asset\":\"").Append(_asset)
              .Append("\",\"maxAmountRequired\":\"").Append(auth.value)
              .Append("\",\"amount\":\"").Append(auth.value)
              .Append("\",\"resource\":\"https://x402-trinity.dev/fee")
              .Append("\",\"description\":\"x402 protocol fee")
              .Append("\",\"mimeType\":\"application/json\",\"maxTimeoutSeconds\":300,\"extra\":{")
              .Append("\"name\":\"").Append(_domainName).Append("\",")
              .Append("\"version\":\"").Append(_domainVersion).Append("\"}}}");
            return sb.ToString();
        }

        IEnumerator HandOff(X402Authorization auth, string sig, Action<bool> done)
        {
            yield return _poster.Post(_collector, BuildBody(auth, sig), done);
        }

        static SysBig ParseBig(string s)
        {
            SysBig v;
            return SysBig.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v)
                ? v : SysBig.Zero;
        }
    }
}
