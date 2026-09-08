// THE SIGNER.
//
// The only place a player's key is touched, and the only code here that has to be exactly
// right. It takes a challenge the server issued, produces one EIP-712 signature, and returns.
// No network, no state, no Unity types - so it can be tested outside the editor.
//
// The curve math is Bouncy Castle's, deliberately. Hand-rolling secp256k1 is the single
// highest-risk thing we could do in this package, and a wrong signature does not fail loudly:
// it verifies locally and the contract rejects it.
//
// EVERY VALUE THIS PRODUCES MUST MATCH unity/vectors/signer-vectors.json, which came from the
// TypeScript implementation that settles real money on Base. X402SignerTests checks that.

using System;
using System.Globalization;
using System.Numerics;
using System.Text;
using Org.BouncyCastle.Asn1.X9;
using Org.BouncyCastle.Crypto.Digests;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Org.BouncyCastle.Math;
using Org.BouncyCastle.Math.EC;

// Both libraries define BigInteger and they are NOT interchangeable: Bouncy Castle's is
// big-endian and carries the curve arithmetic, System's is little-endian. Aliasing both
// keeps every use site explicit about which one it means.
using BcBig = Org.BouncyCastle.Math.BigInteger;
using SysBig = System.Numerics.BigInteger;

namespace X402.Gaming
{
    /// <summary>What the server says must be signed. Mirrors the quote it returns.</summary>
    [Serializable]
    public class X402Quote
    {
        public string network;              // "eip155:8453"
        public string amount;               // atomic units, as a string
        public string payTo;                // 0x...
        public string asset;                // the USDC contract
        public int maxTimeoutSeconds = 600;
        public X402Domain extra;            // EIP-712 name and version
    }

    [Serializable]
    public class X402Domain
    {
        public string name;                 // "USD Coin"
        public string version;              // "2"
    }

    /// <summary>An EIP-3009 authorization. Field order here is the ABI encoding order.</summary>
    [Serializable]
    public class X402Authorization
    {
        public string from;
        public string to;
        public string value;
        public string validAfter;
        public string validBefore;
        public string nonce;                // 32 bytes, 0x-prefixed
    }

    [Serializable]
    public class X402SignedPurchase
    {
        public X402Authorization authorization;
        public string signature;            // 65 bytes, 0x-prefixed
        public string playerAddress;
    }

    public static class X402Signer
    {
        static readonly X9ECParameters Curve = Org.BouncyCastle.Asn1.Sec.SecNamedCurves.GetByName("secp256k1");
        static readonly ECDomainParameters Domain =
            new ECDomainParameters(Curve.Curve, Curve.G, Curve.N, Curve.H);

        // keccak256("TransferWithAuthorization(address from,address to,uint256 value,
        //            uint256 validAfter,uint256 validBefore,bytes32 nonce)")
        const string TransferTypeHash =
            "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267";
        const string Eip712DomainTypeHash =
            "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f";

        /// <summary>Keccak-256. NOT SHA3-256 - the padding differs and every hash would be wrong.</summary>
        public static byte[] Keccak256(params byte[][] parts)
        {
            var d = new KeccakDigest(256);
            foreach (var p in parts) d.BlockUpdate(p, 0, p.Length);
            var outBuf = new byte[32];
            d.DoFinal(outBuf, 0);
            return outBuf;
        }

        public static byte[] FromHex(string hex)
        {
            if (string.IsNullOrEmpty(hex)) return Array.Empty<byte>();
            if (hex.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) hex = hex.Substring(2);
            if (hex.Length % 2 != 0) hex = "0" + hex;
            var b = new byte[hex.Length / 2];
            for (int i = 0; i < b.Length; i++)
                b[i] = byte.Parse(hex.Substring(i * 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            return b;
        }

        public static string ToHex(byte[] b)
        {
            var sb = new StringBuilder("0x", 2 + b.Length * 2);
            foreach (var x in b) sb.Append(x.ToString("x2", CultureInfo.InvariantCulture));
            return sb.ToString();
        }

        /// <summary>Left-pad to 32 bytes. Every EIP-712 word is 32 bytes wide.</summary>
        static byte[] Word(byte[] v)
        {
            if (v.Length == 32) return v;
            var w = new byte[32];
            Array.Copy(v, 0, w, 32 - v.Length, v.Length);
            return w;
        }

        static byte[] Word(SysBig n)
        {
            // BigInteger is little-endian and may carry a sign byte; EIP-712 words are
            // big-endian and unsigned.
            var le = n.ToByteArray();
            int len = le.Length;
            while (len > 1 && le[len - 1] == 0) len--;     // drop the sign padding
            var w = new byte[32];
            for (int i = 0; i < len && i < 32; i++) w[31 - i] = le[i];
            return w;
        }

        static byte[] WordAddress(string addr)
        {
            var b = FromHex(addr);
            if (b.Length != 20) throw new ArgumentException("address must be 20 bytes: " + addr);
            return Word(b);
        }

        /// <summary>The address a key controls: last 20 bytes of keccak(uncompressed public key).</summary>
        public static string AddressOf(string privateKeyHex)
        {
            var d = new BcBig(1, FromHex(privateKeyHex));
            if (d.SignValue <= 0 || d.CompareTo(Domain.N) >= 0)
                throw new ArgumentException("invalid key material");
            ECPoint q = Domain.G.Multiply(d).Normalize();
            var x = q.AffineXCoord.GetEncoded();
            var y = q.AffineYCoord.GetEncoded();
            var pub = new byte[64];
            Array.Copy(x, 0, pub, 32 - x.Length, x.Length);
            Array.Copy(y, 0, pub, 64 - y.Length, y.Length);
            var h = Keccak256(pub);
            var addr = new byte[20];
            Array.Copy(h, 12, addr, 0, 20);
            return ToHex(addr);
        }

        /// <summary>EIP-712 domain separator for the asset contract.</summary>
        public static byte[] DomainSeparator(string name, string version, long chainId, string verifyingContract)
        {
            return Keccak256(
                FromHex(Eip712DomainTypeHash),
                Keccak256(Encoding.UTF8.GetBytes(name)),
                Keccak256(Encoding.UTF8.GetBytes(version)),
                Word(new SysBig(chainId)),
                WordAddress(verifyingContract));
        }

        /// <summary>The 32 bytes actually signed: 0x1901 || domainSeparator || structHash.</summary>
        public static byte[] Digest(byte[] domainSeparator, X402Authorization a)
        {
            var structHash = Keccak256(
                FromHex(TransferTypeHash),
                WordAddress(a.from),
                WordAddress(a.to),
                Word(SysBig.Parse(a.value, CultureInfo.InvariantCulture)),
                Word(SysBig.Parse(a.validAfter, CultureInfo.InvariantCulture)),
                Word(SysBig.Parse(a.validBefore, CultureInfo.InvariantCulture)),
                Word(FromHex(a.nonce)));
            return Keccak256(new byte[] { 0x19, 0x01 }, domainSeparator, structHash);
        }

        /// <summary>
        /// Sign a quote. Returns the authorization and its 65-byte signature.
        ///
        /// The authorization is bounded three ways - exact recipient, exact amount, and an
        /// expiry - and carries a random nonce the asset contract redeems once. So even a
        /// signature captured in flight can buy that one thing, once.
        /// </summary>
        public static X402SignedPurchase Sign(X402Quote quote, string privateKeyHex, long nowUnix = 0)
        {
            if (quote == null) throw new ArgumentNullException(nameof(quote));
            var d = new BcBig(1, FromHex(privateKeyHex));
            if (d.SignValue <= 0 || d.CompareTo(Domain.N) >= 0)
                throw new ArgumentException("invalid key material");

            long now = nowUnix > 0 ? nowUnix : DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var nonce = new byte[32];
            using (var rng = System.Security.Cryptography.RandomNumberGenerator.Create()) rng.GetBytes(nonce);

            var auth = new X402Authorization
            {
                from = AddressOf(privateKeyHex),
                to = quote.payTo,
                value = quote.amount,
                // Sixty seconds of slack: a player's clock is not the chain's, and a
                // validAfter in the future makes the transfer revert.
                validAfter = (now - 60).ToString(CultureInfo.InvariantCulture),
                validBefore = (now + (quote.maxTimeoutSeconds > 0 ? quote.maxTimeoutSeconds : 600))
                    .ToString(CultureInfo.InvariantCulture),
                nonce = ToHex(nonce),
            };

            long chainId = ChainIdFrom(quote.network);
            var dsep = DomainSeparator(
                quote.extra != null ? quote.extra.name : "USD Coin",
                quote.extra != null ? quote.extra.version : "2",
                chainId, quote.asset);

            return new X402SignedPurchase
            {
                authorization = auth,
                signature = SignDigest(Digest(dsep, auth), privateKeyHex),
                playerAddress = auth.from,
            };
        }

        /// <summary>Sign 32 bytes, returning r || s || v with v as 27/28.</summary>
        public static string SignDigest(byte[] digest32, string privateKeyHex)
        {
            var d = new BcBig(1, FromHex(privateKeyHex));
            // RFC 6979 deterministic k. A repeated or predictable k leaks the private key
            // outright, so this must never be a plain RNG.
            var signer = new ECDsaSigner(new HMacDsaKCalculator(new Sha256Digest()));
            signer.Init(true, new ECPrivateKeyParameters(d, Domain));
            var rs = signer.GenerateSignature(digest32);
            var r = rs[0];
            var s = rs[1];

            // Ethereum rejects the high-s form; both are valid ECDSA, so normalise.
            var halfN = Domain.N.ShiftRight(1);
            bool flipped = false;
            if (s.CompareTo(halfN) > 0) { s = Domain.N.Subtract(s); flipped = true; }

            int recId = -1;
            var expected = AddressOf(privateKeyHex);
            for (int i = 0; i < 4; i++)
            {
                var rec = Recover(digest32, r, s, i);
                if (rec != null && string.Equals(rec, expected, StringComparison.OrdinalIgnoreCase))
                { recId = i; break; }
            }
            if (recId < 0) throw new InvalidOperationException("could not derive a recovery id");
            _ = flipped;

            var sig = new byte[65];
            Array.Copy(Word(r.ToByteArrayUnsigned()), 0, sig, 0, 32);
            Array.Copy(Word(s.ToByteArrayUnsigned()), 0, sig, 32, 32);
            sig[64] = (byte)(27 + recId);
            return ToHex(sig);
        }

        /// <summary>Recover the signer's address, the way a facilitator verifies.</summary>
        public static string Recover(byte[] digest32, BcBig r, BcBig s, int recId)
        {
            try
            {
                var n = Domain.N;
                var i = BcBig.ValueOf((long)recId / 2);
                var x = r.Add(i.Multiply(n));
                // The field prime, via the curve's public surface - the concrete SecP256K1Curve
                // type is internal in Bouncy Castle 2.x.
                var prime = Curve.Curve.Field.Characteristic;
                if (x.CompareTo(prime) >= 0) return null;

                var R = DecompressKey(x, (recId & 1) == 1);
                if (!R.Multiply(n).IsInfinity) return null;

                var e = new BcBig(1, digest32);
                var eInv = BcBig.Zero.Subtract(e).Mod(n);
                var rInv = r.ModInverse(n);
                var srInv = rInv.Multiply(s).Mod(n);
                var eInvrInv = rInv.Multiply(eInv).Mod(n);
                var q = ECAlgorithms.SumOfTwoMultiplies(Domain.G, eInvrInv, R, srInv).Normalize();

                var qx = q.AffineXCoord.GetEncoded();
                var qy = q.AffineYCoord.GetEncoded();
                var pub = new byte[64];
                Array.Copy(qx, 0, pub, 32 - qx.Length, qx.Length);
                Array.Copy(qy, 0, pub, 64 - qy.Length, qy.Length);
                var h = Keccak256(pub);
                var addr = new byte[20];
                Array.Copy(h, 12, addr, 0, 20);
                return ToHex(addr);
            }
            catch { return null; }
        }

        static ECPoint DecompressKey(BcBig xBN, bool yBit)
        {
            var compEnc = new byte[33];
            var xb = xBN.ToByteArrayUnsigned();
            Array.Copy(xb, 0, compEnc, 33 - xb.Length, xb.Length);
            compEnc[0] = (byte)(yBit ? 0x03 : 0x02);
            return Curve.Curve.DecodePoint(compEnc);
        }

        /// <summary>"eip155:8453" or "base" -> 8453.</summary>
        public static long ChainIdFrom(string network)
        {
            if (string.IsNullOrEmpty(network)) return 8453;
            if (network.StartsWith("eip155:", StringComparison.OrdinalIgnoreCase))
                return long.Parse(network.Substring(7), CultureInfo.InvariantCulture);
            if (string.Equals(network, "base", StringComparison.OrdinalIgnoreCase)) return 8453;
            throw new ArgumentException("unknown network: " + network);
        }
    }
}
