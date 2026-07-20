using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Xunit;

namespace GSharp.VisualStudio;

public sealed class LanguageClientPolicyTests
{
    [Fact]
    public void ResolveServerPath_UsesBundledPayloadByDefault()
    {
        Assert.Equal(
            Path.Combine("extension", ".server", "GSharp.LanguageServer.dll"),
            LanguageClientPolicy.ResolveServerPath("extension", string.Empty));
    }

    [Fact]
    public void CreateInitializationOptions_ClassifiesFormattingSettings()
    {
        IReadOnlyDictionary<string, object> options =
            LanguageClientPolicy.CreateInitializationOptions(0, useTabs: true);

        Assert.Equal(1, options["formattingIndentSize"]);
        Assert.Equal(true, options["formattingUseTabs"]);
    }

    [Fact]
    public void CreateEnvironment_OnlyDisablesCacheWhenRequested()
    {
        Assert.DoesNotContain(
            "GSHARP_DISABLE_COLD_START_CACHE",
            LanguageClientPolicy.CreateEnvironment(
                enableColdStartCache: true,
                waitForDebugger: false).Keys);
        Assert.Equal(
            "1",
            LanguageClientPolicy.CreateEnvironment(
                enableColdStartCache: false,
                waitForDebugger: false)
                ["GSHARP_DISABLE_COLD_START_CACHE"]);
    }

    [Fact]
    public void CreateEnvironment_EnablesDiagnosticsWhenWaitingForDebugger()
    {
        Assert.Equal(
            "1",
            LanguageClientPolicy.CreateEnvironment(
                enableColdStartCache: true,
                waitForDebugger: true)["DOTNET_EnableDiagnostics"]);
    }

    [Fact]
    public async Task RestartAsync_StopsBeforeStarting()
    {
        var calls = new List<string>();

        await LanguageClientPolicy.RestartAsync(
            () =>
            {
                calls.Add("stop");
                return Task.CompletedTask;
            },
            () =>
            {
                calls.Add("start");
                return Task.CompletedTask;
            });

        Assert.Equal(new[] { "stop", "start" }, calls);
    }

    [Theory]
    [InlineData("ready", null, "G# language server ready.")]
    [InlineData("ready", "Sample", "G# language server ready - Sample.")]
    public void StatusText_IncludesActiveProject(
        string state,
        string? projectName,
        string expected)
    {
        Assert.Equal(expected, LanguageClientPolicy.StatusText(state, projectName));
    }
}
