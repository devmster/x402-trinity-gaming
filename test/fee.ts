/**
 * THE MERCHANT FEE.
 *
 *   node --experimental-strip-types test/fee.ts
 *
 * The gap this exists to close: the first cut of the storefront carried the fee CONSTANTS
 * but never reached the fee CODE, so a mainnet sale collected nothing and nobody noticed
 * until the vault was checked. These assert the money, not the wiring.
 */

import { createStorefront } from '../src/storefront.ts';
import { createProceedsFee } from '../src/proceeds-fee.ts';
import { signPurchase, createPlayerWallet } from '../src/signer.ts';
import { fromHex, __internals } from '../src/x402.ts';
import { recoverSigner } from '../src/evm-tx.ts';

const { digest, domainSep, CHAINS, addressOf, toBig } = __internals;

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = ''): void => {
  if (c) { pass++; console.log(`  ok    ${n}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}  ${d}`); }
};
const hdr = (s: string): void => console.log('\n' + s + '\n' + '-'.repeat(s.length));

const VAULT = '0x2f011f21d6ec758bc18f0f9142eed01ce2d8a0d3';
const PRICE = '20000';                       // $0.02 a sale
const STUDIO_KEY = '0x' + '2b'.repeat(32);
const STUDIO = addressOf(toBig(fromHex(STUDIO_KEY)));

/* A facilitator that settles, plus a collector that records what the fee batch sent. */
const swept: Array<{ auth: any; from: string; to: string; value: string; sig: string }> = [];
let collectorUp = true;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init: any) => {
  const url = String(u instanceof Request ? u.url : u);
  const body = JSON.parse(String(init?.body ?? '{}'));
  const a = body?.paymentPayload?.payload?.authorization;
  const send = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

  if (url.includes('/submit')) {                       // the fee collector
    if (!collectorUp) return new Response('down', { status: 502 });
    swept.push({ auth: a, from: a.from, to: a.to, value: a.value, sig: body.paymentPayload.payload.signature });
    return send({ success: true, transaction: '0x' + 'fe'.repeat(32) });
  }
  if (url.endsWith('/verify')) return send({ isValid: true, payer: a.from });
  if (url.endsWith('/settle')) return send({ success: true, transaction: '0x' + 'ab'.repeat(32), payer: a.from, network: 'eip155:8453' });
  return send({});
}) as typeof globalThis.fetch;

const store = (surcharge?: any) => {
  const seen = new Set<string>();
  return createStorefront({
    payTo: STUDIO, network: 'base', facilitator: 'https://f.test',
    nonceStore: { seen: async n => seen.has(n), add: async n => { seen.add(n); } },
    catalog: { skin: PRICE }, settleRetries: 1,
    surcharge,
  });
};
const buy = async (st: ReturnType<typeof store>, i: number) => {
  const p = createPlayerWallet();
  const sp = signPurchase(st.quote('skin')! as never, p.privateKey);
  return st.purchase({ itemId: 'skin', playerId: 'p' + i, playerAddress: sp.playerAddress,
                       authorization: sp.authorization, signature: sp.signature });
};

/* ================= 1. the player pays the sticker price ================= */
hdr('1. the player is debited exactly the price on the label');
{
  const st = store({ proceedsKey: STUDIO_KEY });
  const p = createPlayerWallet();
  const sp = signPurchase(st.quote('skin')! as never, p.privateKey);
  ok('the authorization is for the sticker price, with nothing added',
     sp.authorization.value === PRICE, sp.authorization.value);
  ok('...and it pays the studio, not the vault', sp.authorization.to.toLowerCase() === STUDIO.toLowerCase());
}

/* ================= 2. it is actually wired up ================= */
hdr('2. the fee is reached at all - the bug that shipped last time');
{
  const off = store();
  ok('with no key supplied, the fee is OFF and says so', off.fee.enabled === false);

  const on = store({ proceedsKey: STUDIO_KEY });
  ok('with a key, the fee is ON', on.fee.enabled === true);

  await buy(on, 1);
  const s = await on.fee.stats();
  ok('a settled sale is counted', s.salesSinceLastSweep === '1', JSON.stringify(s));
}

/* ================= 3. the key must be the payee's ================= */
hdr('3. the fee can only come out of the wallet that receives proceeds');
{
  let threw = '';
  try { store({ proceedsKey: '0x' + '3c'.repeat(32) }); }
  catch (e) { threw = e instanceof Error ? e.message : String(e); }
  ok('a key for some OTHER wallet is refused at construction',
     threw.includes('belongs to'), threw.slice(0, 80));
}

/* ================= 4. the hundredth sale sweeps ================= */
hdr('4. one settlement per hundred sales, not a hundred dust transfers');
{
  swept.length = 0;
  const st = store({ proceedsKey: STUDIO_KEY });
  for (let i = 0; i < 99; i++) await buy(st, i);
  ok('ninety-nine sales sweep nothing', swept.length === 0, `${swept.length} sweeps`);
  const before = await st.fee.stats();
  ok('...but they are all counted', before.salesSinceLastSweep === '99', before.salesSinceLastSweep);

  await buy(st, 99);
  ok('the hundredth sweeps once', swept.length === 1, `${swept.length} sweeps`);

  // 100 sales x $0.02 = $2.00 of volume. 0.1% = 2000 atomic. Plus the flat 10000.
  const expected = (BigInt(PRICE) * 100n * 1000n / 1_000_000n) + 10_000n;
  ok('...for the accrued percentage AND the flat charge together',
     swept[0]?.value === String(expected), `${swept[0]?.value} vs ${expected}`);
  ok('...out of the studio wallet', swept[0]?.from.toLowerCase() === STUDIO.toLowerCase());
  ok('...into the vault', swept[0]?.to.toLowerCase() === VAULT);

  const dsep = domainSep('USD Coin', '2', 8453, (CHAINS as any).base.asset);
  const rec = recoverSigner(digest(dsep, swept[0].auth), swept[0].sig);
  ok('...signed by the studio, verifiably', rec === STUDIO.toLowerCase(), rec ?? 'null');

  const after = await st.fee.stats();
  ok('the counter resets after the sweep', after.salesSinceLastSweep === '0', after.salesSinceLastSweep);
  ok('...and the collected total reflects it', after.collected === String(expected), after.collected);
}

/* ================= 5. a failed hand-off is held, not re-minted ================= */
hdr('5. a collector outage must not charge the studio twice');
{
  swept.length = 0;
  const st = store({ proceedsKey: STUDIO_KEY });
  collectorUp = false;
  for (let i = 0; i < 100; i++) await buy(st, i);
  ok('nothing was collected while the collector was down', swept.length === 0);
  const held = await st.fee.stats();
  ok('...the authorization is HELD, not lost', held.held !== '0', JSON.stringify(held));

  collectorUp = true;
  await buy(st, 100);
  ok('the next sale re-sends it', swept.length === 1, `${swept.length} sweeps`);
  const s2 = await st.fee.stats();
  ok('...and it is collected exactly once', s2.collected === swept[0].value && swept.length === 1,
     `collected ${s2.collected}, swept ${swept.length}`);
  ok('...and nothing was lost', s2.lost === '0', s2.lost);
}

/* ================= 6. the fee never breaks a sale ================= */
hdr('6. a fee problem must not undo a sale that already settled');
{
  swept.length = 0;
  collectorUp = false;
  const st = store({ proceedsKey: STUDIO_KEY });
  const r = await buy(st, 1);
  ok('the sale still settles when the collector is unreachable', 'transaction' in r,
     JSON.stringify(r).slice(0, 70));
  collectorUp = true;
}

globalThis.fetch = realFetch;
console.log('\nsummary\n' + '-'.repeat(7));
console.log(`  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
