// <copyright file="BootstrapSdkLayoutTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import System.IO
import System.Linq
import System.Xml.Linq
import Xunit
import System

/// Issue #792 / ADR-0084. Structural tests over `Gsharp.NET.Sdk.Bootstrap`,
/// the build-time-only mirror of `Gsharp.NET.Sdk` that compiles
/// `.gs` sources against the in-tree `gsc.dll` and BuildTask
/// without the auto-reference to `Gsharp.Extensions.dll` — breaking
/// the SDK → Extensions → SDK cycle so an Extensions-equivalent
/// assembly can be authored in G# itself.
open class BootstrapSdkLayoutTests {
    @Fact
    func BootstrapDirectory_Exists_AndShipsTargetsAndReadme() {
        Assert.True(Directory.Exists(BootstrapSourceDir), BootstrapSourceDir)
        Assert.True(File.Exists(Path.Combine(BootstrapSourceDir, "README.md")))
        Assert.True(File.Exists(Path.Combine(BootstrapSourceDir, "build", "Gsharp.NET.Sdk.Bootstrap.targets")))
    }

    @Fact
    func BootstrapTargets_RegistersBuildTask_FromInTreeOutput() {
        let path = Path.Combine(BootstrapSourceDir, "build", "Gsharp.NET.Sdk.Bootstrap.targets")
        let doc = XDocument.Load(path)
        let usingTasks = doc.Descendants(MsbuildNs + "UsingTask").ToList()
        // The BuildTask name MUST be the same fully-qualified type as the
        // consumer SDK so MSBuild can swap one for the other transparently.
        Assert.Contains(
            usingTasks,
            (ut XElement) -> string(ut.Attribute(XName?("TaskName")!!)) == "Gsharp.NET.Sdk.Tools.BuildTask" &&
                (string(ut.Attribute(XName?("AssemblyFile")!!)) ?? string.Empty).Contains("GsharpToolFullPath")
        )
    }

    @Fact
    func BootstrapTargets_ResolvesCompilerAndBuildTaskFromOutBin() {
        let path = Path.Combine(BootstrapSourceDir, "build", "Gsharp.NET.Sdk.Bootstrap.targets")
        let text = File.ReadAllText(path)
        // gsc.dll comes from Compiler.csproj's per-project output.
        Assert.Contains("Compiler\\gsc.dll", text)
        // The BuildTask DLL comes from Gsharp.NET.Sdk.csproj's per-project output.
        Assert.Contains("Gsharp.NET.Sdk\\Gsharp.NET.Sdk.dll", text)
        // Both must be rooted at $(OutRoot) / out/bin/$(Configuration) so the
        // bootstrap and the consumer SDK pack agree byte-for-byte on layout.
        Assert.Contains("out\\bin\\$$(Configuration)", text)
    }

    @Fact
    func BootstrapTargets_DoesNotAutoReferenceGsharpExtensions() {
        // The cycle this bootstrap exists to break: the consumer SDK
        // auto-references Gsharp.Extensions.dll into every .gsproj it
        // builds (see build/Gsharp.NET.Sdk.props), which would otherwise
        // make a G#-authored Gsharp.Extensions.gsproj self-referential.
        let path = Path.Combine(BootstrapSourceDir, "build", "Gsharp.NET.Sdk.Bootstrap.targets")
        let doc = XDocument.Load(path)
        // Walk every ItemGroup / ItemDefinitionGroup and assert no element
        // (other than mscorlib) references Gsharp.Extensions.dll. This is
        // structural, not textual — the README and inline comments are
        // free to *describe* the cycle they prevent.
        for item in doc.Descendants(MsbuildNs + "_ExplicitReference") {
            let include = string(item.Attribute(XName?("Include")!!)) ?? string.Empty
            Assert.DoesNotContain("Gsharp.Extensions", include)
        }
        // Also: the GsharpExtensionsAssemblyFullPath property — set by the
        // consumer SDK's build/Gsharp.NET.Sdk.props — must not exist here.
        for prop in doc.Descendants(MsbuildNs + "GsharpExtensionsAssemblyFullPath") {
            Assert.Fail("Bootstrap must not set GsharpExtensionsAssemblyFullPath: $prop")
        }
    }

    @Fact
    func BootstrapTargets_References_Channels_Runtime_But_Not_Extensions() {
        // ADR-0174 D1: the C#-authored channel runtime has no bootstrap
        // cycle (it references nothing G#-authored), so the bootstrap MUST
        // forward it to gsc — Gsharp.Extensions' own .gs sources use channels
        // once the D9 helpers land — while still never referencing
        // Gsharp.Extensions.dll itself.
        let path = Path.Combine(BootstrapSourceDir, "build", "Gsharp.NET.Sdk.Bootstrap.targets")
        let doc = XDocument.Load(path)
        let includes = doc
            .Descendants(MsbuildNs + "_ExplicitReference")
            .Select((item XElement) -> string(item.Attribute(XName?("Include")!!)) ?? string.Empty)
            .ToList()
        Assert.Contains("$$(GsharpChannelsRuntimeAssemblyFullPath)", includes)
        Assert.DoesNotContain(
            includes,
            (include string) -> include.Contains("Gsharp.Extensions", StringComparison.Ordinal)
        )
        let property = doc.Descendants(MsbuildNs + "GsharpChannelsRuntimeAssemblyFullPath").Single()
        Assert.Contains(
            "Gsharp.Runtime.Channels\\Gsharp.Runtime.Channels.dll",
            property.Value,
            StringComparison.Ordinal
        )
    }

    @Fact
    func BootstrapTargets_OverridesCoreCompile_WithBuildTask() {
        let path = Path.Combine(BootstrapSourceDir, "build", "Gsharp.NET.Sdk.Bootstrap.targets")
        let doc = XDocument.Load(path)
        let coreCompile XElement? = doc.Descendants(MsbuildNs + "Target").FirstOrDefault(
            (t XElement) -> string(t.Attribute(XName?("Name")!!)) == "CoreCompile"
        )
        Assert.NotNull(coreCompile)
        // The override must invoke the same BuildTask the consumer SDK
        // uses so behavior is identical.
        let buildTask XElement? = coreCompile!!.Descendants(MsbuildNs + "BuildTask").FirstOrDefault()
        Assert.NotNull(buildTask)
        // It must forward both the compiler path and the source set.
        Assert.NotNull(buildTask!!.Attribute(XName?("GsharpCompilerFullPath")!!))
        Assert.NotNull(buildTask!!.Attribute(XName?("Compile")!!))
    }

    @Fact
    func BootstrapReadme_CallsOutCycleBreakingPurpose() {
        let path = Path.Combine(BootstrapSourceDir, "README.md")
        let text = File.ReadAllText(path)
        // Smoke check that the README explains *why* the bootstrap exists.
        // Future contributors should not need to chase the issue to learn
        // that this directory exists only to break the SDK ↔ Extensions
        // cycle so the Extensions stdlib can be dogfooded in G#.
        Assert.Contains("cycle", text, StringComparison.OrdinalIgnoreCase)
        Assert.Contains("Gsharp.Extensions", text)
        Assert.Contains("792", text)
    }

    shared {
        private let MsbuildNs XNamespace? = "http://schemas.microsoft.com/developer/msbuild/2003"
        private let BootstrapSourceDir string = Path.Combine(RepoRoot.Path, "src", "Sdk", "Gsharp.NET.Sdk.Bootstrap")
    }
}
