/**
 * OFF-CHAIN MICRO-ACTION LEDGER.
 *
 * Survival, MMO and sandbox economies charge constantly and in fractions of a cent - a timer
 * skip, a stack of ore, a repair. Settling each one on-chain costs more in gas than the
 * action costs the player, so nothing here touches the chain per action.
 *
 * Instead the player opens a TAB: one signed authorization, settled once, credited to a local
 * ledger. Every action after that is a synchronous deduction - no signature, no network, no
 * frame cost. When the tab runs low the player tops up with another single signature.
 *
 *     const tab = await tabs.open({ playerId, playerAddress, authorization, signature });
 *     tabs.spend({ playerId, actionId: 'skip:furnace:8412', amount: '20000' });  // instant
 *
 * WHY A TAB AND NOT A HUNDRED CACHED SIGNATURES. An EIP-3009 authorization is redeemed by its
 * own contract call with its own nonce; a hundred of them cannot be summed into one transfer.
 * Caching signatures and flushing them together still costs a hundred settlements - about
 * 6.4% of a $2.00 batch at real Base gas, against 0.06% for a single one. The saving comes
 * from one signature covering the batch, not from when the signatures are sent.
 *
 * WHY PREPAID AND NOT POSTPAID. Charging at the END of a hundred actions means granting
 * ninety-nine of them on credit. A player who closes the game keeps them, and a farm of bots
 * does it deliberately. Money in hand first removes the question.
 */

import { createStorefront, type StorefrontConfig, type PurchaseDeclined } from './storefront.ts';
import { signPurchase } from './signer.ts';
import type { Authorization } from './x402.ts';

export interface TabConfig extends Omit<StorefrontConfig, 'catalog'> {
  /**
   * Tab sizes a player may open, in atomic units. Named like a catalog because that is what
   * they are - a $2.00 tab is a $2.00 purchase that happens to be spent gradually.
   */
  tabs: Record<string, string>;
  /**
   * Durable ledger. WITHOUT ONE, EVERY PLAYER'S REMAINING BALANCE IS LOST ON RESTART - they
   * paid for credit the process no longer remembers. In memory is for local development only.
   */
  ledger?: LedgerStore;
  /** Warn when a tab drops below this fraction of its opening size. Default 0.15. */
  lowWaterMark?: number;
}

export interface LedgerStore {
  get: (playerId: string) => Promise<TabState | null>;
  set: (playerId: string, s: TabState) => Promise<void>;
  /** Read-modify-write under a lock. Without it two game servers double-spend one tab. */
  update?: (playerId: string, fn: (cur: TabState | null) => TabState) => Promise<TabState>;
}

export interface TabState {
  playerAddress: string;
  /** Atomic units still available. */
  remaining: string;
  /** What the tab was opened for, for reporting. */
  opened: string;
  /**
   * Action ids already charged, with when. Kept BY AGE rather than by count: a retry happens
   * within seconds, so a day is generous - and a cap by count means a long-lived tab silently
   * forgets an old id and charges for it a second time.
   */
  spent: Array<{ id: string; at: number }>;
  updatedAt: string;
}

export type SpendResult =
  | { ok: true; remaining: string; charged: string; duplicate: boolean }
  | { ok: false; code: 'no_tab' | 'insufficient' | 'invalid_amount'; remaining: string; message: string };

export type RefundResult =
  | { ok: true; refunded: string; remaining: string; transaction: string }
  | { ok: false; code: 'no_tab' | 'nothing_to_refund' | 'too_much' | 'no_key' | 'failed';
      remaining: string; message: string };

interface Events {
  opened: { playerId: string; playerAddress: string; amount: string; transaction: string };
  refunded: { playerId: string; playerAddress: string; amount: string; transaction: string };
  spent: { playerId: string; actionId: string; amount: string; remaining: string };
  low: { playerId: string; remaining: string; opened: string };
  exhausted: { playerId: string };
}

export function createBatchManager(cfg: TabConfig) {
  const sizes = Object.entries(cfg.tabs);
  if (sizes.length === 0) throw new Error('batch manager: no tab sizes configured');
  for (const [id, v] of sizes) {
    if (!/^[0-9]+$/.test(v) || BigInt(v) <= 0n) {
      throw new Error(`batch manager: tab '${id}' must be a positive integer in atomic units, got '${v}'`);
    }
  }

  // Opening a tab IS a purchase - same signature, same guard, same fee out of proceeds. The
  // only difference is that what the player receives is credit rather than an item.
  const store = createStorefront({ ...cfg, catalog: cfg.tabs });

  const mem = new Map<string, TabState>();
  const lowAt = cfg.lowWaterMark ?? 0.15;

  const handlers: { [K in keyof Events]: Array<(e: Events[K]) => void> } =
    { opened: [], refunded: [], spent: [], low: [], exhausted: [] };
  const emit = <K extends keyof Events>(n: K, e: Events[K]): void => {
    for (const h of handlers[n]) {
      try { h(e); } catch (err) {
        cfg.onDiagnostic?.({ code: 'handler_threw',
          message: `${n} handler threw: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  };

  const read = async (playerId: string): Promise<TabState | null> =>
    cfg.ledger ? cfg.ledger.get(playerId) : (mem.get(playerId) ?? null);

  const write = async (playerId: string, s: TabState): Promise<void> => {
    if (cfg.ledger) await cfg.ledger.set(playerId, s);
    else mem.set(playerId, s);
  };

  return {
    /** Tab sizes on offer. */
    get sizes(): string[] { return sizes.map(([id]) => id); },

    /** What the client signs to open tab `tabId`. */
    quote(tabId: string) { return store.quote(tabId); },

    on<K extends keyof Events>(n: K, h: (e: Events[K]) => void): () => void {
      handlers[n].push(h);
      return () => { const i = handlers[n].indexOf(h); if (i >= 0) handlers[n].splice(i, 1); };
    },

    /**
     * Open or top up a tab. This is the ONLY on-chain step - one settlement covering every
     * action the player takes until the balance runs out.
     *
     * Credit is added only after the transfer settles. A declined payment adds nothing.
     */
    async open(req: {
      tabId: string; playerId: string; playerAddress: string;
      authorization: Authorization; signature: string;
    }): Promise<{ ok: true; remaining: string; transaction: string } | { ok: false; declined: PurchaseDeclined }> {
      const result = await store.purchase({
        itemId: req.tabId, playerId: req.playerId, playerAddress: req.playerAddress,
        authorization: req.authorization, signature: req.signature,
      });
      if (!('transaction' in result)) return { ok: false, declined: result };

      const add = BigInt(result.amount);
      const cur = await read(req.playerId);
      // Topping up adds to what is left rather than replacing it - a player who tops up at
      // 10% remaining should not lose that 10%.
      const next: TabState = {
        playerAddress: req.playerAddress,
        remaining: String((cur ? BigInt(cur.remaining) : 0n) + add),
        opened: String((cur ? BigInt(cur.opened) : 0n) + add),
        spent: cur?.spent ?? [],
        updatedAt: new Date().toISOString(),
      };
      await write(req.playerId, next);
      emit('opened', { playerId: req.playerId, playerAddress: req.playerAddress,
                       amount: result.amount, transaction: result.transaction });
      return { ok: true, remaining: next.remaining, transaction: result.transaction };
    },

    /**
     * Charge one micro-action. Synchronous in spirit - no signature, no chain, no network -
     * so it is safe on a gameplay path.
     *
     * `actionId` makes it idempotent. A client that retries after a dropped response charges
     * once, and the second call reports `duplicate: true` so you can grant without re-billing.
     */
    async spend(req: { playerId: string; actionId: string; amount: string }): Promise<SpendResult> {
      const { playerId, actionId, amount } = req;
      if (!/^[0-9]+$/.test(amount) || BigInt(amount) <= 0n) {
        return { ok: false, code: 'invalid_amount', remaining: '0',
                 message: `amount must be a positive integer in atomic units, got '${amount}'` };
      }

      // Checked BEFORE the update, not inside it. LedgerStore.update must return a state to
      // write, so signalling "no tab" from within it wrote a phantom empty row for a player
      // who never paid for anything.
      if (!(await read(playerId))) {
        return { ok: false, code: 'no_tab', remaining: '0', message: 'no open tab' };
      }

      let out: SpendResult = { ok: false, code: 'no_tab', remaining: '0', message: 'no open tab' };
      // `step` runs inside a callback, and TypeScript cannot follow assignments across that
      // boundary - reading through a function hands back the declared union rather than the
      // narrowed initial literal.
      const outcome = (): SpendResult => out;
      let low = false, empty = false;

      const step = (cur: TabState | null): TabState => {
        if (!cur) {
          // Only reachable if the tab vanished between the check above and this callback.
          out = { ok: false, code: 'no_tab', remaining: '0', message: 'no open tab' };
          return { playerAddress: '', remaining: '0', opened: '0', spent: [], updatedAt: new Date().toISOString() };
        }
        if (cur.spent.some(e => e.id === actionId)) {
          out = { ok: true, remaining: cur.remaining, charged: '0', duplicate: true };
          return cur;
        }
        const rem = BigInt(cur.remaining), amt = BigInt(amount);
        if (rem < amt) {
          out = { ok: false, code: 'insufficient', remaining: cur.remaining,
                  message: `tab has ${cur.remaining}, action costs ${amount}` };
          return cur;
        }
        const left = rem - amt;
        out = { ok: true, remaining: String(left), charged: amount, duplicate: false };
        low = left > 0n && Number(left) < Number(BigInt(cur.opened)) * lowAt;
        empty = left === 0n;
        return {
          ...cur,
          remaining: String(left),
          // Bounded by age, not by count. The ledger store prunes on write as well; this
          // keeps the in-memory path from growing without bound over a long session.
          spent: [...cur.spent.filter(e => e.at > Date.now() - 86_400_000), { id: actionId, at: Date.now() }],
          updatedAt: new Date().toISOString(),
        };
      };

      if (cfg.ledger?.update) await cfg.ledger.update(playerId, step);
      else {
        const cur = await read(playerId);
        const next = step(cur);
        if (cur) await write(playerId, next);
      }

      const res = outcome();
      if (res.ok && !res.duplicate) {
        emit('spent', { playerId, actionId, amount, remaining: res.remaining });
        const st = await read(playerId);
        if (low && st) emit('low', { playerId, remaining: st.remaining, opened: st.opened });
        if (empty) emit('exhausted', { playerId });
      }
      return res;
    },

    /**
     * Return unspent credit to the player's wallet.
     *
     * The studio signs an authorization to the player and the facilitator submits it, so the
     * studio needs no gas - the same shape as every other transfer here, just pointing the
     * other way. Requires `surcharge.proceedsKey`, because that is the key for the wallet
     * holding the money.
     *
     * ORDER MATTERS. The credit is deducted BEFORE the transfer is attempted, so it cannot be
     * spent while the refund is in flight, and restored if the transfer fails. The opposite
     * order lets a player spend the same money twice - once in-game and once on-chain.
     *
     * The 0.1% taken when the tab opened is NOT reversed. It was charged on a sale that did
     * happen, and clawing it back out of the vault is not something this can do.
     */
    async refund(req: { playerId: string; amount?: string }): Promise<RefundResult> {
      const { playerId } = req;
      const key = cfg.surcharge?.proceedsKey;
      if (!key) {
        return { ok: false, code: 'no_key', remaining: '0',
                 message: 'refunds need surcharge.proceedsKey - the key for the payTo wallet' };
      }

      const cur = await read(playerId);
      if (!cur) return { ok: false, code: 'no_tab', remaining: '0', message: 'no open tab' };

      const rem = BigInt(cur.remaining);
      if (rem === 0n) {
        return { ok: false, code: 'nothing_to_refund', remaining: '0', message: 'tab is empty' };
      }
      const amount = req.amount ?? cur.remaining;
      if (!/^[0-9]+$/.test(amount) || BigInt(amount) <= 0n) {
        return { ok: false, code: 'too_much', remaining: cur.remaining,
                 message: `amount must be a positive integer in atomic units, got '${amount}'` };
      }
      if (BigInt(amount) > rem) {
        return { ok: false, code: 'too_much', remaining: cur.remaining,
                 message: `tab has ${cur.remaining}, cannot refund ${amount}` };
      }

      // Reserve first. A refund in flight must not also be spendable in-game.
      const reserved: TabState = {
        ...cur,
        remaining: String(rem - BigInt(amount)),
        updatedAt: new Date().toISOString(),
      };
      if (cfg.ledger?.update) await cfg.ledger.update(playerId, () => reserved);
      else await write(playerId, reserved);

      const restore = async (): Promise<void> => {
        const now = await read(playerId);
        const back: TabState = {
          ...(now ?? reserved),
          remaining: String(BigInt(now?.remaining ?? reserved.remaining) + BigInt(amount)),
          updatedAt: new Date().toISOString(),
        };
        if (cfg.ledger?.update) await cfg.ledger.update(playerId, () => back);
        else await write(playerId, back);
      };

      try {
        // The studio signs, paying the player. Same primitive, opposite direction.
        const quote = { ...store.quote(sizes[0][0])!, amount, payTo: cur.playerAddress };
        const signed = signPurchase(quote as never, key);

        const r = await fetch(cfg.facilitator.replace(/\/$/, '') + '/settle', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            x402Version: 2,
            paymentPayload: {
              x402Version: 2, scheme: 'exact', network: quote.network,
              payload: { authorization: signed.authorization, signature: signed.signature },
            },
            paymentRequirements: {
              scheme: 'exact', network: quote.network, payTo: cur.playerAddress,
              asset: quote.asset, amount, maxAmountRequired: amount,
              maxTimeoutSeconds: 300, extra: quote.extra,
            },
          }),
        });
        const body = r.ok ? await r.json().catch(() => null) : null;
        if (body?.success !== true) {
          await restore();
          const why = body?.errorReason ?? `facilitator returned ${r.status}`;
          cfg.onDiagnostic?.({ code: 'refund_failed', message: String(why) });
          return { ok: false, code: 'failed', remaining: cur.remaining,
                   message: `refund not settled: ${why} - the credit was returned to the tab` };
        }

        const after = await read(playerId);
        emit('refunded', { playerId, playerAddress: cur.playerAddress, amount,
                           transaction: body.transaction });
        return { ok: true, refunded: amount, remaining: after?.remaining ?? reserved.remaining,
                 transaction: body.transaction };
      } catch (err) {
        await restore();
        const message = err instanceof Error ? err.message : String(err);
        cfg.onDiagnostic?.({ code: 'refund_error', message });
        return { ok: false, code: 'failed', remaining: cur.remaining,
                 message: `${message} - the credit was returned to the tab` };
      }
    },

    /** What the player has left. Read-only. */
    async balance(playerId: string): Promise<{ remaining: string; opened: string } | null> {
      const s = await read(playerId);
      return s ? { remaining: s.remaining, opened: s.opened } : null;
    },

    /** The network fee taken from proceeds when a tab is opened. */
    fee: store.fee,
  };
}
