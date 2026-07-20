// <copyright file="SdkLayoutTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Xml.Linq;
using Xunit;

namespace GSharp.Sdk.Tests;

/// <summary>
/// Structural tests over the files that ship inside the <c>Gsharp.NET.Sdk</c>
/// NuGet. These pin the shape MSBuild relies on when it loads the SDK as
/// <c>&lt;Project Sdk="Gsharp.NET.Sdk"&gt;</c> so accidental edits to the
/// .props/.targets surface immediately rather than at consumer build time.
/// </summary>
public class SdkLayoutTests
{
    private static readonly XNamespace MsbuildNs =
        "http://schemas.microsoft.com/developer/msbuild/2003";

    [Fact]
    public void Sdk_Props_Imports_MicrosoftNetSdk_And_Gsharp_Build_Props()
    {
        var path = Path.Combine(RepoRoot.SdkSourceDir, "Sdk", "Sdk.props");
        Assert.True(File.Exists(path), path);

        var doc = XDocument.Load(path);
        var imports = doc.Descendants(MsbuildNs + "Import").ToList();

        Assert.Contains(imports, i =>
            (string)i.Attribute("Sdk") == "Microsoft.NET.Sdk"
            && (string)i.Attribute("Project") == "Sdk.props");

        Assert.Contains(imports, i =>
            ((string)i.Attribute("Project") ?? string.Empty).EndsWith(
                "Gsharp.NET.Sdk.props",
                System.StringComparison.Ordinal));
    }

    [Fact]
    public void Sdk_Targets_Imports_MicrosoftNetSdk_Targets()
    {
        var path = Path.Combine(RepoRoot.SdkSourceDir, "Sdk", "Sdk.targets");
        Assert.True(File.Exists(path), path);

        var doc = XDocument.Load(path);
        var imports = doc.Descendants(MsbuildNs + "Import").ToList();

        Assert.Contains(imports, i =>
            (string)i.Attribute("Sdk") == "Microsoft.NET.Sdk"
            && (string)i.Attribute("Project") == "Sdk.targets");
    }

    [Fact]
    public void Build_Props_Sets_Language_And_Tool_Paths_And_LanguageTargets()
    {
        var path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Sdk.props");
        Assert.True(File.Exists(path), path);

        var doc = XDocument.Load(path);
        var props = doc.Descendants(MsbuildNs + "PropertyGroup")
            .Elements()
            .ToDictionary(e => e.Name.LocalName, e => e.Value, System.StringComparer.Ordinal);

        Assert.Equal("Gsharp", props["Language"]);
        Assert.Equal("Managed", props["TargetRuntime"]);
        Assert.Contains("Gsharp.NET.Sdk.dll", props["GsharpToolFullPath"]);
        Assert.Contains("gsc.dll", props["GsharpCompilerFullPath"]);
        Assert.Contains("Gsharp.NET.Current.Sdk.targets", props["LanguageTargets"]);
    }

    [Fact]
    public void Core_Targets_Declares_BuildTask_And_CoreCompile_Override()
    {
        var path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets");
        Assert.True(File.Exists(path), path);

        var doc = XDocument.Load(path);

        // ADR-0145 added a second UsingTask (GsgenTask) alongside BuildTask,
        // so select the one this test cares about by TaskName rather than
        // assuming BuildTask is the only <UsingTask> declared.
        var usingTask = doc.Descendants(MsbuildNs + "UsingTask")
            .Single(t => (string)t.Attribute("TaskName") == "Gsharp.NET.Sdk.Tools.BuildTask");
        Assert.Equal("$(GsharpToolFullPath)", (string)usingTask.Attribute("AssemblyFile"));

        var coreCompile = doc.Descendants(MsbuildNs + "Target")
            .FirstOrDefault(t => (string)t.Attribute("Name") == "CoreCompile");
        Assert.NotNull(coreCompile);

        var buildTask = coreCompile.Element(MsbuildNs + "BuildTask");
        Assert.NotNull(buildTask);

        // The BuildTask invocation has to forward the inputs gsc actually
        // consumes; if any of these drop off, consumer builds silently no-op.
        var attrs = buildTask!.Attributes().ToDictionary(a => a.Name.LocalName, a => a.Value);
        Assert.Equal("$(GsharpCompilerFullPath)", attrs["GsharpCompilerFullPath"]);
        Assert.Equal("@(Compile)", attrs["Compile"]);
        // gsc must receive the full transitive closure of references — the same
        // complete item csc consumes — so the MetadataLoadContext can resolve
        // every transitive dependency a referenced member touches (issue #340).
        Assert.Equal("@(ReferencePathWithRefAssemblies)", attrs["References"]);
        Assert.Equal("@(_GsharpCoreCompileResource)", attrs["Resources"]);
        Assert.Equal("$(OutputType)", attrs["OutputType"]);
        Assert.Equal("$(TargetFramework)", attrs["TargetFramework"]);

        // Reference-assembly emit must be forwarded so MSBuild's
        // ProduceReferenceAssembly pipeline (which sets @(IntermediateRefAssembly)
        // to obj/refint/{name}.dll) is honored.
        Assert.Equal("$(_GsharpRefAssemblyPath)", attrs["RefAssembly"]);
        Assert.Contains("@(_CoreCompileResourceInputs)", (string)coreCompile.Attribute("Inputs"));
        Assert.Contains(
            coreCompile.Descendants(MsbuildNs + "_GsharpCoreCompileResource"),
            resource => ((string)resource.Attribute("Condition") ?? string.Empty)
                .Contains("WithCulture", System.StringComparison.Ordinal));

        var runSettingsTarget = doc.Descendants(MsbuildNs + "Target")
            .Single(t => (string)t.Attribute("Name") == "_GsharpGenerateRunSettings");
        Assert.Equal("CoreCompile", (string)runSettingsTarget.Attribute("BeforeTargets"));
        Assert.Contains(
            "$(MSBuildProjectDirectory)",
            doc.Descendants(MsbuildNs + "RunSettingsFilePath").Single().Value);
        Assert.Contains(
            runSettingsTarget.Descendants(MsbuildNs + "_GsharpRunSettingsLine"),
            line => line.Attribute("Include")?.Value.Contains("$(TargetFramework)") == true);
    }

    [Fact]
    public void Sdk_Props_Enables_ProduceReferenceAssembly()
    {
        var path = Path.Combine(RepoRoot.SdkSourceDir, "Sdk", "Sdk.props");
        var text = File.ReadAllText(path);
        Assert.Contains("<ProduceReferenceAssembly", text, System.StringComparison.Ordinal);
        Assert.Contains(">true</ProduceReferenceAssembly>", text, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Sdk_Props_Excludes_LanguageServer_Cache_From_Default_Items()
    {
        var path = Path.Combine(RepoRoot.SdkSourceDir, "Sdk", "Sdk.props");
        var doc = XDocument.Load(path);
        var elements = doc.Root!.Elements().ToList();
        var excludes = elements
            .TakeWhile(element => element.Name.LocalName != "Import")
            .Descendants(MsbuildNs + "DefaultItemExcludes")
            .Single();

        Assert.Contains("**/*.gsproj.lscache", excludes.Value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Sdk_Csproj_Packs_As_MSBuildSdk()
    {
        var csproj = Path.Combine(RepoRoot.SdkSourceDir, "Gsharp.NET.Sdk.csproj");
        Assert.True(File.Exists(csproj), csproj);

        var text = File.ReadAllText(csproj);
        // The SDK must ship its tools (gsc + build task) and propsfiles
        // alongside Sdk.props/Sdk.targets so msbuild can resolve it.
        Assert.Contains("netstandard2.0", text, System.StringComparison.Ordinal);
        Assert.Contains("Microsoft.Build.Framework", text, System.StringComparison.Ordinal);
        Assert.Contains("Microsoft.Build.Utilities.Core", text, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Core_Targets_Forwards_Phase6_And_Phase7_BuildTask_Attributes()
    {
        var path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets");
        var doc = XDocument.Load(path);
        var buildTask = doc.Descendants(MsbuildNs + "Target")
            .First(t => (string)t.Attribute("Name") == "CoreCompile")
            .Element(MsbuildNs + "BuildTask");

        var attrs = buildTask!.Attributes().ToDictionary(a => a.Name.LocalName, a => a.Value);

        // Phase 8 wiring: the four debug-information-shaped MSBuild properties
        // must all reach the task, else consumer projects can't control
        // SourceLink / embed / determinism without command-line workarounds.
        Assert.Equal("$(DebugType)", attrs["DebugType"]);
        Assert.Equal("@(_DebugSymbolsIntermediatePath)", attrs["PdbFile"]);
        Assert.Equal("$(SourceLink)", attrs["SourceLink"]);
        Assert.Equal("$(EmbedAllSources)", attrs["EmbedAllSources"]);
        Assert.Equal("$(Deterministic)", attrs["Deterministic"]);
    }

    [Fact]
    public void Core_Targets_Adds_Sidecar_Pdb_To_FileWrites()
    {
        var path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets");
        var doc = XDocument.Load(path);

        var fileWrites = doc.Descendants(MsbuildNs + "FileWrites")
            .Where(fw =>
                ((string)fw.Attribute("Include") ?? string.Empty)
                    .Contains("_DebugSymbolsIntermediatePath", System.StringComparison.Ordinal))
            .ToList();

        Assert.Single(fileWrites);

        // The PDB FileWrites entry must be gated so Clean / incremental skips
        // it when no sidecar is produced (DebugType=embedded/none/empty).
        var condition = (string)fileWrites[0].Attribute("Condition");
        Assert.NotNull(condition);
        Assert.Contains("'$(DebugType)' != 'embedded'", condition, System.StringComparison.Ordinal);
        Assert.Contains("'$(DebugType)' != 'none'", condition, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Core_Targets_Declares_GenerateMSBuildEditorConfigFileShouldRun_Hook()
    {
        // Issue #2294: Avalonia.Generators.props (and any other package that
        // populates @(AdditionalFiles) via BeforeTargets, rather than a plain
        // ItemGroup) hooks BeforeTargets="GenerateMSBuildEditorConfigFileShouldRun".
        // That target only exists because Microsoft.Managed.Core.targets defines
        // it for C#/VB SDK projects; a Gsharp project never imports it, so without
        // this pinned no-op target the hook silently never fires and
        // @(AdditionalFiles) never receives the injected items. This test pins
        // both the target's existence and its position ahead of gsgen's own
        // AdditionalFiles-consuming target so a future edit can't reintroduce the
        // gap silently.
        var path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets");
        var doc = XDocument.Load(path);

        var hook = doc.Descendants(MsbuildNs + "Target")
            .FirstOrDefault(t => (string)t.Attribute("Name") == "GenerateMSBuildEditorConfigFileShouldRun");
        Assert.NotNull(hook);

        var runGenerators = doc.Descendants(MsbuildNs + "Target")
            .First(t => (string)t.Attribute("Name") == "_GsharpRunSourceGenerators");
        var dependsOn = ((string)runGenerators.Attribute("DependsOnTargets"))
            .Split(';', System.StringSplitOptions.RemoveEmptyEntries);
        Assert.Contains("GenerateMSBuildEditorConfigFileShouldRun", dependsOn);
    }

    [Fact]
    public void Core_Targets_Declares_AfterCompile_Hook_In_CompileDependsOn()
    {
        var path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets");
        var doc = XDocument.Load(path);

        Assert.Contains(
            doc.Descendants(MsbuildNs + "Target"),
            target => (string)target.Attribute("Name") == "AfterCompile");
        Assert.Contains(
            doc.Descendants(MsbuildNs + "CompileDependsOn"),
            property => property.Value.Contains("AfterCompile", System.StringComparison.Ordinal));
    }
}
