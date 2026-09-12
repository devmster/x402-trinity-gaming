#include "X402StorefrontBridge.h"

#include "X402Signer.h"

#include "Dom/JsonObject.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace
{
    FString Str(const TSharedPtr<FJsonObject>& O, const TCHAR* Field)
    {
        FString Out;
        if (O.IsValid()) O->TryGetStringField(Field, Out);
        return Out;
    }

    bool Flag(const TSharedPtr<FJsonObject>& O, const TCHAR* Field)
    {
        bool Out = false;
        if (O.IsValid()) O->TryGetBoolField(Field, Out);
        return Out;
    }

    TSharedPtr<FJsonObject> Parse(const FString& Json)
    {
        TSharedPtr<FJsonObject> Object;
        const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Json);
        FJsonSerializer::Deserialize(Reader, Object);
        return Object;
    }
}

void UX402StorefrontBridge::Purchase(const FString& ItemId, const FString& PlayerId)
{
    if (!KeyProvider.IsBound())
    {
        Fail(TEXT("config"), TEXT("KeyProvider is not bound - the bridge has no way to unlock the player's key"));
        return;
    }

    // 1. request_quote
    Send(TEXT("GET"), FString::Printf(TEXT("/shop/quote/%s"), *FGenericPlatformHttp::UrlEncode(ItemId)), FString(),
        [this, ItemId, PlayerId](const FString& QuoteJson)
        {
            const TSharedPtr<FJsonObject> Q = Parse(QuoteJson);
            if (!Q.IsValid()) { Fail(TEXT("server"), TEXT("quote was not JSON")); return; }

            X402::FQuote Quote;
            Quote.Network       = TCHAR_TO_UTF8(*Str(Q, TEXT("network")));
            Quote.Amount        = TCHAR_TO_UTF8(*Str(Q, TEXT("amount")));
            Quote.PayTo         = TCHAR_TO_UTF8(*Str(Q, TEXT("payTo")));
            Quote.Asset         = TCHAR_TO_UTF8(*Str(Q, TEXT("asset")));
            const TSharedPtr<FJsonObject>* Extra = nullptr;
            if (Q->TryGetObjectField(TEXT("extra"), Extra) && Extra)
            {
                Quote.DomainName    = TCHAR_TO_UTF8(*Str(*Extra, TEXT("name")));
                Quote.DomainVersion = TCHAR_TO_UTF8(*Str(*Extra, TEXT("version")));
            }
            int32 Timeout = 600;
            Q->TryGetNumberField(TEXT("maxTimeoutSeconds"), Timeout);
            Quote.MaxTimeoutSeconds = Timeout;

            X402::FSignedPurchase Signed;
            try
            {
                Signed = X402::Sign(Quote, TCHAR_TO_UTF8(*KeyProvider.Execute()),
                                    FDateTime::UtcNow().ToUnixTimestamp());
            }
            catch (const std::exception& E)
            {
                Fail(TEXT("signing"), UTF8_TO_TCHAR(E.what()));
                return;
            }

            // The protocol fee, ON by default. Built here because the chain and asset are
            // only known once a quote arrives. It accrues locally, settles in a batch, and
            // never blocks or fails a purchase.
            if (!Fee.IsValid())
            {
                X402::FSurchargeConfig FeeConfig;
                FeeConfig.Every = SurchargeEvery > 0 ? SurchargeEvery : 100;
                Fee = MakeShared<X402::FPlayerFee>(
                    TCHAR_TO_UTF8(*KeyProvider.Execute()), Quote,
                    [](const std::string& Url, const std::string& Body, X402::FPostDone Done)
                    {
                        const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> R =
                            FHttpModule::Get().CreateRequest();
                        R->SetURL(UTF8_TO_TCHAR(Url.c_str()));
                        R->SetVerb(TEXT("POST"));
                        R->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
                        R->SetContentAsString(UTF8_TO_TCHAR(Body.c_str()));
                        R->OnProcessRequestComplete().BindLambda(
                            [Done](FHttpRequestPtr, FHttpResponsePtr Res, bool bOk)
                            {
                                // Only an explicit success counts. A 200 carrying a failure is
                                // a failure, and calling it collected would lose the fee.
                                const bool bGood = bOk && Res.IsValid()
                                    && Res->GetResponseCode() >= 200 && Res->GetResponseCode() < 300
                                    && Res->GetContentAsString().Contains(TEXT("\"success\":true"));
                                Done(bGood);
                            });
                        R->ProcessRequest();
                    },
                    FeeConfig);
            }

            // Optimistic: the signature is good and settlement is underway. Grant here if you
            // want the item to appear at once, and reconcile on settled.
            FX402PurchaseAccepted Accepted;
            Accepted.ItemId = ItemId;
            Accepted.PlayerId = PlayerId;
            Accepted.Amount = UTF8_TO_TCHAR(Signed.Authorization.Value.c_str());
            OnPurchaseAccepted.Broadcast(Accepted);

            // 2. submit_signature
            const TSharedRef<FJsonObject> Auth = MakeShared<FJsonObject>();
            Auth->SetStringField(TEXT("from"),        UTF8_TO_TCHAR(Signed.Authorization.From.c_str()));
            Auth->SetStringField(TEXT("to"),          UTF8_TO_TCHAR(Signed.Authorization.To.c_str()));
            Auth->SetStringField(TEXT("value"),       UTF8_TO_TCHAR(Signed.Authorization.Value.c_str()));
            Auth->SetStringField(TEXT("validAfter"),  UTF8_TO_TCHAR(Signed.Authorization.ValidAfter.c_str()));
            Auth->SetStringField(TEXT("validBefore"), UTF8_TO_TCHAR(Signed.Authorization.ValidBefore.c_str()));
            Auth->SetStringField(TEXT("nonce"),       UTF8_TO_TCHAR(Signed.Authorization.Nonce.c_str()));

            const TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
            Body->SetStringField(TEXT("itemId"), ItemId);
            Body->SetStringField(TEXT("playerId"), PlayerId);
            Body->SetStringField(TEXT("playerAddress"), UTF8_TO_TCHAR(Signed.PlayerAddress.c_str()));
            Body->SetObjectField(TEXT("authorization"), Auth);
            Body->SetStringField(TEXT("signature"), UTF8_TO_TCHAR(Signed.Signature.c_str()));

            FString Payload;
            const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Payload);
            FJsonSerializer::Serialize(Body, Writer);

            const std::string Amount = Signed.Authorization.Value;
            Send(TEXT("POST"), TEXT("/shop/buy"), Payload,
                [this, ItemId, PlayerId, Amount](const FString& Response)
                {
                    const TSharedPtr<FJsonObject> R = Parse(Response);
                    if (!R.IsValid()) { Fail(TEXT("server"), TEXT("response was not JSON")); return; }

                    // A settled purchase carries a transaction; a refusal carries a code.
                    if (R->HasField(TEXT("transaction")))
                    {
                        FX402PurchaseSettled S;
                        S.ItemId      = Str(R, TEXT("itemId"));
                        S.PlayerId    = Str(R, TEXT("playerId"));
                        S.Amount      = Str(R, TEXT("amount"));
                        S.Transaction = Str(R, TEXT("transaction"));
                        S.Network     = Str(R, TEXT("network"));
                        OnTransactionSettled.Broadcast(S);
                    }
                    else
                    {
                        FX402PurchaseDeclined D;
                        D.ItemId     = Str(R, TEXT("itemId"));
                        D.PlayerId   = Str(R, TEXT("playerId"));
                        D.Code       = Str(R, TEXT("code"));
                        D.Message    = Str(R, TEXT("message"));
                        D.bRetryable = Flag(R, TEXT("retryable"));
                        OnPurchaseDeclined.Broadcast(D);
                    }

                    if (Fee.IsValid() && Fee->IsEnabled())
                    {
                        Fee->Record(Amount, [](const std::string& Code, const std::string& Message)
                        {
                            UE_LOG(LogTemp, Verbose, TEXT("x402 fee %s: %s"),
                                   UTF8_TO_TCHAR(Code.c_str()), UTF8_TO_TCHAR(Message.c_str()));
                        });
                    }
                });
        });
}

void UX402StorefrontBridge::Spend(const FString& PlayerId, const FString& ActionId, const FString& AmountAtomic)
{
    const TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
    Body->SetStringField(TEXT("playerId"), PlayerId);
    Body->SetStringField(TEXT("actionId"), ActionId);
    Body->SetStringField(TEXT("amount"), AmountAtomic);

    FString Payload;
    const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Payload);
    FJsonSerializer::Serialize(Body, Writer);

    Send(TEXT("POST"), TEXT("/tab/spend"), Payload, [this](const FString& Response)
    {
        const TSharedPtr<FJsonObject> R = Parse(Response);
        if (!R.IsValid()) { Fail(TEXT("server"), TEXT("response was not JSON")); return; }

        FX402TabChanged T;
        T.PlayerId   = Str(R, TEXT("playerId"));
        T.ActionId   = Str(R, TEXT("actionId"));
        T.Charged    = Str(R, TEXT("charged"));
        T.Remaining  = Str(R, TEXT("remaining"));
        T.bDuplicate = Flag(R, TEXT("duplicate"));
        OnTabChanged.Broadcast(T);
    });
}

void UX402StorefrontBridge::RefreshTab(const FString& PlayerId)
{
    Send(TEXT("GET"), FString::Printf(TEXT("/tab/balance/%s"), *FGenericPlatformHttp::UrlEncode(PlayerId)),
         FString(), [this, PlayerId](const FString& Response)
    {
        const TSharedPtr<FJsonObject> R = Parse(Response);
        if (!R.IsValid()) { Fail(TEXT("server"), TEXT("response was not JSON")); return; }

        FX402TabChanged T;
        T.PlayerId  = PlayerId;
        T.Remaining = Str(R, TEXT("remaining"));
        OnTabChanged.Broadcast(T);
    });
}

void UX402StorefrontBridge::Send(const FString& Verb, const FString& Path, const FString& Body,
                                 TFunction<void(const FString&)> OnOk)
{
    const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(ServerUrl.TrimEnd() / Path.Mid(1));
    Request->SetVerb(Verb);
    Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    if (!SessionToken.IsEmpty())
        Request->SetHeader(TEXT("Authorization"), FString::Printf(TEXT("Bearer %s"), *SessionToken));
    if (!Body.IsEmpty()) Request->SetContentAsString(Body);
    Request->SetTimeout(TimeoutSeconds);

    Request->OnProcessRequestComplete().BindLambda(
        [this, OnOk](FHttpRequestPtr Req, FHttpResponsePtr Res, bool bOk)
        {
            if (!bOk || !Res.IsValid())
            {
                Fail(TEXT("network"), TEXT("the request did not complete"));
                return;
            }
            const int32 Status = Res->GetResponseCode();
            if (Status < 200 || Status >= 300)
            {
                Fail(TEXT("server"), FString::Printf(TEXT("HTTP %d"), Status));
                return;
            }
            OnOk(Res->GetContentAsString());
        });

    Request->ProcessRequest();
}

void UX402StorefrontBridge::Fail(const FString& Code, const FString& Message)
{
    FX402Error E;
    E.Code = Code;
    E.Message = Message;
    OnError.Broadcast(E);
}
