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

    private static string SdkProjectPath =>
        RepoRoot.ResolveSourcePath(
            Path.Combine(RepoRoot.SdkSourceDir, "Gsharp.NET.Sdk.csproj"));

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

        var managedDesignTimeImport = imports.Single(i =>
            ((string)i.Attribute("Project") ?? string.Empty).Contains(
                "GsharpDesignTimeTargetsPath",
                System.StringComparison.Ordinal));
        Assert.Contains(
            "$(DesignTimeBuild)",
            (string)managedDesignTimeImport.Attribute("Condition"),
            System.StringComparison.Ordinal);
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
        Assert.Equal("@(GsharpCommandLineArgs)", (string)coreCompile.Attribute("Returns"));

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
        Assert.Equal("$(Optimize)", attrs["Optimization"]);
        Assert.Equal("$(SkipCompilerExecution)", attrs["SkipCompilerExecution"]);
        Assert.Equal("$(ProvideCommandLineArgs)", attrs["ProvideCommandLineArgs"]);
        Assert.Contains(
            buildTask.Elements(MsbuildNs + "Output"),
            output => (string)output.Attribute("TaskParameter") == "CommandLineArgs"
                && (string)output.Attribute("ItemName") == "GsharpCommandLineArgs");

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
        Assert.Equal("CoreCompile;VSTest", (string)runSettingsTarget.Attribute("BeforeTargets"));
        Assert.Equal(
            "$([MSBuild]::NormalizePath('$(IntermediateOutputPath)', 'gsharp.generated.runsettings'))",
            doc.Descendants(MsbuildNs + "RunSettingsFilePath").Single().Value);
        Assert.Contains(
            runSettingsTarget.Descendants(MsbuildNs + "_GsharpRunSettingsLine"),
            line => line.Attribute("Include")?.Value.Contains("$(TargetFramework)") == true);

        var compileDesignTime = doc.Descendants(MsbuildNs + "Target")
            .Single(t => (string)t.Attribute("Name") == "CompileDesignTime");
        Assert.Equal("@(_CompilerCommandLineArgs)", (string)compileDesignTime.Attribute("Returns"));
        Assert.Equal(
            "_CheckCompileDesignTimePrerequisite;Compile",
            (string)compileDesignTime.Attribute("DependsOnTargets"));
        Assert.Equal(
            "'$(IsCrossTargetingBuild)' != 'true'",
            (string)compileDesignTime.Attribute("Condition"));
        Assert.Contains(
            compileDesignTime.Descendants(MsbuildNs + "_CompilerCommandLineArgs"),
            item => (string)item.Attribute("Include") == "@(GsharpCommandLineArgs)");

        var prerequisite = doc.Descendants(MsbuildNs + "Target")
            .Single(t => (string)t.Attribute("Name") == "_CheckCompileDesignTimePrerequisite");
        var prerequisiteError = prerequisite.Element(MsbuildNs + "Error");
        Assert.NotNull(prerequisiteError);
        Assert.Contains(
            "$(SkipCompilerExecution)|$(ProvideCommandLineArgs)",
            (string)prerequisiteError!.Attribute("Condition"),
            System.StringComparison.Ordinal);

        var hotReloadCompile = doc.Descendants(MsbuildNs + "Target")
            .Single(t => (string)t.Attribute("Name") == "_GsharpHotReloadCompile");
        Assert.Equal("Compile", (string)hotReloadCompile.Attribute("DependsOnTargets"));
        Assert.Contains(
            hotReloadCompile.Elements(MsbuildNs + "Copy"),
            copy => (string)copy.Attribute("SourceFiles") == "@(IntermediateAssembly)");

        var hotReloadBaseline = doc.Descendants(MsbuildNs + "Target")
            .Single(t => (string)t.Attribute("Name") == "_GsharpBuildHotReloadBaseline");
        Assert.Equal("CompileDesignTime", (string)hotReloadBaseline.Attribute("BeforeTargets"));
        var hotReloadBaselineDeletes =
            (string)hotReloadBaseline.Element(MsbuildNs + "Delete").Attribute("Files");
        Assert.Contains("@(IntermediateAssembly)", hotReloadBaselineDeletes, System.StringComparison.Ordinal);
        Assert.Contains(
            "$(IntermediateOutputPath)$(AssemblyName)$(TargetExt)",
            hotReloadBaselineDeletes,
            System.StringComparison.Ordinal);
        Assert.Contains("$(ProjectDepsFilePath)", hotReloadBaselineDeletes, System.StringComparison.Ordinal);
        Assert.Contains(
            hotReloadBaseline.Elements(MsbuildNs + "MSBuild"),
            task => (string)task.Attribute("Targets") == "Build");

        Assert.Contains(
            "RuntimeAssemblyPath=\"$(GsharpHotReloadRuntimeAssemblyFullPath)\"",
            File.ReadAllText(path),
            System.StringComparison.Ordinal);

        var hotReloadEnabled = doc.Descendants(MsbuildNs + "GsharpEnableHotReload").Single();
        Assert.Contains(
            "$(DotNetWatchBuild)",
            (string)hotReloadEnabled.Attribute("Condition"),
            System.StringComparison.Ordinal);

        Assert.Contains(
            doc.Descendants(MsbuildNs + "ProjectCapability"),
            capability => (string)capability.Attribute("Include") == "SupportsHotReload");
        var hotReloadManifest = doc.Descendants(MsbuildNs + "None")
            .Single(item => (string)item.Attribute("Include") == "$(GsharpHotReloadManifestPath)");
        Assert.Equal("PreserveNewest", (string)hotReloadManifest.Attribute("CopyToOutputDirectory"));
        Assert.Contains(
            "$(DesignTimeBuild)",
            (string)doc.Descendants(MsbuildNs + "GsharpEnableHotReload").Single().Attribute("Condition"),
            System.StringComparison.Ordinal);
        Assert.Contains(
            "$(MSBuildProjectName).manifest",
            doc.Descendants(MsbuildNs + "GsharpHotReloadManifestPath").Single().Value,
            System.StringComparison.Ordinal);
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
    public void Core_Targets_Pin_HotReload_Watch_Inputs_And_Serialized_Agent_Build()
    {
        var path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets");
        var doc = XDocument.Load(path);
        var baselineTarget = doc.Descendants(MsbuildNs + "Target")
            .Single(target => (string)target.Attribute("Name") == "_GsharpBuildHotReloadBaseline");
        var baselineBuild = Assert.Single(baselineTarget.Elements(MsbuildNs + "MSBuild"));
        var baselineProperties = ((string)baselineBuild.Attribute("Properties") ?? string.Empty)
            .Split(
                ';',
                System.StringSplitOptions.RemoveEmptyEntries |
                System.StringSplitOptions.TrimEntries);

        Assert.Equal("Build", (string)baselineBuild.Attribute("Targets"));
        Assert.Equal("false", (string)baselineBuild.Attribute("BuildInParallel"));
        Assert.Contains("DotNetWatchBuild=false", baselineProperties);
        Assert.Contains("GsharpEnableHotReload=true", baselineProperties);
        Assert.Contains("BuildProjectReferences=false", baselineProperties);

        var removedProperties = ((string)baselineBuild.Attribute("RemoveProperties") ?? string.Empty)
            .Split(
                ';',
                System.StringSplitOptions.RemoveEmptyEntries |
                System.StringSplitOptions.TrimEntries);
        Assert.Contains("DesignTimeBuild", removedProperties);
        Assert.Contains("SkipCompilerExecution", removedProperties);
        Assert.Contains("ProvideCommandLineArgs", removedProperties);
        Assert.Contains("BuildingInsideVisualStudio", removedProperties);

        var gatedItems = doc.Descendants(MsbuildNs + "ItemGroup")
            .Single(group =>
                group.Elements(MsbuildNs + "Reference")
                    .Any(item => (string)item.Attribute("Include") == "Gsharp.HotReload.Runtime") &&
                group.Elements(MsbuildNs + "None")
                    .Any(item => (string)item.Attribute("Include") == "$(GsharpHotReloadManifestPath)") &&
                group.Elements(MsbuildNs + "ProjectCapability")
                    .Any(item => (string)item.Attribute("Include") == "SupportsHotReload"));
        var gatedItemsCondition = (string)gatedItems.Attribute("Condition");
        Assert.Contains(
            "'$(GsharpEnableHotReload)' == 'true'",
            gatedItemsCondition,
            System.StringComparison.Ordinal);
        Assert.Contains(
            "'$(_GsharpHotReloadSupported)' == 'true'",
            gatedItemsCondition,
            System.StringComparison.Ordinal);

        var prepareTarget = doc.Descendants(MsbuildNs + "Target")
            .Single(target => (string)target.Attribute("Name") == "_GsharpPrepareHotReload");
        var manifestTarget = doc.Descendants(MsbuildNs + "Target")
            .Single(target => (string)target.Attribute("Name") == "_GsharpWriteHotReloadManifest");
        Assert.Contains(
            "'$(_GsharpHotReloadSupported)' == 'true'",
            (string)prepareTarget.Attribute("Condition"),
            System.StringComparison.Ordinal);
        Assert.DoesNotContain(
            "$(GsharpEnableHotReload)",
            (string)prepareTarget.Attribute("Condition"),
            System.StringComparison.Ordinal);
        Assert.Contains(
            "'$(GsharpEnableHotReload)' == 'true'",
            (string)manifestTarget.Attribute("Condition"),
            System.StringComparison.Ordinal);
        Assert.All(
            new[] { prepareTarget, manifestTarget },
            target => Assert.Equal(
                "@(_GsharpHotReloadWatch)",
                (string)Assert.Single(
                    target.Elements(MsbuildNs + "WriteGsharpHotReloadArtifactsTask"))
                    .Attribute("WatchFiles")));
        Assert.Equal(
            "$(_GsharpHotReloadActive)",
            (string)prepareTarget.Element(MsbuildNs + "WriteGsharpHotReloadArtifactsTask")
                .Attribute("CopyRuntime"));
        Assert.Equal(
            "$(_GsharpHotReloadActive)",
            (string)prepareTarget.Element(MsbuildNs + "WriteGsharpHotReloadArtifactsTask")
                .Attribute("WriteBootstrap"));
        Assert.Equal(
            "true",
            (string)manifestTarget.Element(MsbuildNs + "WriteGsharpHotReloadArtifactsTask")
                .Attribute("CopyRuntime"));
        Assert.Equal(
            "true",
            (string)manifestTarget.Element(MsbuildNs + "WriteGsharpHotReloadArtifactsTask")
                .Attribute("WriteBootstrap"));

        Assert.Equal(
            "@(Compile);@(AdditionalFiles);$(MSBuildProjectFullPath)",
            (string)prepareTarget.Descendants(MsbuildNs + "_GsharpHotReloadWatch")
                .Single(item => item.Attribute("Include") != null)
                .Attribute("Include"));
        Assert.Equal(
            "@(Compile);@(_GsharpForeignCompile);@(AdditionalFiles);$(MSBuildProjectFullPath)",
            (string)manifestTarget.Descendants(MsbuildNs + "_GsharpHotReloadWatch")
                .Single(item => item.Attribute("Include") != null)
                .Attribute("Include"));

        var filterTarget = doc.Descendants(MsbuildNs + "Target")
            .Single(target => (string)target.Attribute("Name") == "_GsharpFilterHotReloadWatchItems");
        Assert.Contains(
            "_GsharpFilterHotReloadWatchItems",
            doc.Descendants(MsbuildNs + "CustomCollectWatchItems").Single().Value,
            System.StringComparison.Ordinal);
        Assert.Equal(
            "@(Compile)",
            (string)filterTarget.Descendants(MsbuildNs + "Compile").Single().Attribute("Remove"));
        Assert.Equal(
            "@(AdditionalFiles)",
            (string)filterTarget.Descendants(MsbuildNs + "AdditionalFiles").Single().Attribute("Remove"));
        Assert.Equal(
            "@(_GsharpAgentOwnedWatch)",
            (string)filterTarget.Descendants(MsbuildNs + "Watch").Single().Attribute("Remove"));

        var agentPath = RepoRoot.ResolveSourcePath(Path.GetFullPath(Path.Combine(
            RepoRoot.SdkSourceDir,
            "..",
            "Gsharp.HotReload.Runtime",
            "HotReloadAgent.cs")));
        var agentText = File.ReadAllText(agentPath);

        // Declaration order differs between the C# and G# spellings of this
        // file (`SemaphoreSlim updateGate` vs `updateGate SemaphoreSlim`), so
        // assert on the two tokens rather than on one language's word order.
        Assert.Contains("SemaphoreSlim", agentText, System.StringComparison.Ordinal);
        Assert.Contains("updateGate", agentText, System.StringComparison.Ordinal);
        Assert.DoesNotContain("-p:IntermediateOutputPath=", agentText, System.StringComparison.Ordinal);
        Assert.DoesNotContain("-p:OutputPath=", agentText, System.StringComparison.Ordinal);
        Assert.DoesNotContain("-p:DotNetWatchBuild=true", agentText, System.StringComparison.Ordinal);
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

        var hiddenCache = doc.Descendants(MsbuildNs + "None")
            .Single(item => (string)item.Attribute("Include") == "**/*.gsproj.lscache");
        Assert.Equal("false", (string)hiddenCache.Attribute("Visible"));
    }

    [Fact]
    public void Sdk_Csproj_Packs_As_MSBuildSdk()
    {
        var csproj = SdkProjectPath;
        Assert.True(File.Exists(csproj), csproj);

        var text = File.ReadAllText(csproj);
        // The SDK must ship its tools (gsc + build task) and propsfiles
        // alongside Sdk.props/Sdk.targets so msbuild can resolve it.
        Assert.Contains("netstandard2.0", text, System.StringComparison.Ordinal);
        Assert.Contains("Microsoft.Build.Framework", text, System.StringComparison.Ordinal);
        Assert.Contains("Microsoft.Build.Utilities.Core", text, System.StringComparison.Ordinal);
        Assert.Contains("tools\\hotreload\\", text, System.StringComparison.Ordinal);
        Assert.Contains("Gsharp.HotReload.Runtime.dll", text, System.StringComparison.Ordinal);
        // ADR-0174 D1: the channel runtime ships under tools/channels/.
        Assert.Contains("tools\\channels\\", text, System.StringComparison.Ordinal);
        Assert.Contains("Gsharp.Runtime.Channels.dll", text, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Sdk_Csproj_Uses_BuildOnly_Channels_Runtime_Reference_And_Packs_Runtime()
    {
        // ADR-0174 D1: mirrors the hot-reload runtime wiring — build-only
        // ProjectReference for ordering, a pack target under tools/channels/.
        var path = SdkProjectPath;
        var doc = XDocument.Load(path);
        var runtimeReference = doc.Descendants("ProjectReference")
            .Single(reference => ReferencesProject(reference, "Gsharp.Runtime.Channels"));

        Assert.Equal("false", (string)runtimeReference.Attribute("Private"));
        Assert.Equal("false", (string)runtimeReference.Attribute("ReferenceOutputAssembly"));
        Assert.Equal("true", (string)runtimeReference.Attribute("SkipGetTargetFrameworkProperties"));

        var runtimeTarget = doc.Descendants("Target")
            .Single(target => (string)target.Attribute("Name") == "PackGsharpChannelsRuntime");

        Assert.Equal("_GetPackageFiles", (string)runtimeTarget.Attribute("BeforeTargets"));
        Assert.Equal("Build", (string)runtimeTarget.Attribute("DependsOnTargets"));
        var runtimePayload = runtimeTarget.Descendants("None")
            .Single(item => (string)item.Attribute("Include") == "@(_GsharpChannelsRuntimePayload)");
        Assert.Equal("true", (string)runtimePayload.Attribute("Pack"));
        Assert.Equal("tools\\channels\\", (string)runtimePayload.Attribute("PackagePath"));
    }

    [Fact]
    public void Sdk_Props_AutoReferences_Channels_Runtime_Like_Extensions()
    {
        // ADR-0174 D1: unlike hot reload (opt-in <Reference>), the channel
        // runtime rides the same unconditional _ExplicitReference channel as
        // Gsharp.Extensions so it reaches gsc's /r: list for every consumer.
        var path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Sdk.props");
        var doc = XDocument.Load(path);
        var references = doc.Descendants(MsbuildNs + "_ExplicitReference")
            .Select(item => (string)item.Attribute("Include"))
            .ToList();
        Assert.Contains("$(GsharpExtensionsAssemblyFullPath)", references);
        Assert.Contains("$(GsharpChannelsRuntimeAssemblyFullPath)", references);

        var property = doc.Descendants(MsbuildNs + "GsharpChannelsRuntimeAssemblyFullPath").Single();
        Assert.Contains(@"tools\channels\Gsharp.Runtime.Channels.dll", property.Value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void Sdk_Csproj_Uses_BuildOnly_HotReload_Runtime_Reference_And_Packs_Runtime()
    {
        var path = SdkProjectPath;
        var doc = XDocument.Load(path);
        var runtimeReference = doc.Descendants("ProjectReference")
            .Single(reference => ReferencesProject(reference, "Gsharp.HotReload.Runtime"));

        Assert.Equal("false", (string)runtimeReference.Attribute("Private"));
        Assert.Equal("false", (string)runtimeReference.Attribute("ReferenceOutputAssembly"));
        Assert.Equal("true", (string)runtimeReference.Attribute("SkipGetTargetFrameworkProperties"));

        var runtimeTarget = doc.Descendants("Target")
            .Single(target => (string)target.Attribute("Name") == "PackGsharpHotReloadRuntime");

        Assert.Equal("_GetPackageFiles", (string)runtimeTarget.Attribute("BeforeTargets"));
        Assert.Equal("Build", (string)runtimeTarget.Attribute("DependsOnTargets"));
        var runtimePayload = runtimeTarget.Descendants("None")
            .Single(item => (string)item.Attribute("Include") == "@(_GsharpHotReloadRuntimePayload)");
        Assert.Equal("true", (string)runtimePayload.Attribute("Pack"));
        Assert.Equal("tools\\hotreload\\", (string)runtimePayload.Attribute("PackagePath"));
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
    public void Core_Targets_Computes_Standard_Manifest_Resource_Names()
    {
        var path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets");
        var doc = XDocument.Load(path);
        var target = doc.Descendants(MsbuildNs + "Target")
            .Single(t => (string)t.Attribute("Name") == "CreateManifestResourceNames");
        var namingTasks = target.Elements(MsbuildNs + "CreateCSharpManifestResourceName").ToList();

        Assert.Equal(2, namingTasks.Count);
        Assert.All(
            namingTasks,
            task => Assert.Equal("$(RootNamespace)", (string)task.Attribute("RootNamespace")));
        Assert.All(
            namingTasks,
            task => Assert.Equal(
                "_Temporary",
                (string)task.Element(MsbuildNs + "Output")?.Attribute("ItemName")));
        Assert.Contains(
            target.Descendants(MsbuildNs + "EmbeddedResource"),
            item => (string)item.Attribute("Include") == "@(_Temporary)");
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

    /// <summary>
    /// Matches a <c>ProjectReference</c> that points at
    /// <c>&lt;projectName&gt;/&lt;projectName&gt;</c>, tolerating both path
    /// separators and both project-file extensions. The cs2gs self-migration
    /// corpus rewrites these references to <c>.gsproj</c> with forward slashes,
    /// and the assertion is about the reference's target, not its spelling.
    /// </summary>
    /// <param name="reference">The <c>ProjectReference</c> element.</param>
    /// <param name="projectName">The referenced project's directory and base file name.</param>
    /// <returns><see langword="true"/> when the reference targets that project.</returns>
    private static bool ReferencesProject(XElement reference, string projectName)
    {
        var include = ((string)reference.Attribute("Include") ?? string.Empty)
            .Replace('\\', '/');
        var stem = projectName + "/" + projectName + ".";
        return include.EndsWith(stem + "csproj", System.StringComparison.Ordinal)
            || include.EndsWith(stem + "gsproj", System.StringComparison.Ordinal);
    }
}
