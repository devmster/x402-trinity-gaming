/**
 * THE WHOLE LOOP, OFFLINE.
 *
 *   node --experimental-strip-types test/loop.ts
 *
 * Proves the client signer and the backend bridge fit together before any real money is
 * involved: a player wallet signs a quote, the backend redeems it, the events fire in order.
 * The facilitator is a stub that verifies the signature the way the real one does - by
 * recovering it - so a broken signature fails here rather than on mainnet.
 */

import { createStorefront } from '../src/storefront.ts';
import { signPurchase, createPlayerWallet, addressFor } from '../src/signer.ts';
import { toHex, fromHex, __internals } from '../src/x402.ts';
import { recoverSigner } from '../src/evm-tx.ts';

const { digest, domainSep, CHAINS, toBig } = __internals;

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ok    ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
};
const hdr = (s: string): void => console.log('\n' + s + '\n' + '-'.repeat(s.length));

const STUDIO = '0x9f2c4a1b3d5e6f708192a3b4c5d6e7f809a1b2c3';
const PRICE = '1500000';                       // 1.50 USDC

/* A facilitator that behaves like the real one: verify by recovery, settle once. */
const settled = new Set<string>();
let settleCalls = 0, verifyCalls = 0;
const realFetch = globalThis.fetch;
let facilitatorOpts: { failSettle?: boolean } = {};
const installFacilitator = (opts: { failSettle?: boolean } = {}) => { facilitatorOpts = opts; };
const facilitator = async (url: string, init?: RequestInit) => {
  const opts = facilitatorOpts;
  const body = JSON.parse(String(init?.body ?? '{}'));
  const a = body?.paymentPayload?.payload?.authorization;
  const sig = body?.paymentPayload?.payload?.signature;
  const send = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

  if (url.endsWith('/verify')) {
    verifyCalls++;
    const dsep = domainSep('USD Coin', '2', 8453, CHAINS['base'].asset);
    const signer = a ? recoverSigner(digest(dsep, a), sig) : null;
    const good = !!signer && signer === a.from.toLowerCase()
      && a.to.toLowerCase() === STUDIO.toLowerCase() && a.value === PRICE;
    return send(good ? { isValid: true, payer: signer } : { isValid: false, invalidReason: 'sig' });
  }
  if (url.endsWith('/settle')) {
    settleCalls++;
    if (opts.failSettle) return send({ success: false, errorReason: 'facilitator down' });
    if (settled.has(a.nonce)) return send({ success: false, errorReason: 'nonce already used' });
    settled.add(a.nonce);
    return send({ success: true, transaction: '0x' + 'ab'.repeat(32), payer: a.from, network: 'eip155:8453' });
  }
  return send({ error: 'not found' });
};

const nonceStore = () => {
  const seen = new Set<string>();
  return {
    seen: async (n: string) => seen.has(n),
    add: async (n: string, _expiresAtUnix: number) => { seen.add(n); },
  };
};

const store = (opts: { failSettle?: boolean } = {}) => (installFacilitator(opts), createStorefront({
  payTo: STUDIO,
  network: 'base',
  facilitator: 'https://facilitator.test',
  nonceStore: nonceStore(),
  catalog: { vanguard_skin_01: PRICE },
  settleRetries: 1,
}));

globalThis.fetch = ((url: any, init: any) =>
  facilitator(String(url instanceof Request ? url.url : url), init)) as typeof globalThis.fetch;

/* ================= 1. the wallet ================= */
hdr('1. a player is issued a wallet they alone control');
const player = createPlayerWallet();
ok('key is 32 bytes', /^0x[0-9a-f]{64}$/.test(player.privateKey));
ok('address is derived from it, not stored separately', addressFor(player.privateKey) === player.address);
{
  const a = createPlayerWallet(), b = createPlayerWallet();
  ok('two wallets are not the same', a.privateKey !== b.privateKey);
}

/* ================= 2. the signature ================= */
hdr('2. the client signs a quote');
const s = store();
const quote = s.quote('vanguard_skin_01')!;
ok('a quote names the price, the payee and the chain',
   quote.amount === PRICE && quote.payTo === STUDIO && !!quote.network, quote.network);
ok('an unknown item has no quote', s.quote('nope') === null);

const signed = signPurchase(quote as never, player.privateKey);
ok('the authorization pays the studio, not someone else', signed.authorization.to === STUDIO);
ok('...for exactly the asking price', signed.authorization.value === PRICE);
ok('...from the player who signed it', signed.authorization.from === player.address);
ok('...and it expires', Number(signed.authorization.validBefore) > Math.floor(Date.now() / 1000));
{
  const dsep = domainSep('USD Coin', '2', 8453, CHAINS['base'].asset);
  const rec = recoverSigner(digest(dsep, signed.authorization), signed.signature);
  ok('the signature recovers to the player', rec === player.address.toLowerCase(), rec ?? 'null');
}
{
  const a = signPurchase(quote as never, player.privateKey);
  const b = signPurchase(quote as never, player.privateKey);
  ok('every purchase carries a fresh nonce', a.authorization.nonce !== b.authorization.nonce);
}

/* ================= 3. the loop ================= */
hdr('3. the backend redeems it and the events fire');
{
  const st = store();
  const seen: string[] = [];
  st.on('accepted', () => seen.push('accepted'));
  st.on('settled', () => seen.push('settled'));
  st.on('declined', () => seen.push('declined'));

  const sp = signPurchase(st.quote('vanguard_skin_01')! as never, player.privateKey);
  const r = await st.purchase({
    itemId: 'vanguard_skin_01', playerId: 'player-8823',
    playerAddress: sp.playerAddress, authorization: sp.authorization, signature: sp.signature,
  });

  ok('the purchase settles', 'transaction' in r, JSON.stringify(r).slice(0, 90));
  ok('accepted fires before settled', seen.join(',') === 'accepted,settled', seen.join(','));
  ok('the event carries the studio\'s own player id', (r as any).playerId === 'player-8823');
  ok('...and an on-chain transaction', /^0x[0-9a-f]{64}$/.test((r as any).transaction ?? ''));
}

/* ================= 4. refusals ================= */
hdr('4. what happens when it should not go through');
{
  const st = store();
  const sp = signPurchase(st.quote('vanguard_skin_01')! as never, player.privateKey);
  const base = { playerId: 'p1', playerAddress: sp.playerAddress, authorization: sp.authorization, signature: sp.signature };

  const unknown = await st.purchase({ ...base, itemId: 'not_for_sale' });
  ok('an item that is not for sale is refused', (unknown as any).code === 'unknown_item');
  ok('...and that is not retryable', (unknown as any).retryable === false);

  const badSig = await st.purchase({ ...base, itemId: 'vanguard_skin_01', signature: '0xdeadbeef' });
  ok('a malformed signature is refused before the facilitator sees it',
     (badSig as any).code === 'malformed');

  const mismatched = await st.purchase({ ...base, itemId: 'vanguard_skin_01', playerAddress: STUDIO });
  ok('an authorization that does not match the named player is refused',
     (mismatched as any).code === 'malformed');
}
{
  // The replay guard: the same signature must not buy the item twice.
  const st = store();
  const sp = signPurchase(st.quote('vanguard_skin_01')! as never, player.privateKey);
  const req = { itemId: 'vanguard_skin_01', playerId: 'p2', playerAddress: sp.playerAddress,
                authorization: sp.authorization, signature: sp.signature };
  const first = await st.purchase(req);
  const again = await st.purchase(req);
  ok('the first redemption settles', 'transaction' in first);
  ok('the same authorization cannot buy it twice', (again as any).code === 'already_used', JSON.stringify(again).slice(0, 80));
  ok('...and re-sending it would be pointless', (again as any).retryable === false);
}
{
  // Settlement failing on OUR side is the one case where the SAME authorization must be
  // re-presented - minting a fresh one risks paying twice if the first one later lands.
  const st = store({ failSettle: true });
  const sp = signPurchase(st.quote('vanguard_skin_01')! as never, player.privateKey);
  const r = await st.purchase({
    itemId: 'vanguard_skin_01', playerId: 'p3',
    playerAddress: sp.playerAddress, authorization: sp.authorization, signature: sp.signature,
  });
  ok('a settlement failure is not reported as "you did not pay"',
     (r as any).code === 'settlement_failed', (r as any).message);
  ok('...and it IS retryable with the same authorization', (r as any).retryable === true);
}

/* ================= 5. the studio's process stays clean ================= */
hdr('5. nothing is written to the studio\'s console');
{
  const writes: string[] = [];
  const real = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => writes.push(String(a[0]));
  console.error = (...a) => writes.push(String(a[0]));
  console.warn = (...a) => writes.push(String(a[0]));
  const st = store();
  const sp = signPurchase(st.quote('vanguard_skin_01')! as never, player.privateKey);
  await st.purchase({ itemId: 'vanguard_skin_01', playerId: 'p4',
    playerAddress: sp.playerAddress, authorization: sp.authorization, signature: sp.signature });
  console.log = real.log; console.error = real.error; console.warn = real.warn;
  ok('a full purchase prints nothing', writes.length === 0, writes.join(' | ').slice(0, 120));
}
{
  // A studio handler that throws must not take down the payment path - the money has moved.
  const st = store();
  const diags: string[] = [];
  (st as any); // storefront was built with onDiagnostic omitted here on purpose
  st.on('settled', () => { throw new Error('studio handler blew up'); });
  const sp = signPurchase(st.quote('vanguard_skin_01')! as never, player.privateKey);
  const r = await st.purchase({ itemId: 'vanguard_skin_01', playerId: 'p5',
    playerAddress: sp.playerAddress, authorization: sp.authorization, signature: sp.signature });
  ok('a throwing studio handler does not fail the purchase', 'transaction' in r);
}

console.log('\nsummary\n' + '-'.repeat(7));
console.log(`  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
