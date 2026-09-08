# x402 Gaming — Unity

Headless payment bridge. No UI, no overlay, no checkout screen — your button, your art, your
unlock animation.

## Install

Package Manager → **Add package from git URL**:

```
https://github.com/devmster/x402-trinity-gaming.git?path=/unity
```

## Use

```csharp
var bridge = GetComponent<X402StorefrontBridge>();
bridge.serverUrl = "https://your-backend.example";
bridge.KeyProvider = () => UnlockPlayerKey();     // your encrypted store

bridge.OnTransactionSettled.AddListener(e => GrantItem(e.playerId, e.itemId));
bridge.OnPurchaseDeclined.AddListener(e => ShowRefusal(e.code));

bridge.Purchase("vanguard_skin_01", playerId);    // no price - your server's catalog decides
```

`X402Signer` produces the EIP-712 signature; everything that moves money runs on your server.

Requires **BouncyCastle.Crypto.dll** in your project — the curve math is not hand-rolled.

See [INTEGRATION.md](../INTEGRATION.md) for the full setup.

## License

Business Source License 1.1. Converts to MIT on 2029-08-25.
