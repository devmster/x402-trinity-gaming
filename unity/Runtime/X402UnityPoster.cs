// The Unity half of the fee's hand-off.
//
// Everything that decides WHAT is owed lives in X402PlayerFee, which carries no Unity
// dependency so it can be compiled and checked against the golden vectors outside the
// editor. This file is the only part that touches UnityWebRequest, and it decides nothing.

using System;
using System.Collections;
using System.Text;
using UnityEngine.Networking;

namespace X402.Gaming
{
    /// <summary>Posts the fee batch with UnityWebRequest. The runtime implementation.</summary>
    public class X402UnityPoster : IX402Poster
    {
        readonly int _timeoutSeconds;

        public X402UnityPoster(int timeoutSeconds = 20)
        {
            _timeoutSeconds = timeoutSeconds > 0 ? timeoutSeconds : 20;
        }

        public IEnumerator Post(string url, string body, Action<bool> done)
        {
            using (var req = new UnityWebRequest(url, "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = _timeoutSeconds;
                yield return req.SendWebRequest();

                bool ok = req.result == UnityWebRequest.Result.Success;
                if (ok)
                {
                    // Only an explicit success counts. A 200 carrying a failure is a failure,
                    // and treating it as collected would lose the fee silently.
                    var text = req.downloadHandler != null ? req.downloadHandler.text : null;
                    ok = text != null && text.Contains("\"success\":true");
                }
                if (done != null) done(ok);
            }
        }
    }
}
