// Build rules for the plugin module.
//
// OpenSSL comes from Unreal's own ThirdParty tree, so a studio adds no dependency to take a
// payment - and what ships is what the vector harness verified.

using UnrealBuildTool;

public class X402Gaming : ModuleRules
{
    public X402Gaming(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        // The signer is plain C++ and throws on bad key material; the bridge catches it and
        // reports through OnError rather than taking the game down.
        bEnableExceptions = true;

        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core",
            "CoreUObject",
            "Engine",
        });

        PrivateDependencyModuleNames.AddRange(new string[]
        {
            "HTTP",
            "Json",
            "OpenSSL",     // Engine/Source/ThirdParty/OpenSSL - already in the engine
        });
    }
}
