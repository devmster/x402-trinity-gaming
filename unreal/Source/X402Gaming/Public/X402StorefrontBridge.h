// THE BRIDGE.
//
// Transport and delegates, nothing else. It asks the studio's server what a thing costs,
// signs it, hands the signature back, and broadcasts whatever the server returned. It draws
// nothing, owns no widget, and makes no decision about money.
//
// WHAT LIVES ON THE SERVER, DELIBERATELY:
//   - the price of everything             (a client that names a price sets it)
//   - Purchase, OpenTab, Refund           (they move money)
//   - the tab balance                     (a balance a client can edit is a balance a player edits)
//
// Spend() asks the server and broadcasts what came back. It never does the arithmetic itself,
// so the number a widget renders is the server's number, not a local guess.
//
// A GameInstanceSubsystem rather than an Actor: it outlives level transitions, which a
// purchase in flight needs.

#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "X402StorefrontBridge.generated.h"

USTRUCT(BlueprintType)
struct FX402PurchaseAccepted
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category = "x402") FString ItemId;
    UPROPERTY(BlueprintReadOnly, Category = "x402") FString PlayerId;
    /** Atomic units of the asset as a string - NOT a float. 1.50 USDC is "1500000". */
    UPROPERTY(BlueprintReadOnly, Category = "x402") FString Amount;
};

USTRUCT(BlueprintType)
struct FX402PurchaseSettled
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category = "x402") FString ItemId;
    UPROPERTY(BlueprintReadOnly, Category = "x402") FString PlayerId;
    UPROPERTY(BlueprintReadOnly, Category = "x402") FString Amount;
    /** On-chain transaction hash. The money has moved. */
    UPROPERTY(BlueprintReadOnly, Category = "x402") FString Transaction;
    UPROPERTY(BlueprintReadOnly, Category = "x402") FString Network;
};

USTRUCT(BlueprintType)
struct FX402PurchaseDeclined
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category = "x402") FString ItemId;
    UPROPERTY(BlueprintReadOnly, Category = "x402") FString PlayerId;
    /** unknown_item | already_used | rejected | settlement_failed | malformed. Switch on this. */
    UPROPERTY(BlueprintReadOnly, Category = "x402") FString Code;
    /** Detail for your logs. Never shown to a player by us. */
    UPROPERTY(BlueprintReadOnly, Category = "x402") FString Message;
    /**
     * True means present the SAME authorization again, unchanged - the payment was valid and
     * the nonce was never redeemed. False means start over with a fresh quote; re-sending
     * would risk paying twice.
     */
    UPROPERTY(BlueprintReadOnly, Category = "x402") bool bRetryable = false;
};

USTRUCT(BlueprintType)
struct FX402TabChanged
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category = "x402") FString PlayerId;
    UPROPERTY(BlueprintReadOnly, Category = "x402") FString ActionId;
    UPROPERTY(BlueprintReadOnly, Category = "x402") FString Charged;
    UPROPERTY(BlueprintReadOnly, Category = "x402") FString Remaining;
    /** Already charged earlier. Grant the action, but do not bill for it again. */
    UPROPERTY(BlueprintReadOnly, Category = "x402") bool bDuplicate = false;
};

USTRUCT(BlueprintType)
struct FX402Error
{
    GENERATED_BODY()

    /** network | server | signing | config */
    UPROPERTY(BlueprintReadOnly, Category = "x402") FString Code;
    UPROPERTY(BlueprintReadOnly, Category = "x402") FString Message;
};

// Dynamic multicast so designers can bind these in Blueprint without touching C++.
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FX402OnPurchaseAccepted, const FX402PurchaseAccepted&, Event);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FX402OnTransactionSettled, const FX402PurchaseSettled&, Event);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FX402OnPurchaseDeclined, const FX402PurchaseDeclined&, Event);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FX402OnTabChanged, const FX402TabChanged&, Event);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FX402OnError, const FX402Error&, Event);

/** Supplies the player's key for the one moment it is needed. */
DECLARE_DELEGATE_RetVal(FString, FX402KeyProvider);

UCLASS(BlueprintType)
class X402GAMING_API UX402StorefrontBridge : public UGameInstanceSubsystem
{
    GENERATED_BODY()

public:
    /** Base URL of YOUR server. It holds the catalog and does everything that moves money. */
    UPROPERTY(BlueprintReadWrite, Category = "x402|Config")
    FString ServerUrl;

    /** Sent as Authorization on every call. Use your existing session token. */
    UPROPERTY(BlueprintReadWrite, Category = "x402|Config")
    FString SessionToken;

    UPROPERTY(BlueprintReadWrite, Category = "x402|Config")
    float TimeoutSeconds = 20.f;

    UPROPERTY(BlueprintAssignable, Category = "x402") FX402OnPurchaseAccepted OnPurchaseAccepted;
    UPROPERTY(BlueprintAssignable, Category = "x402") FX402OnTransactionSettled OnTransactionSettled;
    UPROPERTY(BlueprintAssignable, Category = "x402") FX402OnPurchaseDeclined OnPurchaseDeclined;
    UPROPERTY(BlueprintAssignable, Category = "x402") FX402OnTabChanged OnTabChanged;
    UPROPERTY(BlueprintAssignable, Category = "x402") FX402OnError OnError;

    /**
     * Set this to something that unlocks your encrypted key store. The key is read once per
     * purchase and never held by this class.
     */
    FX402KeyProvider KeyProvider;

    /**
     * Buy an item. Asks the server what it costs, signs, hands the signature back.
     *
     * There is no amount parameter on purpose - the price comes from your server's catalog.
     */
    UFUNCTION(BlueprintCallable, Category = "x402")
    void Purchase(const FString& ItemId, const FString& PlayerId);

    /**
     * Charge a micro-action against the player's tab.
     *
     * ActionId must be stable for the same action, so a retry after a dropped connection is
     * not charged twice.
     */
    UFUNCTION(BlueprintCallable, Category = "x402")
    void Spend(const FString& PlayerId, const FString& ActionId, const FString& AmountAtomic);

    /** Read the player's remaining credit from the server. */
    UFUNCTION(BlueprintCallable, Category = "x402")
    void RefreshTab(const FString& PlayerId);

private:
    void Send(const FString& Verb, const FString& Path, const FString& Body,
              TFunction<void(const FString&)> OnOk);
    void Fail(const FString& Code, const FString& Message);
};
