# x402-trinity-gaming

**A headless, zero-UI payment utility for Unity and Unreal Engine storefronts.**

No UI. No overlay. No browser handoff. No console output. Your button, your art, your unlock
animation — this handles the money and gets out of the way.

```bash
npm install x402-trinity-gaming
```

## How it fits

```
Your storefront UI  ──▶  your backend  ──▶  chain
   (Unreal/Unity)         (this package)
        ▲                       │
        └────── events ─────────┘
```

The player's client signs one authorization with their own key. Your server does everything
else. **You never hold the player's key**, and for direct purchases you hold no balance
either. (Tabs are the exception - see `INTEGRATION.md`.)

## Use

```js
import { createStorefront } from 'x402-trinity-gaming/storefront';

const store = createStorefront({
  payTo: '0xYourStudioWallet',
  network: 'base',
  facilitator: 'https://your-facilitator.example',   // REQUIRED - no default
  nonceStore,                                        // REQUIRED - must survive restarts
  catalog: {
    vanguard_skin_01: '1500000',   // atomic units: 1.50 USDC (6 decimals)
    season_pass_04:  '9990000',    // 9.99
  },
});

store.on('settled',  e => grantItem(e.playerId, e.itemId));
store.on('declined', e => showRefusal(e.playerId, e.code));
```

Serve the quote, take the signature, redeem it:

```js
// 1. the client asks what it must sign
const quote = store.quote('vanguard_skin_01');

// 2. the client signs it and posts back { authorization, signature }
const result = await store.purchase({
  itemId: 'vanguard_skin_01',
  playerId: 'player-8823',
  playerAddress: '0xPlayerWallet',
  authorization,
  signature,
});
```

## Events

| event | when | what to do |
|---|---|---|
| `accepted` | the request is well formed, the item is real, settlement is underway | grant optimistically if you want the item to appear instantly |
| `settled` | the money has moved, with an on-chain transaction hash | grant, or reconcile an optimistic grant |
| `declined` | it was refused | read `code`, not `message` |

Decline codes are `unknown_item`, `already_used`, `rejected`, `settlement_failed` and
`malformed`. Each carries `retryable` — **true** means the same authorization may be presented
again unchanged, **false** means mint a fresh one. Re-sending when `retryable` is false risks
paying twice.

## Prices are strings

Atomic units of the asset, as a decimal string. USDC has 6 decimals, so `1.50` is
`'1500000'`. A float cannot represent money exactly, and this value goes inside a signature.

## Nothing is printed

This library never writes to `stdout` or `stderr` — that is enforced by its build, not by
convention. Diagnostics reach you through `onDiagnostic`.

## Scope

**Base mainnet + USDC.** Other EVM chains work by passing `customChains`. Check any entry
against the deployed contract first: call `DOMAIN_SEPARATOR()` and confirm it matches what
this library computes. A wrong `name` or `version` produces a signature that looks valid and
the contract rejects.

## Before you use it with real money

This software signs payment authorizations. You are responsible for the funds in any wallet
you configure it with and for the limits you set. `nonceStore` must be durable — an in-memory
replay guard forgets every settled payment on restart, which means selling the same item twice
for free.

## Building from source

```bash
git clone https://github.com/devmster/x402-trinity-gaming.git
cd x402-trinity-gaming
npm install
node tools/build.mjs
```

`npm install` first — the bundler is a dev dependency, and without it the build stops at
`ERR_MODULE_NOT_FOUND`. The build verifies itself and prints `BUILD VERIFIED`; the `dist/`
it produces is byte-identical to the published package.

## License

Business Source License 1.1. Source-available; converts to MIT on 2029-08-25. See
[LICENSE](LICENSE).

Network fee: 0.1% per transaction.
