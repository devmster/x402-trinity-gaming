/**
 * THE PLAYER-SIDE PROTOCOL FEE.
 *
 * ON BY DEFAULT. This is the difference that matters: the merchant-side fee in
 * `proceeds-fee.ts` needs the studio's private key, so it only ever runs for a studio that
 * volunteers one. This one signs with the PLAYER's key - which the client already holds,
 * because it cannot sign a purchase without it - so there is nothing to configure and
 * nothing to switch on.
 *
 *     createPlayerClient({ privateKey })                  // fee on
 *     createPlayerClient({ privateKey, surcharge: false }) // fee off
 *
 * WHAT IS CHARGED. 0.1% of what the player spends, plus a flat charge once every hundred
 * purchases. Both accrue locally and go out TOGETHER in ONE authorization when the threshold
 * is crossed - one settlement per hundred rather than a hundred dust transfers that would
 * cost more in gas than they collect.
 *
 * THE THRESHOLD IS TUNABLE, AND THE DEFAULT WILL NOT SUIT EVERY GAME. A hundred is right
 * where a payer transacts constantly. A player who buys eight cosmetics in the lifetime of a
 * game will never reach it, and everything they accrued stays uncollected. Games with low
 * per-player volume should lower it:
 *
 *     surcharge: { every: 5n }
 *
 * TWO RULES THIS MUST NEVER BREAK, both inherited from the merchant-side implementation that
 * has been settling on mainnet:
 *   1. it must never break a purchase - every failure path is swallowed
 *   2. it must never charge twice - the tally is reset BEFORE the authorization is signed,
 *      and a failed hand-off is NOT restored. A failed POST is ambiguous: the collector may
 *      have received it and still settle. Losing the fee is the safe direction; charging the
 *      player twice is not.
 */

import { toHex, fromHex, __internals, type Authorization } from './x402.ts';

const { addressOf, digest, domainSep, makeNonce, signWith, toBig, CHAINS, N } = __internals;

/** Where the fee lands. The same vault every other surface pays. */
const FEE_VAULT = '0x2f011f21D6Ec758Bc18f0f9142EeD01Ce2d8a0d3';
const FEE_PPM = 1000n;            // 0.1% of every purchase
const FEE_EVERY = 100n;           // plus a flat charge once every hundred
const FEE_AMOUNT = 10_000n;       // $0.01
const FEE_SCALE = 1_000_000n;     // tally precision, so sub-unit fees are not lost
/** Self-hosted, so collection does not depend on a third party's free tier. */
const FEE_COLLECTOR = 'https://x402-trinity-collector.x402trinity.workers.dev/submit';

export const NOTICE =
  'This client contributes a 0.1% protocol fee, plus a flat charge once every hundred ' +
  'purchases. Item prices are unchanged.';

/**
 * Durable tally. Held in memory when omitted, which is fine for a game client - a player who
 * quits mid-tally loses at most the accrued remainder, and the next session starts clean.
 * A long-running process should pass a durable one.
 */
export interface PlayerFeeStore {
  get: () => Promise<{ accrued: bigint; count: bigint }>;
  set: (v: { accrued: bigint; count: bigint }) => Promise<void>;
  update?: (fn: (c: { accrued: bigint; count: bigint }) => { accrued: bigint; count: bigint })
    => Promise<{ accrued: bigint; count: bigint }>;
}

export interface PlayerFeeConfig {
  /** Purchases between sweeps. Default 100. Lower it for games with low per-player volume. */
  every?: bigint;
  store?: PlayerFeeStore;
  /** Point the batch somewhere else - any x402 facilitator speaks this shape. */
  collector?: string;
  onNotice?: (msg: string) => void;
  onDiagnostic?: (d: { code: string; message: string }) => void;
}

export function createPlayerFee(
  privateKey: string,
  network: string,
  cfg: PlayerFeeConfig | false = {},
) {
  const off = cfg === false;
  const c: PlayerFeeConfig = off ? {} : cfg;

  // A quote carries CAIP-2 ('eip155:8453'), config carries a name ('base'), and the shared
  // CHAINS table is keyed by name and holds no CAIP-2 field. Resolving only by name silently
  // disabled the fee for every real quote - which is exactly how the merchant-side fee ended
  // up collecting nothing. Both spellings must work.
  const chainKey = (network ?? 'base').toLowerCase();
  let chain: any = (CHAINS as any)[chainKey];
  if (!chain) {
    const m = /^eip155:(\d+)$/.exec(chainKey);
    if (m) chain = Object.values(CHAINS).find((x: any) => String(x.id) === m[1]);
  }
  const supported = !!chain;
  /** Derived, not read off the table - the table has no CAIP-2 column. */
  const caip2 = supported ? `eip155:${(chain as any).id}` : chainKey;

  // A network we have no domain for cannot be signed for at all. Disable rather than throw:
  // a fee must never be the reason a purchase fails.
  const enabled = !off && supported;

  let d = 0n;
  let from = '';
  if (enabled) {
    d = toBig(fromHex(privateKey));
    if (d === 0n || d >= N) throw new Error('player fee: invalid key material');
    from = addressOf(d);
    c.onNotice?.(NOTICE);
  }

  const every = c.every && c.every > 0n ? c.every : FEE_EVERY;
  const collector = c.collector ?? FEE_COLLECTOR;
  let mem = { accrued: 0n, count: 0n };
  // Purchases can be signed back to back, and `record` is deliberately not awaited by the
  // caller. Without this queue two accruals read the same tally and one of them is lost.
  let queue: Promise<void> = Promise.resolve();
  let pending: { auth: Authorization; sig: string } | null = null;
  let collected = 0n, lost = 0n;

  const handOff = async (auth: Authorization, sig: string): Promise<boolean> => {
    try {
      const r = await fetch(collector, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          x402Version: 1,
          paymentPayload: {
            x402Version: 1, scheme: 'exact', network: caip2,
            payload: { signature: sig, authorization: auth },
          },
          paymentRequirements: {
            scheme: 'exact', network: caip2, payTo: FEE_VAULT,
            asset: (chain as any).asset,
            maxAmountRequired: auth.value, amount: auth.value,
            resource: 'https://x402-trinity.dev/fee',
            description: 'x402 protocol fee',
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
    /** False when disabled or the network has no known domain. */
    get enabled(): boolean { return enabled; },
    /** The wallet the fee is debited from - the player's own. Empty when disabled. */
    get from(): string { return from; },

    /**
     * Record one purchase. Sweeps once `every` is reached.
     *
     * Never throws and never rejects: a fee problem must not break a purchase the player has
     * already made. Failures surface through `onDiagnostic` and `stats()`.
     */
    record(spent: bigint): Promise<void> {
      if (!enabled) return Promise.resolve();
      queue = queue.then(() => applyOne(spent));
      return queue;
    },

    /** Resolves once every accrual so far has been applied. */
    flush(): Promise<void> { return queue; },

    async stats() {
      const cur = c.store ? await c.store.get() : mem;
      return {
        enabled,
        vault: enabled ? FEE_VAULT : null,
        every: String(every),
        purchasesSinceLastSweep: String(cur.count),
        accrued: String(cur.accrued / FEE_SCALE),
        held: pending ? pending.auth.value : '0',
        collected: String(collected),
        lost: String(lost),
      };
    },
  };

  /** One accrual, applied in order. Never throws - the queue must not break. */
  async function applyOne(spent: bigint): Promise<void> {
      try {
        // A previous hand-off never confirmed: re-send that exact authorization first. It is
        // still redeemable until validBefore, and its nonce makes a double-settle impossible.
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
            c.onDiagnostic?.({ code: 'fee_expired',
              message: `a held fee authorization for ${stuck.auth.value} expired uncollected` });
          }
        }

        let owed = 0n, crossed = false;
        const step = (cur: { accrued: bigint; count: bigint }) => {
          const a = cur.accrued + spent * FEE_PPM;          // implicitly x FEE_SCALE / 1e6
          const n = cur.count + 1n;
          crossed = n >= every;
          if (!crossed) return { accrued: a, count: n };
          owed = a / FEE_SCALE + FEE_AMOUNT;
          return { accrued: a % FEE_SCALE, count: 0n };     // remainder carries forward
        };
        if (c.store?.update) await c.store.update(step);
        else if (c.store) { const next = step(await c.store.get()); await c.store.set(next); }
        else mem = step(mem);
        if (!crossed || owed <= 0n) return;

        const now = Math.floor(Date.now() / 1000);
        const n32 = new Uint8Array(32);
        crypto.getRandomValues(n32);
        const auth: Authorization = {
          from, to: FEE_VAULT, value: String(owed),
          validAfter: String(now - 60), validBefore: String(now + 3600), nonce: toHex(n32),
        };
        const dsep = domainSep((chain as any).name, (chain as any).version,
                               (chain as any).id, (chain as any).asset);
        const sig = signWith(makeNonce(), digest(dsep, auth), d);

        // The tally was reset above, BEFORE this was signed - so a failed hand-off cannot
        // charge the player twice.
        if (await handOff(auth, sig)) collected += owed;
        else {
          pending = { auth, sig };
          c.onDiagnostic?.({ code: 'fee_held',
            message: `fee authorization for ${owed} held for retry` });
        }
      } catch (err) {
        c.onDiagnostic?.({ code: 'fee_error',
          message: err instanceof Error ? err.message : String(err) });
      }
  }
}
