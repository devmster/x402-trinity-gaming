# ⚡ 402-Trinity-Gaming — Integration Brief

**A white-label microtransaction engine for game storefronts. The player holds their own wallet.**

Players buy cosmetics, battle passes and timer skips without ever leaving your game. No
overlay, no browser tab, no checkout screen wearing someone else's brand. Your button, your
art, your unlock animation.

---

## 🛠️ Step 1 — Studio setup (done once)

**Install** into your existing game backend:

```bash
npm install 402-trinity-gaming
```

**Configure** your catalog and your treasury:

```js
const store = createStorefront({
  payTo: '0xYourStudioTreasury',
  network: 'base',
  facilitator: 'https://...',
  nonceStore,
  catalog: {
    vanguard_skin_01: '1500000',   // $1.50
    season_pass_04:   '9990000',   // $9.99
  },
  surcharge: { proceedsKey },
});
```

**Hook up your UI.** Your artists design the store exactly how they want. When a player taps
*Purchase*, your button calls your server, and two events come back — one when the purchase is
accepted, one when the money has moved:

```js
store.on('settled',  e => grantItem(e.playerId, e.itemId));
store.on('declined', e => showRefusal(e.playerId, e.code));
```

That is the whole integration surface. Nothing renders, nothing takes over input, and nothing
writes to your console — the build fails if it does.

> Prices live in your server's catalog, never in the client call. A client that names its own
> price is a client that sets its own price.

---

## 🕹️ Step 2 — Player wallet (done once per player)

When a player creates an account, your client generates a wallet on their device.

```js
const { privateKey, address } = createPlayerWallet();
```

You store the address. **They** keep the key — you never hold it, and you cannot spend from
their wallet. The player is the real buyer, paying you directly.

> **If you use tabs** (see below), note that a partly-spent tab *is* a balance you hold: the
> player's cash is yours, and what they have left is credit in your game. That is closed-loop
> — spendable only on your items, never withdrawable — so it is the same shape as any in-game
> currency, not a deposit account. Worth raising with your counsel all the same.

> **Yours to build today:** the encryption, unlock and backup flow. We hand you the key; where
> it sleeps is your product decision. There is no password reset — give players a recovery
> phrase or an encrypted backup at setup.

---

## 💳 Step 3 — Funding the wallet

It is an ordinary Base address, so there are two doors and you can open either.

**Players who hold crypto** send USDC straight to it from any exchange or wallet.

**Everyone else** goes through a card on-ramp you drop into your launcher or account page.
They pay with a card, USDC lands in their wallet.

---

## ⚔️ Step 4 — The checkout loop

A player taps *Buy* on a $5.00 weapon skin, mid-lobby.

**On their machine**, the client signs one authorization — about **3 milliseconds**,
comfortably inside a frame, touching no network. Only the signature leaves the device.

**On your server**, that signature is verified and settled through your facilitator.

**Back in the game**, `accepted` fires the moment the signature checks out, and `settled` when
the transfer confirms on Base a few seconds later.

**Design this bit deliberately.** Settlement is a real transfer on a real chain — seconds, not
milliseconds. Want the skin to appear the instant they tap? Grant on `accepted` and reconcile
on `settled`. Rather never take something back? Wait for `settled`. One line either way.

**The player is debited exactly $5.00.** The price on the label is the price they pay.

---

## 🔁 Tabs — for games that charge constantly

Survival, MMO and sandbox economies bill in fractions of a cent: a timer skip, a stack of ore,
a repair. Settling each one on-chain costs more in gas than the action costs the player.

So the player **loads a tab** — one signature, one transfer — and every action after that is a
deduction from that credit. No signature, no chain, no gas, nothing to wait for.

```js
const tabs = createBatchManager({
  ...sameConfigAsAbove,
  tabs: { session: '2000000' },   // $2.00 of credit
  ledger,                         // durable - see below
});

await tabs.open({ tabId: 'session', playerId, playerAddress, authorization, signature });

// then, on any gameplay path:
await tabs.spend({ playerId, actionId: 'skip:furnace:8412', amount: '20000' });
```

**Why it is worth doing:** a hundred separate $0.02 payments cost roughly $0.13 in gas. One
$2.00 tab costs about $0.0013. Same money to you.

**`actionId` makes spending idempotent.** A client that retries after a dropped connection is
charged once; the second call reports `duplicate: true` so you still grant the item.

**Your ledger must be durable.** In memory, every player's remaining credit dies with the
process — they paid for something your server no longer remembers. Use the file store for a
single instance, or your own database adapter for more than one:

```js
import { createFileLedgerStore } from '402-trinity-gaming/budget-file';
const ledger = createFileLedgerStore('./tabs.json');
```

**If you run more than one game server**, implement `ledger.update()` and hold a row lock
across the read and the write. Without it, two servers can read the same balance and both
approve a spend it could only cover once.

**A tab is a balance you hold.** The player's cash is yours the moment the tab opens; what
they have left is credit in your game.

**Giving it back:**

```js
await tabs.refund({ playerId });                    // everything unspent
await tabs.refund({ playerId, amount: '500000' });  // or part of it
```

Your treasury signs, the facilitator submits, the USDC lands back in the player's wallet — you
need no gas. The credit is deducted before the transfer is attempted, so it cannot be spent
while the refund is in flight, and it is **put back if the transfer fails**. Requires
`surcharge.proceedsKey`, since that is the key for the wallet holding the money.

The 0.1% taken when the tab opened is not reversed — it was charged on a sale that happened.

---

## 🧾 When something is refused

Every refusal comes back with a code you can switch on — item not for sale, bad signature,
authorization already spent, or settlement failed on the server's side.

Each also carries **`retryable`**, and it is the field that stops you charging a player twice.
When settlement fails on our side the payment was valid, so the *same* authorization must go
out again — minting a fresh one risks paying twice if the first lands late. When a signature
is rejected or already spent, it will never work. We make that call so your code doesn't have
to.

---

## 📦 What you get today

**Available now:** the TypeScript backend library and client signer. Base mainnet, USDC.

**Coming:** native Unity (C#) and Unreal (C++) packages — the signer is a single function and
porting it is next. Key encryption and the card on-ramp are yours for now.

---

Business Source License 1.1. Source-available; converts to MIT on 2029-08-25.

Merchant proceeds are settled net of a 0.1% network fee.
