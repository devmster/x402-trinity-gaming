/**
 * THE HEADLESS STOREFRONT BRIDGE.
 *
 * A studio's own UI calls in; events come back out. Nothing here renders, opens a browser,
 * takes over input, or writes to the console. The player never learns this exists.
 *
 *     const store = createStorefront({
 *       payTo: '0x...',                       // where the studio is paid
 *       network: 'base',
 *       facilitator: 'https://...',
 *       catalog: { vanguard_skin_01: '1500000' },   // atomic units: 1.50 USDC
 *       nonceStore,                            // durable - see below
 *     });
 *
 *     store.on('settled', e => grantItem(e.playerId, e.itemId));
 *     store.on('declined', e => showRefusal(e.reason));
 *
 *     const quote = store.quote('vanguard_skin_01');   // client signs this
 *     await store.purchase({ itemId, playerId, playerAddress, authorization, signature });
 *
 * WHY THE SPLIT. The signature is the only thing that needs the player's key, and it is a
 * pure function - no network, no protocol. So it happens on the client, and everything
 * else happens here, on the studio's server, using the payment path that has been settling
 * real money on mainnet. The studio never holds a key and never holds a balance.
 */

import { createX402Seller, type SellerConfig, type GateResult } from './seller.ts';
import { createProceedsFee, type ProceedsFeeConfig } from './proceeds-fee.ts';
import type { Authorization } from './x402.ts';

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export interface PurchaseAccepted {
  itemId: string;
  playerId: string;
  playerAddress: string;
  /** Atomic units of the asset - NOT a float. 1.50 USDC is '1500000'. */
  amount: string;
}

export interface PurchaseSettled extends PurchaseAccepted {
  /** On-chain transaction hash. The money has moved. */
  transaction: string;
  network: string;
}

export interface PurchaseDeclined {
  itemId: string;
  playerId: string;
  /**
   * Machine-readable. Switch on this, do not parse `message`.
   *
   *   unknown_item          - not in the catalog
   *   already_used          - this authorization was already redeemed (replay)
   *   rejected              - the facilitator refused the signature or the amount
   *   settlement_failed     - VALID payment, our side could not complete it
   *   malformed             - the client sent something we could not read
   */
  code: 'unknown_item' | 'already_used' | 'rejected' | 'settlement_failed' | 'malformed';
  /** Human-readable detail for the studio's logs. Never shown to a player by us. */
  message: string;
  /**
   * True when the player's money is NOT at risk and the same authorization may be retried
   * unchanged. False means mint a fresh one - re-sending would risk paying twice.
   */
  retryable: boolean;
}

interface Events {
  accepted: PurchaseAccepted;
  settled: PurchaseSettled;
  declined: PurchaseDeclined;
}

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

export interface StorefrontConfig extends Omit<SellerConfig, 'price' | 'description'> {
  /**
   * itemId -> price in ATOMIC units of the asset, as a decimal string. USDC has 6 decimals,
   * so 1.50 is '1500000'. Strings, not numbers: a float cannot represent money exactly and
   * this value ends up inside a signature.
   */
  catalog: Record<string, string>;
  /**
   * Diagnostics for the studio's own logger. Nothing is ever printed - if this is absent,
   * problems are silent and purchases simply fail closed.
   */
  onDiagnostic?: (d: { code: string; message: string }) => void;
  /**
   * The network fee, taken out of PROCEEDS - the player is debited exactly the sticker
   * price and nothing is added on top. Requires `proceedsKey`, the key for the wallet named
   * in `payTo`, because moving money out of that wallet needs its own authorization.
   * Omit this and no fee is charged.
   */
  surcharge?: Omit<ProceedsFeeConfig, 'network' | 'onDiagnostic'>;
}

export interface PurchaseRequest {
  itemId: string;
  /** The studio's own player identifier. Passed through untouched, echoed on every event. */
  playerId: string;
  /** The wallet the player funds. Must match the authorization's `from`. */
  playerAddress: string;
  /** The EIP-3009 authorization the client signed. */
  authorization: Authorization;
  /** Its 65-byte signature, 0x-prefixed. */
  signature: string;
}

/* ------------------------------------------------------------------ *
 * The bridge
 * ------------------------------------------------------------------ */

export function createStorefront(cfg: StorefrontConfig) {
  const items = Object.keys(cfg.catalog);
  if (items.length === 0) throw new Error('storefront: catalog is empty');
  for (const [id, price] of Object.entries(cfg.catalog)) {
    if (!/^[0-9]+$/.test(price) || BigInt(price) <= 0n) {
      throw new Error(`storefront: price for '${id}' must be a positive integer in atomic units, got '${price}'`);
    }
  }

  // One seller per price point. The proven guard validates and settles; we only ever hand it
  // a request it already knows how to read, so none of that logic is reimplemented here.
  const sellers = new Map<string, ReturnType<typeof createX402Seller>>();
  const sellerFor = (itemId: string) => {
    let s = sellers.get(itemId);
    if (!s) {
      s = createX402Seller({ ...cfg, price: cfg.catalog[itemId], description: itemId });
      sellers.set(itemId, s);
    }
    return s;
  };

  const fee = createProceedsFee({
    ...cfg.surcharge,
    network: cfg.network,
    onDiagnostic: cfg.onDiagnostic,
  });
  // The fee comes out of the studio's own wallet, so it must BE the studio's own wallet.
  // Paying from somewhere else would silently drain a wallet that never agreed to it.
  if (fee.enabled && fee.from.toLowerCase() !== cfg.payTo.toLowerCase()) {
    throw new Error(
      `storefront: surcharge.proceedsKey belongs to ${fee.from}, but payTo is ${cfg.payTo}. ` +
      `The fee is taken from proceeds, so the key must be for the wallet that receives them.`);
  }

  const handlers: { [K in keyof Events]: Array<(e: Events[K]) => void> } =
    { accepted: [], settled: [], declined: [] };

  const emit = <K extends keyof Events>(name: K, e: Events[K]): void => {
    for (const h of handlers[name]) {
      // A studio handler that throws must not take down the payment path - the money has
      // already moved. Report it and carry on.
      try { h(e); }
      catch (err) {
        cfg.onDiagnostic?.({
          code: 'handler_threw',
          message: `${name} handler threw: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  };

  const decline = (e: PurchaseDeclined): PurchaseDeclined => { emit('declined', e); return e; };

  return {
    /** Item ids this storefront will sell. */
    get items(): string[] { return [...items]; },

    /** The network fee taken from proceeds: whether it is on, and what it has collected. */
    fee: { get enabled(): boolean { return fee.enabled; }, stats: () => fee.stats() },

    /**
     * What the client must sign to buy `itemId`: price, recipient, chain and the EIP-712
     * domain. Costs nothing and moves nothing.
     */
    quote(itemId: string) {
      if (!(itemId in cfg.catalog)) return null;
      return { itemId, ...sellerFor(itemId).requirements };
    },

    on<K extends keyof Events>(name: K, handler: (e: Events[K]) => void): () => void {
      handlers[name].push(handler);
      return () => {
        const i = handlers[name].indexOf(handler);
        if (i >= 0) handlers[name].splice(i, 1);
      };
    },

    /**
     * Redeem a signed authorization for an item.
     *
     * Emits `accepted` as soon as the request is well-formed and the item is real, then
     * `settled` or `declined`. The studio decides which one grants the item: `accepted` is
     * optimistic and fast, `settled` means the money has actually moved on-chain.
     */
    async purchase(req: PurchaseRequest): Promise<PurchaseSettled | PurchaseDeclined> {
      const { itemId, playerId, playerAddress, authorization, signature } = req;

      const amount = cfg.catalog[itemId];
      if (!amount) {
        return decline({ itemId, playerId, code: 'unknown_item',
          message: `no such item '${itemId}'`, retryable: false });
      }

      if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        return decline({ itemId, playerId, code: 'malformed',
          message: 'signature must be a 0x-prefixed 65-byte hex string', retryable: false });
      }
      if (authorization?.from?.toLowerCase() !== playerAddress.toLowerCase()) {
        return decline({ itemId, playerId, code: 'malformed',
          message: 'authorization.from does not match playerAddress', retryable: false });
      }
      // Checked here so a mismatch reads as 'malformed' rather than surfacing later as an
      // opaque facilitator rejection. The facilitator enforces it too - this is for clarity.
      if (authorization?.value !== amount) {
        return decline({ itemId, playerId, code: 'malformed',
          message: `authorization is for ${authorization?.value}, item costs ${amount}`, retryable: false });
      }

      emit('accepted', { itemId, playerId, playerAddress, amount });

      // Hand the proven guard exactly the shape it already parses: an x402 v2 payload in a
      // `payment-signature` header. The URL is synthetic - nothing fetches it - but it must
      // be a valid absolute URL because guard() builds its challenge from it.
      const payload = {
        x402Version: 2,
        scheme: 'exact',
        network: sellerFor(itemId).requirements.network,
        payload: { authorization, signature },
      };
      const request = new Request(`https://storefront.invalid/${encodeURIComponent(itemId)}`, {
        headers: { 'payment-signature': btoa(JSON.stringify(payload)) },
      });

      let gate: GateResult;
      try {
        gate = await sellerFor(itemId).guard(request);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        cfg.onDiagnostic?.({ code: 'guard_threw', message });
        // An exception here is our infrastructure, not the player's signature. The
        // authorization was never redeemed, so the SAME one is safe to present again.
        return decline({ itemId, playerId, code: 'settlement_failed', message, retryable: true });
      }

      if (gate.settlement) {
        const e: PurchaseSettled = {
          itemId, playerId, playerAddress, amount,
          transaction: gate.settlement.transaction,
          network: gate.settlement.network,
        };
        emit('settled', e);
        // Accrued AFTER the sale is final, and awaited so a batch that lands is reflected in
        // stats() before the caller sees the result. record() never throws - a fee problem
        // must not undo a sale that has already settled on-chain.
        await fee.record(BigInt(amount));
        return e;
      }

      // Settlement failed on OUR side with a valid payment. The nonce was never redeemed
      // on-chain, so re-presenting the same authorization is safe - and minting a fresh one
      // would risk paying twice if the first settlement later lands.
      if (gate.settlementFailed) {
        return decline({ itemId, playerId, code: 'settlement_failed',
          message: gate.reason ?? 'settlement failed', retryable: true });
      }

      const reason = gate.reason ?? 'refused';
      const alreadyUsed = reason.includes('nonce already used');
      return decline({
        itemId, playerId,
        code: alreadyUsed ? 'already_used' : 'rejected',
        message: reason,
        // A spent nonce will never become unspent, and a rejected signature will not become
        // valid. Both need a fresh authorization, not a retry.
        retryable: false,
      });
    },
  };
}
