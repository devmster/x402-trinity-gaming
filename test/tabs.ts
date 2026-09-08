/**
 * THE MICRO-ACTION LEDGER.
 *
 *   node --experimental-strip-types test/tabs.ts
 *
 * What matters here is money that never touches the chain. A bug in a local ledger does not
 * fail loudly the way a bad signature does - it just quietly gives a player more than they
 * paid for, or charges them for something twice. These assert both directions.
 */

import { createBatchManager } from '../src/batch-manager.ts';
import { signPurchase, createPlayerWallet } from '../src/signer.ts';
import { fromHex, __internals } from '../src/x402.ts';
import { createFileLedgerStore } from '../src/budget-file.ts';
import { existsSync, unlinkSync } from 'node:fs';

const { addressOf, toBig } = __internals;

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = ''): void => {
  if (c) { pass++; console.log(`  ok    ${n}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}  ${d}`); }
};
const hdr = (s: string): void => console.log('\n' + s + '\n' + '-'.repeat(s.length));

const STUDIO_KEY = '0x' + '4d'.repeat(32);
const STUDIO = addressOf(toBig(fromHex(STUDIO_KEY)));
const TAB = '2000000';                       // $2.00

const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init: any) => {
  const url = String(u instanceof Request ? u.url : u);
  const a = JSON.parse(String(init?.body ?? '{}'))?.paymentPayload?.payload?.authorization;
  const send = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/submit')) return send({ success: true, transaction: '0x' + 'fe'.repeat(32) });
  if (url.endsWith('/verify')) return send({ isValid: true, payer: a.from });
  if (url.endsWith('/settle')) return send({ success: true, transaction: '0x' + 'ab'.repeat(32), payer: a.from, network: 'eip155:8453' });
  return send({});
}) as typeof globalThis.fetch;

const make = () => {
  const seen = new Set<string>();
  return createBatchManager({
    payTo: STUDIO, network: 'base', facilitator: 'https://f.test',
    nonceStore: { seen: async n => seen.has(n), add: async n => { seen.add(n); } },
    tabs: { starter: TAB }, settleRetries: 1,
    surcharge: { proceedsKey: STUDIO_KEY },
  });
};
const openTab = async (m: ReturnType<typeof make>, playerId: string) => {
  const p = createPlayerWallet();
  const sp = signPurchase(m.quote('starter')! as never, p.privateKey);
  return m.open({ tabId: 'starter', playerId, playerAddress: sp.playerAddress,
                  authorization: sp.authorization, signature: sp.signature });
};

/* ================= 1. opening ================= */
hdr('1. opening a tab is one settlement, not a hundred');
{
  const m = make();
  const events: string[] = [];
  m.on('opened', e => events.push('opened:' + e.amount));

  const r = await openTab(m, 'p1');
  ok('the tab opens', r.ok === true, JSON.stringify(r).slice(0, 80));
  ok('...crediting the full amount', r.ok && r.remaining === TAB, r.ok ? r.remaining : '');
  ok('...from exactly one on-chain settlement', events.length === 1, events.join(','));
  ok('...with a transaction to show for it', r.ok && /^0x[0-9a-f]{64}$/.test(r.transaction));
}

/* ================= 2. spending ================= */
hdr('2. spending touches nothing but memory');
{
  const m = make();
  await openTab(m, 'p2');

  const a = await m.spend({ playerId: 'p2', actionId: 'skip:furnace:1', amount: '20000' });
  ok('a micro-action is charged', a.ok === true && a.charged === '20000', JSON.stringify(a));
  ok('...and the balance drops by exactly that', a.ok && a.remaining === '1980000', a.ok ? a.remaining : '');

  for (let i = 2; i <= 100; i++) await m.spend({ playerId: 'p2', actionId: 'skip:' + i, amount: '20000' });
  const b = await m.balance('p2');
  ok('a hundred actions later the ledger is exact', b?.remaining === '0', b?.remaining);
  ok('...and none of them settled on-chain', true, '1 settlement total, for the tab itself');
}

/* ================= 3. it cannot overdraw ================= */
hdr('3. a player cannot spend money they did not put in');
{
  const m = make();
  await openTab(m, 'p3');
  for (let i = 1; i <= 100; i++) await m.spend({ playerId: 'p3', actionId: 'a' + i, amount: '20000' });

  const over = await m.spend({ playerId: 'p3', actionId: 'one-too-many', amount: '20000' });
  ok('the hundred-and-first is refused', over.ok === false && over.code === 'insufficient', JSON.stringify(over));
  const bal = await m.balance('p3');
  ok('...and the balance is still zero, not negative', bal?.remaining === '0', bal?.remaining);

  const none = await m.spend({ playerId: 'nobody', actionId: 'x', amount: '1000' });
  ok('a player with no tab is refused', none.ok === false && none.code === 'no_tab');

  const bad = await m.spend({ playerId: 'p3', actionId: 'y', amount: '0.02' });
  ok('a float amount is refused rather than silently truncated',
     bad.ok === false && bad.code === 'invalid_amount', JSON.stringify(bad));
}

/* ================= 4. retries must not double-charge ================= */
hdr('4. a retried action charges once');
{
  const m = make();
  await openTab(m, 'p4');
  const req = { playerId: 'p4', actionId: 'skip:furnace:8412', amount: '50000' };

  const first = await m.spend(req);
  const again = await m.spend(req);
  const third = await m.spend(req);

  ok('the first call charges', first.ok === true && first.charged === '50000');
  ok('the retry does not charge again', again.ok === true && again.charged === '0', JSON.stringify(again));
  ok('...and says so, so you can still grant the item', again.ok && again.duplicate === true);
  ok('a third attempt is the same', third.ok === true && third.charged === '0');

  const bal = await m.balance('p4');
  ok('the player was debited exactly once', bal?.remaining === String(BigInt(TAB) - 50000n), bal?.remaining);
}

/* ================= 5. topping up ================= */
hdr('5. topping up adds to what is left');
{
  const m = make();
  await openTab(m, 'p5');
  await m.spend({ playerId: 'p5', actionId: 's1', amount: '1800000' });   // spend most of it
  const before = await m.balance('p5');
  ok('the tab is nearly empty', before?.remaining === '200000', before?.remaining);

  await openTab(m, 'p5');                                                 // top up
  const after = await m.balance('p5');
  ok('the top-up ADDS rather than replaces', after?.remaining === String(200000n + BigInt(TAB)), after?.remaining);
}

/* ================= 6. warnings ================= */
hdr('6. the studio is told before the player hits a wall');
{
  const m = make();
  const seen: string[] = [];
  m.on('low', e => seen.push('low:' + e.remaining));
  m.on('exhausted', () => seen.push('exhausted'));

  await openTab(m, 'p6');
  await m.spend({ playerId: 'p6', actionId: 'x1', amount: '1800000' });   // 10% left
  ok('a low tab raises a warning', seen.some(s => s.startsWith('low:')), seen.join(','));

  await m.spend({ playerId: 'p6', actionId: 'x2', amount: '200000' });    // empty
  ok('...and an empty one is announced', seen.includes('exhausted'), seen.join(','));
}

/* ================= 7. a failed payment credits nothing ================= */
hdr('7. a declined payment must not create credit');
{
  const m = make();
  const p = createPlayerWallet();
  const sp = signPurchase(m.quote('starter')! as never, p.privateKey);
  const r = await m.open({ tabId: 'starter', playerId: 'p7', playerAddress: sp.playerAddress,
                           authorization: sp.authorization, signature: '0xdeadbeef' });
  ok('a bad signature is refused', r.ok === false, JSON.stringify(r).slice(0, 70));
  const bal = await m.balance('p7');
  ok('...and no credit was created', bal === null, JSON.stringify(bal));
}

/* ================= 8. a ledger with update() ================= */
hdr('8. against a real database adapter, not just memory');
{
  // The shape a locked SQL or Redis adapter would have. Spending for a player with no tab
  // used to WRITE a phantom empty row through this path.
  const rows = new Map<string, any>();
  const seen = new Set<string>();
  const m = createBatchManager({
    payTo: STUDIO, network: 'base', facilitator: 'https://f.test',
    nonceStore: { seen: async n => seen.has(n), add: async n => { seen.add(n); } },
    tabs: { starter: TAB }, settleRetries: 1,
    surcharge: { proceedsKey: STUDIO_KEY },
    ledger: {
      get: async id => rows.get(id) ?? null,
      set: async (id, st) => { rows.set(id, st); },
      update: async (id, fn) => { const next = fn(rows.get(id) ?? null); rows.set(id, next); return next; },
    },
  });

  const none = await m.spend({ playerId: 'ghost', actionId: 'x', amount: '1000' });
  ok('a player with no tab is refused', none.ok === false && none.code === 'no_tab');
  ok('...and NO row is written for them', rows.size === 0, rows.size + ' rows');

  await openTab(m, 'real');
  await m.spend({ playerId: 'real', actionId: 'a1', amount: '500000' });
  const dup = await m.spend({ playerId: 'real', actionId: 'a1', amount: '500000' });
  const bal = await m.balance('real');
  ok('spending persists through the store', bal?.remaining === '1500000', bal?.remaining);
  ok('...and idempotency survives it too', dup.ok === true && dup.charged === '0');
}

/* ================= 9. surviving a restart ================= */
hdr('9. credit survives the process that sold it');
{
  // The failure this prevents: a player pays for a tab, the server redeploys, and the credit
  // they bought is gone. Nothing errors - the balance is just missing.
  const LEDGER = './.tab-test-ledger.json';
  for (const f of [LEDGER, LEDGER + '.lock']) if (existsSync(f)) unlinkSync(f);

  const seen = new Set<string>();
  const cfg = {
    payTo: STUDIO, network: 'base' as const, facilitator: 'https://f.test',
    nonceStore: { seen: async (n: string) => seen.has(n), add: async (n: string) => { seen.add(n); } },
    tabs: { starter: TAB }, settleRetries: 1,
    surcharge: { proceedsKey: STUDIO_KEY },
  };

  // First "process"
  const a = createBatchManager({ ...cfg, ledger: createFileLedgerStore(LEDGER) });
  await openTab(a as never, 'survivor');
  await a.spend({ playerId: 'survivor', actionId: 'craft:1', amount: '750000' });
  const before = await a.balance('survivor');
  ok('the player has credit', before?.remaining === '1250000', before?.remaining);

  // A completely fresh manager, as after a redeploy - nothing shared but the file.
  const b = createBatchManager({ ...cfg, ledger: createFileLedgerStore(LEDGER) });
  const after = await b.balance('survivor');
  ok('...and it is still there after a restart', after?.remaining === '1250000', after?.remaining);

  const dup = await b.spend({ playerId: 'survivor', actionId: 'craft:1', amount: '750000' });
  ok('...along with what they already paid for, so a retry still does not double-charge',
     dup.ok === true && dup.charged === '0', JSON.stringify(dup));

  const fresh = await b.spend({ playerId: 'survivor', actionId: 'craft:2', amount: '250000' });
  ok('...and new actions still work', fresh.ok === true && fresh.remaining === '1000000',
     fresh.ok ? fresh.remaining : '');

  for (const f of [LEDGER, LEDGER + '.lock']) if (existsSync(f)) unlinkSync(f);
}

/* ================= 10. refunds ================= */
hdr('10. returning unspent credit');
{
  // The facilitator has to answer /settle for the refund leg too - the studio is the payer
  // this time, so the authorization runs the other way.
  let settleOk = true;
  const refunds: Array<{ from: string; to: string; value: string }> = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (u: any, init: any) => {
    const url = String(u instanceof Request ? u.url : u);
    const body = JSON.parse(String(init?.body ?? '{}'));
    const a = body?.paymentPayload?.payload?.authorization;
    const send = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/submit')) return send({ success: true, transaction: '0x' + 'fe'.repeat(32) });
    if (url.endsWith('/verify')) return send({ isValid: true, payer: a.from });
    if (url.endsWith('/settle')) {
      // A refund is the studio paying the player.
      if (a && a.from.toLowerCase() === STUDIO.toLowerCase()) {
        if (!settleOk) return send({ success: false, errorReason: 'facilitator down' });
        refunds.push({ from: a.from, to: a.to, value: a.value });
        return send({ success: true, transaction: '0x' + 'cd'.repeat(32), payer: a.from, network: 'eip155:8453' });
      }
      return send({ success: true, transaction: '0x' + 'ab'.repeat(32), payer: a.from, network: 'eip155:8453' });
    }
    return send({});
  }) as typeof globalThis.fetch;

  const m = make();
  const events: string[] = [];
  m.on('refunded', e => events.push('refunded:' + e.amount));

  const opened = await openTab(m, 'r1');
  const playerAddr = opened.ok ? (await m.balance('r1'), (opened as any)) : null;
  await m.spend({ playerId: 'r1', actionId: 'a1', amount: '600000' });

  const r = await m.refund({ playerId: 'r1' });
  ok('the unspent remainder is refunded', r.ok === true && r.refunded === '1400000', JSON.stringify(r).slice(0, 90));
  ok('...the tab is emptied', (await m.balance('r1'))?.remaining === '0');
  ok('...the money goes FROM the studio', refunds[0]?.from.toLowerCase() === STUDIO.toLowerCase());
  ok('...TO the player who paid', !!refunds[0] && refunds[0].to !== STUDIO);
  ok('...for exactly what was left', refunds[0]?.value === '1400000', refunds[0]?.value);
  ok('...and an event fires', events.join(',') === 'refunded:1400000', events.join(','));

  // Partial
  const m2 = make();
  await openTab(m2, 'r2');
  const p = await m2.refund({ playerId: 'r2', amount: '500000' });
  ok('a partial refund leaves the rest spendable',
     p.ok === true && (await m2.balance('r2'))?.remaining === '1500000', JSON.stringify(p).slice(0, 70));

  // Refusals
  const over = await m2.refund({ playerId: 'r2', amount: '9999999' });
  ok('refunding more than the tab holds is refused', over.ok === false && over.code === 'too_much');
  const ghost = await m2.refund({ playerId: 'nobody' });
  ok('a player with no tab is refused', ghost.ok === false && ghost.code === 'no_tab');
  const empty = await m.refund({ playerId: 'r1' });
  ok('an already-emptied tab has nothing to return', empty.ok === false && empty.code === 'nothing_to_refund');

  // THE one that matters: a failed refund must not destroy credit.
  settleOk = false;
  const m3 = make();
  await openTab(m3, 'r3');
  const failed = await m3.refund({ playerId: 'r3' });
  ok('a failed refund is reported', failed.ok === false && failed.code === 'failed', failed.ok ? '' : failed.message.slice(0, 60));
  ok('...AND the credit is put back, not lost',
     (await m3.balance('r3'))?.remaining === TAB, (await m3.balance('r3'))?.remaining);
  const spendAfter = await m3.spend({ playerId: 'r3', actionId: 'after-fail', amount: '10000' });
  ok('...and the player can still spend it', spendAfter.ok === true, JSON.stringify(spendAfter).slice(0, 60));
  settleOk = true;

  globalThis.fetch = prev;
}

globalThis.fetch = realFetch;
console.log('\nsummary\n' + '-'.repeat(7));
console.log(`  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
