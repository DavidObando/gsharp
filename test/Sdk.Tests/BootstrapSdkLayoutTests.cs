// <copyright file="BootstrapSdkLayoutTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Xml.Linq;
using Xunit;

namespace GSharp.Sdk.Tests;

/// <summary>
/// Issue #792 / ADR-0084. Structural tests over <c>Gsharp.NET.Sdk.Bootstrap</c>,
/// the build-time-only mirror of <c>Gsharp.NET.Sdk</c> that compiles
/// <c>.gs</c> sources against the in-tree <c>gsc.dll</c> and BuildTask
/// without the auto-reference to <c>Gsharp.Extensions.dll</c> — breaking
/// the SDK → Extensions → SDK cycle so an Extensions-equivalent
/// assembly can be authored in G# itself.
/// </summary>
public class BootstrapSdkLayoutTests
{
    private static readonly XNamespace MsbuildNs =
        "http://schemas.microsoft.com/developer/msbuild/2003";

    private static readonly string BootstrapSourceDir =
        Path.Combine(RepoRoot.Path, "src", "Sdk", "Gsharp.NET.Sdk.Bootstrap");

    [Fact]
    public void BootstrapDirectory_Exists_AndShipsTargetsAndReadme()
    {
        Assert.True(Directory.Exists(BootstrapSourceDir), BootstrapSourceDir);
        Assert.True(File.Exists(Path.Combine(BootstrapSourceDir, "README.md")));
        Assert.True(File.Exists(Path.Combine(BootstrapSourceDir, "build", "Gsharp.NET.Sdk.Bootstrap.targets")));
    }

    [Fact]
    public void BootstrapTargets_RegistersBuildTask_FromInTreeOutput()
    {
        var path = Path.Combine(BootstrapSourceDir, "build", "Gsharp.NET.Sdk.Bootstrap.targets");
        var doc = XDocument.Load(path);

        var usingTasks = doc.Descendants(MsbuildNs + "UsingTask").ToList();

        // The BuildTask name MUST be the same fully-qualified type as the
        // consumer SDK so MSBuild can swap one for the other transparently.
        Assert.Contains(usingTasks, ut =>
            (string)ut.Attribute("TaskName") == "Gsharp.NET.Sdk.Tools.BuildTask"
            && ((string)ut.Attribute("AssemblyFile") ?? string.Empty).Contains("GsharpToolFullPath"));
    }

    [Fact]
    public void BootstrapTargets_ResolvesCompilerAndBuildTaskFromOutBin()
    {
        var path = Path.Combine(BootstrapSourceDir, "build", "Gsharp.NET.Sdk.Bootstrap.targets");
        var text = File.ReadAllText(path);

        // gsc.dll comes from Compiler.csproj's per-project output.
        Assert.Contains("Compiler\\gsc.dll", text);

        // The BuildTask DLL comes from Gsharp.NET.Sdk.csproj's per-project output.
        Assert.Contains("Gsharp.NET.Sdk\\Gsharp.NET.Sdk.dll", text);

        // Both must be rooted at $(OutRoot) / out/bin/$(Configuration) so the
        // bootstrap and the consumer SDK pack agree byte-for-byte on layout.
        Assert.Contains("out\\bin\\$(Configuration)", text);
    }

    [Fact]
    public void BootstrapTargets_DoesNotAutoReferenceGsharpExtensions()
    {
        // The cycle this bootstrap exists to break: the consumer SDK
        // auto-references Gsharp.Extensions.dll into every .gsproj it
        // builds (see build/Gsharp.NET.Sdk.props), which would otherwise
        // make a G#-authored Gsharp.Extensions.gsproj self-referential.
        var path = Path.Combine(BootstrapSourceDir, "build", "Gsharp.NET.Sdk.Bootstrap.targets");
        var doc = XDocument.Load(path);

        // Walk every ItemGroup / ItemDefinitionGroup and assert no element
        // (other than mscorlib) references Gsharp.Extensions.dll. This is
        // structural, not textual — the README and inline comments are
        // free to *describe* the cycle they prevent.
        foreach (var item in doc.Descendants(MsbuildNs + "_ExplicitReference"))
        {
            var include = (string)item.Attribute("Include") ?? string.Empty;
            Assert.DoesNotContain("Gsharp.Extensions", include);
        }

        // Also: the GsharpExtensionsAssemblyFullPath property — set by the
        // consumer SDK's build/Gsharp.NET.Sdk.props — must not exist here.
        foreach (var prop in doc.Descendants(MsbuildNs + "GsharpExtensionsAssemblyFullPath"))
        {
            Assert.Fail($"Bootstrap must not set GsharpExtensionsAssemblyFullPath: {prop}");
        }
    }

    [Fact]
    public void BootstrapTargets_OverridesCoreCompile_WithBuildTask()
    {
        var path = Path.Combine(BootstrapSourceDir, "build", "Gsharp.NET.Sdk.Bootstrap.targets");
        var doc = XDocument.Load(path);

        var coreCompile = doc.Descendants(MsbuildNs + "Target")
            .FirstOrDefault(t => (string)t.Attribute("Name") == "CoreCompile");
        Assert.NotNull(coreCompile);

        // The override must invoke the same BuildTask the consumer SDK
        // uses so behavior is identical.
        var buildTask = coreCompile.Descendants(MsbuildNs + "BuildTask").FirstOrDefault();
        Assert.NotNull(buildTask);

        // It must forward both the compiler path and the source set.
        Assert.NotNull(buildTask.Attribute("GsharpCompilerFullPath"));
        Assert.NotNull(buildTask.Attribute("Compile"));
    }

    [Fact]
    public void BootstrapReadme_CallsOutCycleBreakingPurpose()
    {
        var path = Path.Combine(BootstrapSourceDir, "README.md");
        var text = File.ReadAllText(path);

        // Smoke check that the README explains *why* the bootstrap exists.
        // Future contributors should not need to chase the issue to learn
        // that this directory exists only to break the SDK ↔ Extensions
        // cycle so the Extensions stdlib can be dogfooded in G#.
        Assert.Contains("cycle", text, System.StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Gsharp.Extensions", text);
        Assert.Contains("792", text);
    }
}
