using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;

namespace GSharp.VisualStudio;

internal static class LanguageClientPolicy
{
    public static string ResolveServerPath(string extensionDirectory, string configuredPath)
        => string.IsNullOrWhiteSpace(configuredPath)
            ? Path.Combine(extensionDirectory, ".server", "GSharp.LanguageServer.dll")
            : Environment.ExpandEnvironmentVariables(configuredPath);

    public static IReadOnlyDictionary<string, object> CreateInitializationOptions(
        int indentSize,
        bool useTabs,
        bool diagnosticsOnType = true,
        bool completionTriggerOnDot = true,
        bool referenceCodeLens = true,
        bool parameterNameInlayHints = true,
        bool typeInlayHints = true,
        bool coldStartCache = true)
        => new Dictionary<string, object>
        {
            ["formattingIndentSize"] = Math.Max(1, indentSize),
            ["formattingUseTabs"] = useTabs,
            ["diagnosticsOnType"] = diagnosticsOnType,
            ["completionTriggerOnDot"] = completionTriggerOnDot,
            ["referenceCodeLens"] = referenceCodeLens,
            ["parameterNameInlayHints"] = parameterNameInlayHints,
            ["typeInlayHints"] = typeInlayHints,
            ["coldStartCache"] = coldStartCache,
        };

    public static IReadOnlyDictionary<string, string> CreateEnvironment(
        bool enableColdStartCache,
        bool waitForDebugger)
    {
        var environment = new Dictionary<string, string>
        {
            ["DOTNET_EnableDiagnostics"] = waitForDebugger ? "1" : "0",
            ["DOTNET_CLI_UI_LANGUAGE"] = "en",
            ["DOTNET_NOLOGO"] = "1",
            ["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1",
        };
        if (!enableColdStartCache)
        {
            environment["GSHARP_DISABLE_COLD_START_CACHE"] = "1";
        }

        return environment;
    }

    public static string StatusText(string state, string? projectName = null)
        => string.IsNullOrWhiteSpace(projectName)
            ? $"G# language server {state}."
            : $"G# language server {state} - {projectName}.";

    public static async Task RestartAsync(Func<Task>? stop, Func<Task>? start)
    {
        if (stop != null)
        {
            await stop();
        }

        if (start != null)
        {
            await start();
        }
    }
}
