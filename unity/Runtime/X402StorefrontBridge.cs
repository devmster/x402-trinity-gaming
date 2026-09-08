// THE BRIDGE.
//
// Transport and events, nothing else. It asks your server what a thing costs, signs, hands the
// signature back, and raises a UnityEvent with whatever your server returned. It renders
// nothing, owns no UI, and makes no decision about money.
//
// WHAT LIVES ON THE SERVER, DELIBERATELY:
//   - the price of everything             (a client that names a price sets it)
//   - purchase(), openTab(), refund()     (they move money)
//   - the tab balance                     (a balance a client can edit is a balance a player edits)
//
// This class calls the server's spend endpoint and reports what came back. It never does the
// arithmetic itself - the number you render is the server's number, not a local guess.
//
// Drop this on a GameObject, point it at your backend, and wire the events in the Inspector.

using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.Networking;

namespace X402.Gaming
{
    [Serializable] public class PurchaseAcceptedEvent : UnityEvent<PurchaseAccepted> { }
    [Serializable] public class PurchaseSettledEvent  : UnityEvent<PurchaseSettled> { }
    [Serializable] public class PurchaseDeclinedEvent : UnityEvent<PurchaseDeclined> { }
    [Serializable] public class TabChangedEvent       : UnityEvent<TabChanged> { }
    [Serializable] public class BridgeErrorEvent      : UnityEvent<BridgeError> { }

    [Serializable]
    public class PurchaseAccepted { public string itemId; public string playerId; public string amount; }

    [Serializable]
    public class PurchaseSettled
    {
        public string itemId; public string playerId; public string amount;
        public string transaction; public string network;
    }

    [Serializable]
    public class PurchaseDeclined
    {
        public string itemId; public string playerId;
        /// <summary>unknown_item | already_used | rejected | settlement_failed | malformed</summary>
        public string code;
        public string message;
        /// <summary>
        /// True means present the SAME authorization again, unchanged. False means start over
        /// with a fresh quote - re-sending would risk paying twice.
        /// </summary>
        public bool retryable;
    }

    [Serializable]
    public class TabChanged
    {
        public string playerId; public string actionId;
        public string charged; public string remaining;
        /// <summary>The action was already charged; grant it, but do not bill again.</summary>
        public bool duplicate;
    }

    [Serializable]
    public class BridgeError
    {
        /// <summary>network | server | signing | config</summary>
        public string code;
        public string message;
    }

    [AddComponentMenu("x402/Storefront Bridge")]
    public class X402StorefrontBridge : MonoBehaviour
    {
        [Header("Your backend")]
        [Tooltip("Base URL of YOUR server. It holds the catalog and does everything that moves money.")]
        public string serverUrl = "https://your-backend.example";

        [Tooltip("Sent as Authorization on every call. Use your existing session token.")]
        public string sessionToken = "";

        [Tooltip("Seconds before a request is abandoned.")]
        public int timeoutSeconds = 20;

        [Header("Events")]
        public PurchaseAcceptedEvent OnPurchaseAccepted = new PurchaseAcceptedEvent();
        public PurchaseSettledEvent  OnTransactionSettled = new PurchaseSettledEvent();
        public PurchaseDeclinedEvent OnPurchaseDeclined = new PurchaseDeclinedEvent();
        public TabChangedEvent       OnTabChanged = new TabChangedEvent();
        public BridgeErrorEvent      OnError = new BridgeErrorEvent();

        /// <summary>
        /// Supplies the player's key for the one moment it is needed. Set this to a function
        /// that unlocks your encrypted store; leave the key nowhere else.
        /// </summary>
        public Func<string> KeyProvider;

        // ---------------- cosmetics ----------------

        /// <summary>
        /// Buy an item. Ask the server what it costs, sign it, hand the signature back.
        ///
        /// The price is never passed from here - your server's catalog decides it.
        /// </summary>
        public void Purchase(string itemId, string playerId)
        {
            StartCoroutine(PurchaseRoutine(itemId, playerId));
        }

        IEnumerator PurchaseRoutine(string itemId, string playerId)
        {
            if (KeyProvider == null)
            {
                Fail("config", "KeyProvider is not set - the bridge has no way to unlock the player's key");
                yield break;
            }

            // 1. request_quote
            string quoteJson = null;
            yield return Send("GET", "/shop/quote/" + UnityWebRequest.EscapeURL(itemId), null,
                              r => quoteJson = r, e => Fail("server", e));
            if (quoteJson == null) yield break;

            X402SignedPurchase signed;
            try
            {
                var quote = JsonUtility.FromJson<X402Quote>(quoteJson);
                signed = X402Signer.Sign(quote, KeyProvider());
            }
            catch (Exception ex) { Fail("signing", ex.Message); yield break; }

            // 2. submit_signature
            var body = "{\"itemId\":" + Q(itemId) +
                       ",\"playerId\":" + Q(playerId) +
                       ",\"playerAddress\":" + Q(signed.playerAddress) +
                       ",\"authorization\":" + JsonUtility.ToJson(signed.authorization) +
                       ",\"signature\":" + Q(signed.signature) + "}";

            OnPurchaseAccepted.Invoke(new PurchaseAccepted { itemId = itemId, playerId = playerId });

            string resp = null;
            yield return Send("POST", "/shop/buy", body, r => resp = r, e => Fail("server", e));
            if (resp == null) yield break;

            // The server's shape decides which event fires - a declined result carries a code.
            if (resp.Contains("\"transaction\""))
                OnTransactionSettled.Invoke(JsonUtility.FromJson<PurchaseSettled>(resp));
            else
                OnPurchaseDeclined.Invoke(JsonUtility.FromJson<PurchaseDeclined>(resp));
        }

        // ---------------- tabs ----------------

        /// <summary>
        /// Charge a micro-action against the player's tab.
        ///
        /// This does NOT deduct locally. It asks the server, and the balance you render is the
        /// one the server returns - otherwise a player edits their own credit.
        ///
        /// `actionId` must be stable for the same action so a retry after a dropped connection
        /// is not charged twice.
        /// </summary>
        public void Spend(string playerId, string actionId, string amountAtomic)
        {
            StartCoroutine(SpendRoutine(playerId, actionId, amountAtomic));
        }

        IEnumerator SpendRoutine(string playerId, string actionId, string amount)
        {
            var body = "{\"playerId\":" + Q(playerId) +
                       ",\"actionId\":" + Q(actionId) +
                       ",\"amount\":" + Q(amount) + "}";
            string resp = null;
            yield return Send("POST", "/tab/spend", body, r => resp = r, e => Fail("server", e));
            if (resp == null) yield break;
            OnTabChanged.Invoke(JsonUtility.FromJson<TabChanged>(resp));
        }

        /// <summary>Read the player's remaining credit from the server.</summary>
        public void RefreshTab(string playerId)
        {
            StartCoroutine(RefreshRoutine(playerId));
        }

        IEnumerator RefreshRoutine(string playerId)
        {
            string resp = null;
            yield return Send("GET", "/tab/balance/" + UnityWebRequest.EscapeURL(playerId), null,
                              r => resp = r, e => Fail("server", e));
            if (resp == null) yield break;
            OnTabChanged.Invoke(JsonUtility.FromJson<TabChanged>(resp));
        }

        // ---------------- transport ----------------

        IEnumerator Send(string method, string path, string body, Action<string> ok, Action<string> err)
        {
            using (var req = new UnityWebRequest(serverUrl.TrimEnd('/') + path, method))
            {
                if (body != null)
                    req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                if (!string.IsNullOrEmpty(sessionToken))
                    req.SetRequestHeader("Authorization", "Bearer " + sessionToken);
                req.timeout = timeoutSeconds;

                yield return req.SendWebRequest();

#if UNITY_2020_1_OR_NEWER
                bool failed = req.result != UnityWebRequest.Result.Success;
#else
                bool failed = req.isNetworkError || req.isHttpError;
#endif
                if (failed) err(req.error + " (" + req.responseCode + ")");
                else ok(req.downloadHandler.text);
            }
        }

        void Fail(string code, string message)
        {
            OnError.Invoke(new BridgeError { code = code, message = message });
        }

        static string Q(string s)
        {
            return "\"" + (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }
    }
}
