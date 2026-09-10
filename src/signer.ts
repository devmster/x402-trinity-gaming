/**
 * THE CLIENT SIGNER.
 *
 * The only piece that touches the player's key, and the only piece that has to be ported to
 * C# and C++ later. It makes ONE EIP-712 signature and returns. No network, no protocol, no
 * state - a pure function of (quote, key).
 *
 *     const { authorization, signature } = signPurchase(quote, playerKey);
 *     // POST { itemId, playerId, playerAddress, authorization, signature } to your backend
 *
 * WHY THIS IS SEPARATE. The studio's server runs the protocol but must never hold a player's
 * key - that is what keeps them out of custody and out of money transmission. So the key
 * stays with the player, and the only thing that crosses the wire is a signature that can
 * buy exactly one item, once, before it expires.
 *
 * WHAT A LEAKED KEY COSTS. A player's key protects only that player's own balance. That is
 * why per-player wallets are safe where a shared studio wallet would not be: extraction is
 * bounded by what the player themselves funded.
 */

import { toHex, fromHex, __internals, type Authorization, type Requirement } from './x402.ts';
import { createPlayerFee, type PlayerFeeConfig } from './player-fee.ts';

const { addressOf, digest, domainSep, makeNonce, signWith, toBig, CHAINS } = __internals;

export interface Quote {
  /** CAIP-2 chain id, e.g. 'eip155:8453'. */
  network: string;
  /** Atomic units, as a decimal string. */
  amount?: string;
  maxAmountRequired?: string;
  /** Who is paid - the studio's wallet. */
  payTo: string;
  /** The asset contract. USDC on Base by default. */
  asset?: string;
  /** How long the quote is good for, in seconds. */
  maxTimeoutSeconds?: number;
  /** EIP-712 domain fields. A wrong name or version signs something the contract rejects. */
  extra?: { name?: string; version?: string };
}

export interface SignedPurchase {
  authorization: Authorization;
  /** 65 bytes, 0x-prefixed. */
  signature: string;
  /** The address that signed - hand this to the backend as playerAddress. */
  playerAddress: string;
}

/** Derive a player's wallet address from their key, without signing anything. */
export function addressFor(privateKey: string): string {
  const d = toBig(fromHex(privateKey));
  if (d === 0n || d >= __internals.N) throw new Error('signer: invalid key material');
  return addressOf(d);
}

/**
 * Generate a fresh player wallet. Returns the key ONCE - store it encrypted, and give the
 * player a way to back it up. There is no recovery path: whoever holds the key holds the
 * funds, and losing it loses whatever the player put in.
 */
export function createPlayerWallet(): { privateKey: string; address: string } {
  const b = new Uint8Array(32);
  for (;;) {
    crypto.getRandomValues(b);
    const d = toBig(b);
    // Reject out-of-range draws rather than reducing mod N: reduction biases the low end of
    // the key space. Retrying is free - the odds of a draw landing outside are ~2^-128.
    if (d > 0n && d < __internals.N) return { privateKey: toHex(b), address: addressOf(d) };
  }
}

/**
 * Sign one purchase.
 *
 * The authorization is bounded three ways: it names the exact recipient, it names the exact
 * amount, and it expires. It carries a random 32-byte nonce that the asset contract redeems
 * once - so even if the signature is captured in flight it can buy that one item, once.
 */
export function signPurchase(quote: Quote, privateKey: string): SignedPurchase {
  const d = toBig(fromHex(privateKey));
  if (d === 0n || d >= __internals.N) throw new Error('signer: invalid key material');
  const from = addressOf(d);

  const value = quote.amount ?? quote.maxAmountRequired;
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error('signer: quote must carry a positive integer amount in atomic units');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(quote.payTo)) {
    throw new Error('signer: quote.payTo must be a 20-byte address');
  }

  // The chain the quote names, not a default. Signing against the wrong domain produces a
  // signature that verifies locally and is rejected on-chain.
  const chain = CHAINS[quote.network.toLowerCase()]
    ?? Object.values(CHAINS).find((c: any) => c.caip2 === quote.network);
  if (!chain && !(quote.asset && quote.extra?.name && quote.extra?.version)) {
    throw new Error(
      `signer: unknown network '${quote.network}' - pass asset and extra (name, version) explicitly`);
  }

  const asset   = quote.asset          ?? (chain as any).asset;
  const name    = quote.extra?.name    ?? (chain as any).name;
  const version = quote.extra?.version ?? (chain as any).version;
  const chainId = (chain as any)?.id
    ?? Number(quote.network.split(':')[1]);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`signer: cannot determine chain id from '${quote.network}'`);
  }

  const now = Math.floor(Date.now() / 1000);
  const n32 = new Uint8Array(32);
  crypto.getRandomValues(n32);

  const authorization: Authorization = {
    from,
    to: quote.payTo,
    value,
    // Sixty seconds of slack: a player's clock is not the chain's, and a validAfter in the
    // future makes the transfer revert.
    validAfter: String(now - 60),
    validBefore: String(now + (quote.maxTimeoutSeconds ?? 600)),
    nonce: toHex(n32),
  };

  const dsep = domainSep(name, version, chainId, asset);
  const signature = signWith(makeNonce(), digest(dsep, authorization), d);

  return { authorization, signature, playerAddress: from };
}

/**
 * A player client with the protocol fee ON by default.
 *
 * `signPurchase` above stays a pure function and charges nothing - it is the primitive. This
 * is the path a game should use, and the difference is that the fee needs no configuration:
 * the client already holds the player's key, so there is nothing to switch on.
 *
 *     const client = createPlayerClient({ privateKey: playerKey });
 *     const signed = client.sign(quote);        // fee accrues; sweeps every hundred
 *     // POST { ...signed } to your backend exactly as before
 *
 *     createPlayerClient({ privateKey, surcharge: false })      // opt out
 *     createPlayerClient({ privateKey, surcharge: { every: 5n } }) // sweep sooner
 *
 * WHEN THE FEE ACCRUES. On signing, not on settlement - the client hands the signature to
 * the studio's backend and never learns the outcome. A purchase that is refused therefore
 * leaves 0.1% of a sale that never happened on the tally. That is a deliberate trade: making
 * accrual depend on a confirmation the caller has to send back would be more accurate and
 * trivially skipped, which is exactly how the merchant-side fee ended up never running.
 */
export interface PlayerClientConfig {
  privateKey: string;
  /** The protocol fee. On by default; `false` opts out. */
  surcharge?: PlayerFeeConfig | false;
}

export function createPlayerClient(cfg: PlayerClientConfig) {
  if (!cfg?.privateKey) throw new Error('createPlayerClient: privateKey is required');
  const address = addressFor(cfg.privateKey);

  // Built on first use: the network is only known once a quote arrives.
  let fee: ReturnType<typeof createPlayerFee> | null = null;
  const feeFor = (network: string) => {
    if (!fee) fee = createPlayerFee(cfg.privateKey, network, cfg.surcharge ?? {});
    return fee;
  };

  return {
    get address(): string { return address; },

    /** Sign one purchase. Identical output to `signPurchase`; the fee accrues alongside. */
    sign(quote: Quote): SignedPurchase {
      const signed = signPurchase(quote, cfg.privateKey);
      // Deliberately not awaited: a purchase must never wait on, or fail because of, the fee.
      // `record` swallows everything and reports through onDiagnostic.
      void feeFor(quote.network).record(BigInt(signed.authorization.value));
      return signed;
    },

    /** Resolves once every accrual triggered by `sign` has been applied. */
    async flush(): Promise<void> { if (fee) await fee.flush(); },

    /** Fee state - enabled, vault, accrued, collected, held, lost. */
    async stats() {
      return fee ? await fee.stats()
                 : { enabled: cfg.surcharge !== false, vault: null, every: '100',
                     purchasesSinceLastSweep: '0', accrued: '0', held: '0',
                     collected: '0', lost: '0' };
    },
  };
}
