/**
 * THE MERCHANT-SIDE FEE.
 *
 * The player is debited exactly the sticker price - nothing is added on top of what the
 * store shows. The fee comes out of the studio's proceeds instead, the way a card processor
 * or a platform cut works, and settles in a batch rather than on every sale.
 *
 * Two things are owed: 0.1% of each sale, and a flat charge once every hundred. Both accrue
 * and go out TOGETHER in one authorization when the hundredth sale lands - one settlement
 * per hundred rather than a hundred dust transfers that would cost more in gas than they
 * collect.
 *
 * WHY THE STUDIO MUST SUPPLY A KEY. Moving USDC out of the studio's wallet requires the
 * studio to authorize it. There is no way around that and no way for us to do it for them.
 * The key signs one thing only - a transfer of the accrued fee to the vault - and it is the
 * studio's own treasury wallet on the studio's own server. If no key is supplied, no fee is
 * charged and `enabled` reads false; nothing silently half-works.
 *
 * The accrual below mirrors the buyer-side implementation that has been settling on mainnet:
 * read-modify-write inside the lock, tally reset BEFORE the authorization is signed, and a
 * failed hand-off held and re-sent with the SAME nonce rather than re-minted.
 */

import { toHex, fromHex, __internals, type Authorization } from './x402.ts';

const { addressOf, digest, domainSep, makeNonce, signWith, toBig, CHAINS, N } = __internals;

/** Where the fee lands. The same vault the buyer-side package pays. */
const FEE_VAULT = '0x2f011f21D6Ec758Bc18f0f9142EeD01Ce2d8a0d3';
const FEE_PPM = 1000n;            // 0.1% of every sale
const FEE_EVERY = 100n;           // plus a flat charge once every hundred
const FEE_AMOUNT = 10_000n;       // $0.01
const FEE_SCALE = 1_000_000n;
/** The same collector, gas wallet and sweep pipeline as the buyer-side package. */
const FEE_COLLECTOR = 'https://x402-trinity-collector.x402trinity.workers.dev/submit';

export const NOTICE =
  'Merchant proceeds are settled net of a 0.1% network fee, plus a flat charge once every ' +
  'hundred sales. Players are debited exactly the price shown.';

export interface FeeStore {
  get: () => Promise<{ accrued: bigint; count: bigint }>;
  set: (v: { accrued: bigint; count: bigint }) => Promise<void>;
  /**
   * Read, modify and write while holding a lock. Without it two backend instances sharing a
   * tally both read the same count and both write count+1, and sales stop counting.
   */
  update?: (fn: (c: { accrued: bigint; count: bigint }) => { accrued: bigint; count: bigint })
    => Promise<{ accrued: bigint; count: bigint }>;
}

export interface ProceedsFeeConfig {
  /**
   * Key for the wallet named in the storefront's `payTo`. Signs ONLY fee authorizations to
   * the vault. Omit it and no fee is charged.
   */
  proceedsKey?: string;
  /** Durable tally. In memory the count resets on restart and the hundredth never lands. */
  store?: FeeStore;
  network?: string;
  /** Point the batch somewhere else - a studio may prefer their own facilitator. */
  collector?: string;
  onNotice?: (msg: string) => void;
  onDiagnostic?: (d: { code: string; message: string }) => void;
}

export function createProceedsFee(cfg: ProceedsFeeConfig) {
  const enabled = typeof cfg.proceedsKey === 'string' && cfg.proceedsKey.length > 0;
  const chainKey = (cfg.network ?? 'base').toLowerCase();
  const chain = (CHAINS as any)[chainKey]
    ?? Object.values(CHAINS).find((c: any) => c.caip2 === chainKey);

  let d = 0n, from = '';
  if (enabled) {
    d = toBig(fromHex(cfg.proceedsKey!));
    if (d === 0n || d >= N) throw new Error('proceeds fee: invalid key material');
    from = addressOf(d);
    cfg.onNotice?.(NOTICE);
  }

  const collector = cfg.collector ?? FEE_COLLECTOR;
  let mem = { accrued: 0n, count: 0n };
  let pending: { auth: Authorization; sig: string } | null = null;
  let collected = 0n, lost = 0n;

  const handOff = async (auth: Authorization, sig: string): Promise<boolean> => {
    try {
      const r = await fetch(collector, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          x402Version: 1,
          paymentPayload: {
            x402Version: 1, scheme: 'exact', network: (chain as any).caip2,
            payload: { signature: sig, authorization: auth },
          },
          paymentRequirements: {
            scheme: 'exact', network: (chain as any).caip2, payTo: FEE_VAULT,
            asset: (chain as any).asset,
            maxAmountRequired: auth.value, amount: auth.value,
            resource: 'https://x402-trinity.dev/fee',
            description: 'network fee',
            mimeType: 'application/json', maxTimeoutSeconds: 300,
            extra: { name: (chain as any).name, version: (chain as any).version },
          },
        }),
      });
      if (!r.ok) return false;
      try { return JSON.parse(await r.text())?.success === true; } catch { return false; }
    } catch { return false; }
  };

  return {
    /** False when no key was supplied - nothing is being charged. */
    get enabled(): boolean { return enabled; },
    /** The wallet the fee is debited from. Empty when disabled. */
    get from(): string { return from; },

    /**
     * Record one settled sale. Sweeps on the hundredth.
     *
     * Never throws and never rejects: a fee problem must not undo a sale that has already
     * settled on-chain. Failures surface through `onDiagnostic` and `stats()`.
     */
    async record(saleValue: bigint): Promise<void> {
      if (!enabled) return;
      try {
        // A previous hand-off never confirmed: re-send that exact authorization first. It is
        // still redeemable until validBefore, and its nonce makes a double-settle impossible,
        // so this is strictly safer than letting it expire.
        if (pending) {
          const stuck = pending;
          if (Number(stuck.auth.validBefore) > Math.floor(Date.now() / 1000) + 5) {
            if (await handOff(stuck.auth, stuck.sig)) {
              collected += BigInt(stuck.auth.value);
              pending = null;
            }
          } else {
            lost += BigInt(stuck.auth.value);
            pending = null;
            cfg.onDiagnostic?.({ code: 'fee_expired',
              message: `a held fee authorization for ${stuck.auth.value} expired uncollected` });
          }
        }

        // The percentage is owed on THIS sale; the flat charge on the hundredth. Both accrue
        // and go out together. Read-modify-write happens inside the lock so two instances
        // cannot both see the same hundredth sale and sweep it twice.
        let owed = 0n, crossed = false;
        const step = (cur: { accrued: bigint; count: bigint }) => {
          const a = cur.accrued + saleValue * FEE_PPM;      // implicitly x FEE_SCALE / 1e6
          const c = cur.count + 1n;
          crossed = c >= FEE_EVERY;
          if (!crossed) return { accrued: a, count: c };
          owed = a / FEE_SCALE + FEE_AMOUNT;
          return { accrued: a % FEE_SCALE, count: 0n };     // remainder carries forward
        };
        if (cfg.store?.update) await cfg.store.update(step);
        else if (cfg.store) { const next = step(await cfg.store.get()); await cfg.store.set(next); }
        else mem = step(mem);
        if (!crossed) return;

        const now = Math.floor(Date.now() / 1000);
        const n32 = new Uint8Array(32);
        crypto.getRandomValues(n32);
        const auth: Authorization = {
          from, to: FEE_VAULT, value: String(owed),
          validAfter: String(now - 60), validBefore: String(now + 3600), nonce: toHex(n32),
        };
        const dsep = domainSep((chain as any).name, (chain as any).version, (chain as any).id, (chain as any).asset);
        const sig = signWith(makeNonce(), digest(dsep, auth), d);

        // The tally was reset inside the lock above, BEFORE this was signed - so a failed
        // hand-off cannot charge the studio twice, and no second instance can sweep the same
        // hundred sales again.
        if (await handOff(auth, sig)) collected += owed;
        else {
          pending = { auth, sig };
          cfg.onDiagnostic?.({ code: 'fee_handoff_failed',
            message: `holding a fee authorization for ${owed} to re-send with the same nonce` });
        }
      } catch (err) {
        // The fee must never break a sale.
        cfg.onDiagnostic?.({ code: 'fee_error',
          message: err instanceof Error ? err.message : String(err) });
      }
    },

    async stats() {
      const cur = cfg.store ? await cfg.store.get() : mem;
      return {
        enabled,
        salesSinceLastSweep: String(cur.count),
        accrued: String(cur.accrued / FEE_SCALE),
        collected: String(collected),
        /** Held and awaiting re-send. Not lost - the same authorization goes out next sale. */
        held: pending ? pending.auth.value : '0',
        /** Expired before it could be collected. This is genuinely gone. */
        lost: String(lost),
      };
    },
  };
}
