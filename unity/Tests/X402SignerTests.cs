// THE CROSS-CHECK.
//
// The C# signer is a port of code that settles real money. A port that is subtly wrong does
// not crash - it produces a signature that verifies locally and the contract rejects, which
// you find out in production.
//
// So every intermediate value is checked against unity/vectors/signer-vectors.json, generated
// by the TypeScript implementation. Not just the final signature: the empty-string keccak, the
// type hash, the domain separator and the EIP-712 digest, because a mismatch in any of them
// tells you exactly which step drifted.
//
// Run:  dotnet test unity/Tests

using System;
using System.IO;
using System.Text;
using System.Text.Json;
using NUnit.Framework;
using X402.Gaming;

namespace X402.Gaming.Tests
{
    public class X402SignerTests
    {
        static JsonDocument _v;

        static JsonDocument Vectors
        {
            get
            {
                if (_v != null) return _v;
                var dir = AppContext.BaseDirectory;
                for (int i = 0; i < 8 && dir != null; i++)
                {
                    var p = Path.Combine(dir, "unity", "vectors", "signer-vectors.json");
                    if (File.Exists(p)) { _v = JsonDocument.Parse(File.ReadAllText(p)); return _v; }
                    dir = Directory.GetParent(dir)?.FullName;
                }
                throw new FileNotFoundException("signer-vectors.json not found - regenerate it from the TypeScript signer");
            }
        }

        static string S(params string[] path)
        {
            var el = Vectors.RootElement;
            foreach (var k in path) el = el.GetProperty(k);
            return el.GetString();
        }

        [Test]
        public void Keccak256_MatchesTheReferenceImplementation()
        {
            // If this is wrong, everything downstream is wrong. The usual cause is reaching
            // for SHA3-256, which differs from Keccak-256 only in its padding byte.
            var got = X402Signer.ToHex(X402Signer.Keccak256(Encoding.UTF8.GetBytes("")));
            Assert.AreEqual(S("keccakEmpty"), got, "keccak256(\"\") differs - this is Keccak, not SHA3");
        }

        [Test]
        public void AddressDerivation_MatchesTheReferenceImplementation()
        {
            var got = X402Signer.AddressOf(S("privateKey"));
            Assert.AreEqual(S("expectedAddress"), got, "the address derived from the key differs");
        }

        [Test]
        public void DomainSeparator_MatchesBaseMainnet()
        {
            var chain = Vectors.RootElement.GetProperty("chain");
            var got = X402Signer.ToHex(X402Signer.DomainSeparator(
                chain.GetProperty("name").GetString(),
                chain.GetProperty("version").GetString(),
                chain.GetProperty("chainId").GetInt64(),
                chain.GetProperty("verifyingContract").GetString()));
            Assert.AreEqual(S("domainSeparator"), got,
                "domain separator differs - a wrong name or version signs something the contract rejects");
        }

        [Test]
        public void TypeHash_MatchesTheReferenceImplementation()
        {
            var got = X402Signer.ToHex(X402Signer.Keccak256(Encoding.UTF8.GetBytes(
                "TransferWithAuthorization(address from,address to,uint256 value," +
                "uint256 validAfter,uint256 validBefore,bytes32 nonce)")));
            Assert.AreEqual(S("transferWithAuthorizationTypeHash"), got, "the struct type hash differs");
        }

        [Test]
        public void Eip712Digest_MatchesTheReferenceImplementation()
        {
            // The decisive one: the exact 32 bytes signed, for a fully pinned authorization.
            var a = Vectors.RootElement.GetProperty("authorization");
            var auth = new X402Authorization
            {
                from = a.GetProperty("from").GetString(),
                to = a.GetProperty("to").GetString(),
                value = a.GetProperty("value").GetString(),
                validAfter = a.GetProperty("validAfter").GetString(),
                validBefore = a.GetProperty("validBefore").GetString(),
                nonce = a.GetProperty("nonce").GetString(),
            };
            var dsep = X402Signer.FromHex(S("domainSeparator"));
            var got = X402Signer.ToHex(X402Signer.Digest(dsep, auth));
            Assert.AreEqual(S("eip712Digest"), got, "the signed digest differs from the reference");
        }

        [Test]
        public void Signature_RecoversToTheSigner()
        {
            // ECDSA over a deterministic k still cannot be compared byte-for-byte against a
            // vector produced with a random k, so assert what the facilitator actually checks:
            // that the signature recovers to the address that made it.
            var key = S("privateKey");
            var digest = X402Signer.FromHex(S("eip712Digest"));
            var sig = X402Signer.SignDigest(digest, key);

            Assert.AreEqual(132, sig.Length, "a signature is 65 bytes: 0x + 130 hex chars");

            var r = new Org.BouncyCastle.Math.BigInteger(1, X402Signer.FromHex(sig.Substring(2, 64)));
            var s = new Org.BouncyCastle.Math.BigInteger(1, X402Signer.FromHex(sig.Substring(66, 64)));
            int v = Convert.ToInt32(sig.Substring(130, 2), 16);
            Assert.That(v, Is.InRange(27, 28), "v must be 27 or 28");

            var recovered = X402Signer.Recover(digest, r, s, v - 27);
            Assert.AreEqual(S("expectedAddress").ToLowerInvariant(), recovered?.ToLowerInvariant(),
                "the signature does not recover to the signer");
        }

        [Test]
        public void Signature_IsLowS()
        {
            // Both s and N-s are valid ECDSA, but Ethereum rejects the high form.
            var sig = X402Signer.SignDigest(X402Signer.FromHex(S("eip712Digest")), S("privateKey"));
            var s = new Org.BouncyCastle.Math.BigInteger(1, X402Signer.FromHex(sig.Substring(66, 64)));
            var halfN = new Org.BouncyCastle.Math.BigInteger(
                "7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0", 16);
            Assert.That(s.CompareTo(halfN) <= 0, "signature is high-s; Ethereum will reject it");
        }

        [Test]
        public void Sign_ProducesABoundedAuthorization()
        {
            var quote = new X402Quote
            {
                network = "eip155:8453",
                amount = "1500000",
                payTo = "0x9f2c4a1b3d5e6f708192a3b4c5d6e7f809a1b2c3",
                asset = Vectors.RootElement.GetProperty("chain").GetProperty("verifyingContract").GetString(),
                maxTimeoutSeconds = 600,
                extra = new X402Domain { name = "USD Coin", version = "2" },
            };
            var signed = X402Signer.Sign(quote, S("privateKey"));

            Assert.AreEqual(quote.payTo, signed.authorization.to, "must pay the named recipient");
            Assert.AreEqual(quote.amount, signed.authorization.value, "must be for the exact amount");
            Assert.AreEqual(S("expectedAddress"), signed.authorization.from, "must come from the signer");
            Assert.Greater(long.Parse(signed.authorization.validBefore),
                           DateTimeOffset.UtcNow.ToUnixTimeSeconds(), "must not be already expired");

            var again = X402Signer.Sign(quote, S("privateKey"));
            Assert.AreNotEqual(signed.authorization.nonce, again.authorization.nonce,
                "every purchase must carry a fresh nonce, or the second one is unredeemable");
        }
    }
}
