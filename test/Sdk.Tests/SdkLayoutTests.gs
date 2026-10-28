// <copyright file="SdkLayoutTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import System.IO
import System.Linq
import System.Xml.Linq
import Xunit
import System

/// Structural tests over the files that ship inside the `Gsharp.NET.Sdk`
/// NuGet. These pin the shape MSBuild relies on when it loads the SDK as
/// `<Project Sdk="Gsharp.NET.Sdk">` so accidental edits to the
/// .props/.targets surface immediately rather than at consumer build time.
open class SdkLayoutTests {
    @Fact
    func Sdk_Props_Imports_MicrosoftNetSdk_And_Gsharp_Build_Props() {
        let path = Path.Combine(RepoRoot.SdkSourceDir, "Sdk", "Sdk.props")
        Assert.True(File.Exists(path), path)
        let doc = XDocument.Load(path)
        let imports = doc.Descendants(MsbuildNs + "Import").ToList()
        Assert.Contains(
            imports,
            (i XElement) -> string(i.Attribute(XName?("Sdk")!!)) == "Microsoft.NET.Sdk" &&
                string(i.Attribute(XName?("Project")!!)) == "Sdk.props"
        )
        Assert.Contains(
            imports,
            (i XElement) -> (string(i.Attribute(XName?("Project")!!)) ?? string.Empty).EndsWith(
                "Gsharp.NET.Sdk.props",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func Sdk_Targets_Imports_MicrosoftNetSdk_Targets() {
        let path = Path.Combine(RepoRoot.SdkSourceDir, "Sdk", "Sdk.targets")
        Assert.True(File.Exists(path), path)
        let doc = XDocument.Load(path)
        let imports = doc.Descendants(MsbuildNs + "Import").ToList()
        Assert.Contains(
            imports,
            (i XElement) -> string(i.Attribute(XName?("Sdk")!!)) == "Microsoft.NET.Sdk" &&
                string(i.Attribute(XName?("Project")!!)) == "Sdk.targets"
        )
        let managedDesignTimeImport = imports.Single(
            (i XElement) -> (string(i.Attribute(XName?("Project")!!)) ?? string.Empty).Contains(
                "GsharpDesignTimeTargetsPath",
                StringComparison.Ordinal
            )
        )
        Assert.Contains(
            "$$(DesignTimeBuild)",
            string(managedDesignTimeImport.Attribute(XName?("Condition")!!)),
            StringComparison.Ordinal
        )
    }

    @Fact
    func Build_Props_Sets_Language_And_Tool_Paths_And_LanguageTargets() {
        let path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Sdk.props")
        Assert.True(File.Exists(path), path)
        let doc = XDocument.Load(path)
        let props = doc
            .Descendants(MsbuildNs + "PropertyGroup")
            .Elements()
            .ToDictionary(
            func (e XElement) string {
                return e.Name.LocalName
            },
            (e XElement) -> e.Value,
            StringComparer.Ordinal
        )
        Assert.Equal("Gsharp", props["Language"])
        Assert.Equal("Managed", props["TargetRuntime"])
        Assert.Contains("Gsharp.NET.Sdk.dll", props["GsharpToolFullPath"])
        Assert.Contains("gsc.dll", props["GsharpCompilerFullPath"])
        Assert.Contains("gsfmt.dll", props["GsharpFormatterFullPath"])
        Assert.Contains("Gsharp.NET.Current.Sdk.targets", props["LanguageTargets"])
    }

    @Fact
    func Core_Targets_Declares_BuildTask_And_CoreCompile_Override() {
        let path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets")
        Assert.True(File.Exists(path), path)
        let doc = XDocument.Load(path)
        // ADR-0145 added a second UsingTask (GsgenTask) alongside BuildTask,
        // so select the one this test cares about by TaskName rather than
        // assuming BuildTask is the only <UsingTask> declared.
        let usingTask = doc.Descendants(MsbuildNs + "UsingTask").Single(
            (t XElement) -> string(t.Attribute(XName?("TaskName")!!)) == "Gsharp.NET.Sdk.Tools.BuildTask"
        )
        Assert.Equal("$$(GsharpToolFullPath)", string(usingTask.Attribute(XName?("AssemblyFile")!!)))
        let coreCompile XElement? = doc.Descendants(MsbuildNs + "Target").FirstOrDefault(
            (t XElement) -> string(t.Attribute(XName?("Name")!!)) == "CoreCompile"
        )
        Assert.NotNull(coreCompile)
        Assert.Equal("@(GsharpCommandLineArgs)", string(coreCompile!!.Attribute(XName?("Returns")!!)))
        let buildTask XElement? = coreCompile!!.Element(MsbuildNs + "BuildTask")
        Assert.NotNull(buildTask)
        // The BuildTask invocation has to forward the inputs gsc actually
        // consumes; if any of these drop off, consumer builds silently no-op.
        let attrs = buildTask!!.Attributes().ToDictionary(
            func (a XAttribute) string {
                return a.Name.LocalName
            },
            (a XAttribute) -> a.Value
        )
        Assert.Equal("$$(GsharpCompilerFullPath)", attrs["GsharpCompilerFullPath"])
        Assert.Equal("@(Compile)", attrs["Compile"])
        Assert.Equal(
            "@(ReferencePathWithRefAssemblies);@(ReferenceDependencyPaths);@(RuntimeCopyLocalItems)",
            attrs["References"]
        )
        Assert.Equal("@(_GsharpCoreCompileResource)", attrs["Resources"])
        Assert.Equal("$$(OutputType)", attrs["OutputType"])
        Assert.Equal("$$(TargetFramework)", attrs["TargetFramework"])
        Assert.Equal("$$(Optimize)", attrs["Optimization"])
        Assert.Equal("$$(SkipCompilerExecution)", attrs["SkipCompilerExecution"])
        Assert.Equal("$$(ProvideCommandLineArgs)", attrs["ProvideCommandLineArgs"])
        Assert.Contains(
            buildTask!!.Elements(MsbuildNs + "Output"),
            (output XElement) -> string(output.Attribute(XName?("TaskParameter")!!)) == "CommandLineArgs" &&
                string(output.Attribute(XName?("ItemName")!!)) == "GsharpCommandLineArgs"
        )
        // Reference-assembly emit must be forwarded so MSBuild's
        // ProduceReferenceAssembly pipeline (which sets @(IntermediateRefAssembly)
        // to obj/refint/{name}.dll) is honored.
        Assert.Equal("$$(_GsharpRefAssemblyPath)", attrs["RefAssembly"])
        Assert.Contains("@(_CoreCompileResourceInputs)", string(coreCompile!!.Attribute(XName?("Inputs")!!)))
        Assert.Contains(
            coreCompile!!.Descendants(MsbuildNs + "_GsharpCoreCompileResource"),
            (resource XElement) -> (string(resource.Attribute(XName?("Condition")!!)) ?? string.Empty).Contains(
                "WithCulture",
                StringComparison.Ordinal
            )
        )
        let runSettingsTarget = doc.Descendants(MsbuildNs + "Target").Single(
            (t XElement) -> string(t.Attribute(XName?("Name")!!)) == "_GsharpGenerateRunSettings"
        )
        Assert.Equal("CoreCompile;VSTest", string(runSettingsTarget.Attribute(XName?("BeforeTargets")!!)))
        Assert.Equal(
            "$$([MSBuild]::NormalizePath('$$(IntermediateOutputPath)', 'gsharp.generated.runsettings'))",
            doc.Descendants(MsbuildNs + "RunSettingsFilePath").Single().Value
        )
        Assert.Contains(
            runSettingsTarget.Descendants(MsbuildNs + "_GsharpRunSettingsLine"),
            (line XElement) -> line.Attribute(XName?("Include")!!)?.Value.Contains("$$(TargetFramework)") == true
        )
        let compileDesignTime = doc.Descendants(MsbuildNs + "Target").Single(
            (t XElement) -> string(t.Attribute(XName?("Name")!!)) == "CompileDesignTime"
        )
        Assert.Equal("@(_CompilerCommandLineArgs)", string(compileDesignTime.Attribute(XName?("Returns")!!)))
        Assert.Equal(
            "_CheckCompileDesignTimePrerequisite;Compile",
            string(compileDesignTime.Attribute(XName?("DependsOnTargets")!!))
        )
        Assert.Equal(
            "'$$(IsCrossTargetingBuild)' != 'true'",
            string(compileDesignTime.Attribute(XName?("Condition")!!))
        )
        Assert.Contains(
            compileDesignTime.Descendants(MsbuildNs + "_CompilerCommandLineArgs"),
            (item XElement) -> string(item.Attribute(XName?("Include")!!)) == "@(GsharpCommandLineArgs)"
        )
        let prerequisite = doc.Descendants(MsbuildNs + "Target").Single(
            (t XElement) -> string(t.Attribute(XName?("Name")!!)) == "_CheckCompileDesignTimePrerequisite"
        )
        let prerequisiteError XElement? = prerequisite.Element(MsbuildNs + "Error")
        Assert.NotNull(prerequisiteError)
        Assert.Contains(
            "$$(SkipCompilerExecution)|$$(ProvideCommandLineArgs)",
            string(prerequisiteError!!.Attribute(XName?("Condition")!!)),
            StringComparison.Ordinal
        )
        let hotReloadCompile = doc.Descendants(MsbuildNs + "Target").Single(
            (t XElement) -> string(t.Attribute(XName?("Name")!!)) == "_GsharpHotReloadCompile"
        )
        Assert.Equal("Compile", string(hotReloadCompile.Attribute(XName?("DependsOnTargets")!!)))
        Assert.Contains(
            hotReloadCompile.Elements(MsbuildNs + "Copy"),
            (copy XElement) -> string(copy.Attribute(XName?("SourceFiles")!!)) == "@(IntermediateAssembly)"
        )
        let hotReloadBaseline = doc.Descendants(MsbuildNs + "Target").Single(
            (t XElement) -> string(t.Attribute(XName?("Name")!!)) == "_GsharpBuildHotReloadBaseline"
        )
        Assert.Equal("CompileDesignTime", string(hotReloadBaseline.Attribute(XName?("BeforeTargets")!!)))
        let hotReloadBaselineDeletes string? = string(
            hotReloadBaseline.Element(MsbuildNs + "Delete")!!.Attribute(XName?("Files")!!)
        )
        Assert.Contains("@(IntermediateAssembly)", hotReloadBaselineDeletes, StringComparison.Ordinal)
        Assert.Contains(
            "$$(IntermediateOutputPath)$$(AssemblyName)$$(TargetExt)",
            hotReloadBaselineDeletes,
            StringComparison.Ordinal
        )
        Assert.Contains("$$(ProjectDepsFilePath)", hotReloadBaselineDeletes, StringComparison.Ordinal)
        Assert.Contains(
            hotReloadBaseline.Elements(MsbuildNs + "MSBuild"),
            (task XElement) -> string(task.Attribute(XName?("Targets")!!)) == "Build"
        )
        Assert.Contains(
            "RuntimeAssemblyPath=\"$$(GsharpHotReloadRuntimeAssemblyFullPath)\"",
            File.ReadAllText(path),
            StringComparison.Ordinal
        )
        let hotReloadEnabled = doc.Descendants(MsbuildNs + "GsharpEnableHotReload").Single()
        Assert.Contains(
            "$$(DotNetWatchBuild)",
            string(hotReloadEnabled.Attribute(XName?("Condition")!!)),
            StringComparison.Ordinal
        )
        Assert.Contains(
            doc.Descendants(MsbuildNs + "ProjectCapability"),
            (capability XElement) -> string(capability.Attribute(XName?("Include")!!)) == "SupportsHotReload"
        )
        let formatCheck = doc.Descendants(MsbuildNs + "Target").Single(
            (target XElement) -> string(target.Attribute(XName?("Name")!!)) == "GsharpFormatCheck"
        )
        Assert.Equal("CoreCompile", string(formatCheck.Attribute(XName?("BeforeTargets")!!)))
        Assert.Contains("$$(GsharpFormatOnBuild)", string(formatCheck.Attribute(XName?("Condition")!!)))
        let formatCommand string? = string(formatCheck.Element(MsbuildNs + "Exec")!!.Attribute(XName?("Command")!!))
        Assert.Contains("$$(GsharpFormatterFullPath)", formatCommand)
        Assert.Contains("--check", formatCommand)
        Assert.DoesNotContain("--write", formatCommand)
        let hotReloadManifest = doc.Descendants(MsbuildNs + "None").Single(
            (item XElement) -> string(item.Attribute(XName?("Include")!!)) == "$$(GsharpHotReloadManifestPath)"
        )
        Assert.Equal("PreserveNewest", string(hotReloadManifest.Attribute(XName?("CopyToOutputDirectory")!!)))
        Assert.Contains(
            "$$(DesignTimeBuild)",
            string(doc.Descendants(MsbuildNs + "GsharpEnableHotReload").Single().Attribute(XName?("Condition")!!)),
            StringComparison.Ordinal
        )
        Assert.Contains(
            "$$(MSBuildProjectName).manifest",
            doc.Descendants(MsbuildNs + "GsharpHotReloadManifestPath").Single().Value,
            StringComparison.Ordinal
        )
    }

    @Fact
    func Sdk_Props_Enables_ProduceReferenceAssembly() {
        let path = Path.Combine(RepoRoot.SdkSourceDir, "Sdk", "Sdk.props")
        let text = File.ReadAllText(path)
        Assert.Contains("<ProduceReferenceAssembly", text, StringComparison.Ordinal)
        Assert.Contains(">true</ProduceReferenceAssembly>", text, StringComparison.Ordinal)
    }

    @Fact
    func Core_Targets_Pin_HotReload_Watch_Inputs_And_Serialized_Agent_Build() {
        let path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets")
        let doc = XDocument.Load(path)
        let baselineTarget = doc.Descendants(MsbuildNs + "Target").Single(
            (target XElement) -> string(target.Attribute(XName?("Name")!!)) == "_GsharpBuildHotReloadBaseline"
        )
        let baselineBuild = Assert.Single(baselineTarget.Elements(MsbuildNs + "MSBuild"))
        let baselineProperties = (string(baselineBuild.Attribute(XName?("Properties")!!)) ?? string.Empty).Split(
            ';',
            StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries
        )
        Assert.Equal("Build", string(baselineBuild.Attribute(XName?("Targets")!!)))
        Assert.Equal("false", string(baselineBuild.Attribute(XName?("BuildInParallel")!!)))
        Assert.Contains("DotNetWatchBuild=false", baselineProperties)
        Assert.Contains("GsharpEnableHotReload=true", baselineProperties)
        Assert.Contains("BuildProjectReferences=false", baselineProperties)
        let removedProperties = (string(baselineBuild.Attribute(XName?("RemoveProperties")!!)) ?? string.Empty).Split(
            ';',
            StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries
        )
        Assert.Contains("DesignTimeBuild", removedProperties)
        Assert.Contains("SkipCompilerExecution", removedProperties)
        Assert.Contains("ProvideCommandLineArgs", removedProperties)
        Assert.Contains("BuildingInsideVisualStudio", removedProperties)
        let gatedItems = doc.Descendants(MsbuildNs + "ItemGroup").Single(
            (group XElement) -> group.Elements(MsbuildNs + "Reference").Any(
                (item XElement) -> string(item.Attribute(XName?("Include")!!)) == "Gsharp.HotReload.Runtime"
            ) &&
                group
                .Elements(MsbuildNs + "None").Any(
                (item XElement) -> string(item.Attribute(XName?("Include")!!)) == "$$(GsharpHotReloadManifestPath)"
            ) &&
                group
                .Elements(MsbuildNs + "ProjectCapability").Any(
                (item XElement) -> string(item.Attribute(XName?("Include")!!)) == "SupportsHotReload"
            )
        )
        let gatedItemsCondition string? = string(gatedItems.Attribute(XName?("Condition")!!))
        Assert.Contains("'$$(GsharpEnableHotReload)' == 'true'", gatedItemsCondition, StringComparison.Ordinal)
        Assert.Contains("'$$(_GsharpHotReloadSupported)' == 'true'", gatedItemsCondition, StringComparison.Ordinal)
        let prepareTarget = doc.Descendants(MsbuildNs + "Target").Single(
            (target XElement) -> string(target.Attribute(XName?("Name")!!)) == "_GsharpPrepareHotReload"
        )
        let manifestTarget = doc.Descendants(MsbuildNs + "Target").Single(
            (target XElement) -> string(target.Attribute(XName?("Name")!!)) == "_GsharpWriteHotReloadManifest"
        )
        Assert.Contains(
            "'$$(_GsharpHotReloadSupported)' == 'true'",
            string(prepareTarget.Attribute(XName?("Condition")!!)),
            StringComparison.Ordinal
        )
        Assert.DoesNotContain(
            "$$(GsharpEnableHotReload)",
            string(prepareTarget.Attribute(XName?("Condition")!!)),
            StringComparison.Ordinal
        )
        Assert.Contains(
            "'$$(GsharpEnableHotReload)' == 'true'",
            string(manifestTarget.Attribute(XName?("Condition")!!)),
            StringComparison.Ordinal
        )
        Assert.All(
            []XElement{prepareTarget, manifestTarget},
            (target XElement) -> Assert.Equal(
                "@(_GsharpHotReloadWatch)",
                string(
                    Assert.Single(target.Elements(MsbuildNs + "WriteGsharpHotReloadArtifactsTask")).Attribute(
                        XName?("WatchFiles")!!
                    )
                )
            )
        )
        Assert.Equal(
            "$$(_GsharpHotReloadActive)",
            string(
                prepareTarget.Element(MsbuildNs + "WriteGsharpHotReloadArtifactsTask")!!.Attribute(
                    XName?("CopyRuntime")!!
                )
            )
        )
        Assert.Equal(
            "$$(_GsharpHotReloadActive)",
            string(
                prepareTarget.Element(MsbuildNs + "WriteGsharpHotReloadArtifactsTask")!!.Attribute(
                    XName?("WriteBootstrap")!!
                )
            )
        )
        Assert.Equal(
            "true",
            string(
                manifestTarget.Element(MsbuildNs + "WriteGsharpHotReloadArtifactsTask")!!.Attribute(
                    XName?("CopyRuntime")!!
                )
            )
        )
        Assert.Equal(
            "true",
            string(
                manifestTarget.Element(MsbuildNs + "WriteGsharpHotReloadArtifactsTask")!!.Attribute(
                    XName?("WriteBootstrap")!!
                )
            )
        )
        Assert.Equal(
            "@(Compile);@(AdditionalFiles);$$(MSBuildProjectFullPath)",
            string(
                prepareTarget
                    .Descendants(MsbuildNs + "_GsharpHotReloadWatch")
                    .Single((item XElement) -> item.Attribute(XName?("Include")!!) != nil)
                    .Attribute(XName?("Include")!!)
            )
        )
        Assert.Equal(
            "@(Compile);@(_GsharpForeignCompile);@(AdditionalFiles);$$(MSBuildProjectFullPath)",
            string(
                manifestTarget
                    .Descendants(MsbuildNs + "_GsharpHotReloadWatch")
                    .Single((item XElement) -> item.Attribute(XName?("Include")!!) != nil)
                    .Attribute(XName?("Include")!!)
            )
        )
        let filterTarget = doc.Descendants(MsbuildNs + "Target").Single(
            (target XElement) -> string(target.Attribute(XName?("Name")!!)) == "_GsharpFilterHotReloadWatchItems"
        )
        Assert.Contains(
            "_GsharpFilterHotReloadWatchItems",
            doc.Descendants(MsbuildNs + "CustomCollectWatchItems").Single().Value,
            StringComparison.Ordinal
        )
        Assert.Equal(
            "@(Compile)",
            string(filterTarget.Descendants(MsbuildNs + "Compile").Single().Attribute(XName?("Remove")!!))
        )
        Assert.Equal(
            "@(AdditionalFiles)",
            string(filterTarget.Descendants(MsbuildNs + "AdditionalFiles").Single().Attribute(XName?("Remove")!!))
        )
        Assert.Equal(
            "@(_GsharpAgentOwnedWatch)",
            string(filterTarget.Descendants(MsbuildNs + "Watch").Single().Attribute(XName?("Remove")!!))
        )
        let agentPath = RepoRoot.ResolveSourcePath(
            Path.GetFullPath(Path.Combine(RepoRoot.SdkSourceDir, "..", "Gsharp.HotReload.Runtime", "HotReloadAgent.cs"))
        )
        let agentText = File.ReadAllText(agentPath)
        // Declaration order differs between the C# and G# spellings of this
        // file (`SemaphoreSlim updateGate` vs `updateGate SemaphoreSlim`), so
        // assert on the two tokens rather than on one language's word order.
        Assert.Contains("SemaphoreSlim", agentText, StringComparison.Ordinal)
        Assert.Contains("updateGate", agentText, StringComparison.Ordinal)
        Assert.DoesNotContain("-p:IntermediateOutputPath=", agentText, StringComparison.Ordinal)
        Assert.DoesNotContain("-p:OutputPath=", agentText, StringComparison.Ordinal)
        Assert.DoesNotContain("-p:DotNetWatchBuild=true", agentText, StringComparison.Ordinal)
    }

    @Fact
    func Sdk_Props_Excludes_LanguageServer_Cache_From_Default_Items() {
        let path = Path.Combine(RepoRoot.SdkSourceDir, "Sdk", "Sdk.props")
        let doc = XDocument.Load(path)
        let elements = doc.Root!!.Elements().ToList()
        let excludes = elements
            .TakeWhile((element XElement) -> element.Name.LocalName != "Import")
            .Descendants(MsbuildNs + "DefaultItemExcludes")
            .Single()
        Assert.Contains("**/*.gsproj.lscache", excludes.Value, StringComparison.Ordinal)
        let hiddenCache = doc.Descendants(MsbuildNs + "None").Single(
            (item XElement) -> string(item.Attribute(XName?("Include")!!)) == "**/*.gsproj.lscache"
        )
        Assert.Equal("false", string(hiddenCache.Attribute(XName?("Visible")!!)))
    }

    @Fact
    func Sdk_Csproj_Packs_As_MSBuildSdk() {
        let csproj = SdkProjectPath
        Assert.True(File.Exists(csproj), csproj)
        let text = File.ReadAllText(csproj)
        // The SDK must ship its tools (gsc + build task) and propsfiles
        // alongside Sdk.props/Sdk.targets so msbuild can resolve it.
        Assert.Contains("netstandard2.0", text, StringComparison.Ordinal)
        Assert.Contains("Microsoft.Build.Framework", text, StringComparison.Ordinal)
        Assert.Contains("Microsoft.Build.Utilities.Core", text, StringComparison.Ordinal)
        Assert.Contains("tools\\hotreload\\", text, StringComparison.Ordinal)
        Assert.Contains("Gsharp.HotReload.Runtime.dll", text, StringComparison.Ordinal)
        // ADR-0174 D1: the channel runtime ships under tools/channels/.
        Assert.Contains("tools\\channels\\", text, StringComparison.Ordinal)
        Assert.Contains("Gsharp.Runtime.Channels.dll", text, StringComparison.Ordinal)
    }

    @Fact
    func Sdk_Csproj_Uses_BuildOnly_Channels_Runtime_Reference_And_Packs_Runtime() {
        // ADR-0174 D1: mirrors the hot-reload runtime wiring — build-only
        // ProjectReference for ordering, a pack target under tools/channels/.
        let path = SdkProjectPath
        let doc = XDocument.Load(path)
        let runtimeReference = doc.Descendants("ProjectReference").Single(
            (reference XElement) -> ReferencesProject(reference, "Gsharp.Runtime.Channels")
        )
        Assert.Equal("false", string(runtimeReference.Attribute(XName?("Private")!!)))
        Assert.Equal("false", string(runtimeReference.Attribute(XName?("ReferenceOutputAssembly")!!)))
        Assert.Equal("true", string(runtimeReference.Attribute(XName?("SkipGetTargetFrameworkProperties")!!)))
        let runtimeTarget = doc.Descendants("Target").Single(
            (target XElement) -> string(target.Attribute(XName?("Name")!!)) == "PackGsharpChannelsRuntime"
        )
        Assert.Equal("_GetPackageFiles", string(runtimeTarget.Attribute(XName?("BeforeTargets")!!)))
        Assert.Equal("Build", string(runtimeTarget.Attribute(XName?("DependsOnTargets")!!)))
        let runtimePayload = runtimeTarget.Descendants("None").Single(
            (item XElement) -> string(item.Attribute(XName?("Include")!!)) == "@(_GsharpChannelsRuntimePayload)"
        )
        Assert.Equal("true", string(runtimePayload.Attribute(XName?("Pack")!!)))
        Assert.Equal("tools\\channels\\", string(runtimePayload.Attribute(XName?("PackagePath")!!)))
    }

    @Fact
    func Sdk_Props_AutoReferences_Channels_Runtime_Like_Extensions() {
        // ADR-0174 D1: unlike hot reload (opt-in <Reference>), the channel
        // runtime rides the same unconditional _ExplicitReference channel as
        // Gsharp.Extensions so it reaches gsc's /r: list for every consumer.
        let path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Sdk.props")
        let doc = XDocument.Load(path)
        let references = doc
            .Descendants(MsbuildNs + "_ExplicitReference")
            .Select((item XElement) -> string(item.Attribute(XName?("Include")!!)))
            .ToList()
        Assert.Contains("$$(GsharpExtensionsAssemblyFullPath)", references)
        Assert.Contains("$$(GsharpChannelsRuntimeAssemblyFullPath)", references)
        let property = doc.Descendants(MsbuildNs + "GsharpChannelsRuntimeAssemblyFullPath").Single()
        Assert.Contains("tools\\channels\\Gsharp.Runtime.Channels.dll", property.Value, StringComparison.Ordinal)
    }

    @Fact
    func Sdk_Csproj_Uses_BuildOnly_HotReload_Runtime_Reference_And_Packs_Runtime() {
        let path = SdkProjectPath
        let doc = XDocument.Load(path)
        let runtimeReference = doc.Descendants("ProjectReference").Single(
            (reference XElement) -> ReferencesProject(reference, "Gsharp.HotReload.Runtime")
        )
        Assert.Equal("false", string(runtimeReference.Attribute(XName?("Private")!!)))
        Assert.Equal("false", string(runtimeReference.Attribute(XName?("ReferenceOutputAssembly")!!)))
        Assert.Equal("true", string(runtimeReference.Attribute(XName?("SkipGetTargetFrameworkProperties")!!)))
        let runtimeTarget = doc.Descendants("Target").Single(
            (target XElement) -> string(target.Attribute(XName?("Name")!!)) == "PackGsharpHotReloadRuntime"
        )
        Assert.Equal("_GetPackageFiles", string(runtimeTarget.Attribute(XName?("BeforeTargets")!!)))
        Assert.Equal("Build", string(runtimeTarget.Attribute(XName?("DependsOnTargets")!!)))
        let runtimePayload = runtimeTarget.Descendants("None").Single(
            (item XElement) -> string(item.Attribute(XName?("Include")!!)) == "@(_GsharpHotReloadRuntimePayload)"
        )
        Assert.Equal("true", string(runtimePayload.Attribute(XName?("Pack")!!)))
        Assert.Equal("tools\\hotreload\\", string(runtimePayload.Attribute(XName?("PackagePath")!!)))
    }

    @Fact
    func Core_Targets_Forwards_Phase6_And_Phase7_BuildTask_Attributes() {
        let path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets")
        let doc = XDocument.Load(path)
        let buildTask XElement? = doc
            .Descendants(MsbuildNs + "Target")
            .First((t XElement) -> string(t.Attribute(XName?("Name")!!)) == "CoreCompile")
            .Element(MsbuildNs + "BuildTask")
        let attrs = buildTask!!.Attributes().ToDictionary(
            func (a XAttribute) string {
                return a.Name.LocalName
            },
            (a XAttribute) -> a.Value
        )
        // Phase 8 wiring: the four debug-information-shaped MSBuild properties
        // must all reach the task, else consumer projects can't control
        // SourceLink / embed / determinism without command-line workarounds.
        Assert.Equal("$$(DebugType)", attrs["DebugType"])
        Assert.Equal("@(_DebugSymbolsIntermediatePath)", attrs["PdbFile"])
        Assert.Equal("$$(SourceLink)", attrs["SourceLink"])
        Assert.Equal("$$(EmbedAllSources)", attrs["EmbedAllSources"])
        Assert.Equal("$$(Deterministic)", attrs["Deterministic"])
    }

    @Fact
    func Core_Targets_Adds_Sidecar_Pdb_To_FileWrites() {
        let path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets")
        let doc = XDocument.Load(path)
        let fileWrites = doc
            .Descendants(MsbuildNs + "FileWrites")
            .Where(
            (fw XElement) -> (string(fw.Attribute(XName?("Include")!!)) ?? string.Empty).Contains(
                "_DebugSymbolsIntermediatePath",
                StringComparison.Ordinal
            )
        )
            .ToList()
        Assert.Single(fileWrites)
        // The PDB FileWrites entry must be gated so Clean / incremental skips
        // it when no sidecar is produced (DebugType=embedded/none/empty).
        let condition string? = string(fileWrites[0].Attribute(XName?("Condition")!!))
        Assert.NotNull(condition)
        Assert.Contains("'$$(DebugType)' != 'embedded'", condition, StringComparison.Ordinal)
        Assert.Contains("'$$(DebugType)' != 'none'", condition, StringComparison.Ordinal)
    }

    @Fact
    func Core_Targets_Declares_GenerateMSBuildEditorConfigFileShouldRun_Hook() {
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
        let path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets")
        let doc = XDocument.Load(path)
        let hook XElement? = doc.Descendants(MsbuildNs + "Target").FirstOrDefault(
            (t XElement) -> string(t.Attribute(XName?("Name")!!)) == "GenerateMSBuildEditorConfigFileShouldRun"
        )
        Assert.NotNull(hook)
        let runGenerators = doc.Descendants(MsbuildNs + "Target").First(
            (t XElement) -> string(t.Attribute(XName?("Name")!!)) == "_GsharpRunSourceGenerators"
        )
        let dependsOn = (string(runGenerators.Attribute(XName?("DependsOnTargets")!!))).Split(
            ';',
            StringSplitOptions.RemoveEmptyEntries
        )
        Assert.Contains("GenerateMSBuildEditorConfigFileShouldRun", dependsOn)
    }

    @Fact
    func Core_Targets_Computes_Standard_Manifest_Resource_Names() {
        let path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets")
        let doc = XDocument.Load(path)
        let target = doc.Descendants(MsbuildNs + "Target").Single(
            (t XElement) -> string(t.Attribute(XName?("Name")!!)) == "CreateManifestResourceNames"
        )
        let namingTasks = target.Elements(MsbuildNs + "CreateCSharpManifestResourceName").ToList()
        Assert.Equal(2, namingTasks.Count)
        Assert.All(
            namingTasks,
            (task XElement) -> Assert.Equal("$$(RootNamespace)", string(task.Attribute(XName?("RootNamespace")!!)))
        )
        Assert.All(
            namingTasks,
            (task XElement) -> Assert.Equal(
                "_Temporary",
                string(task.Element(MsbuildNs + "Output")?.Attribute(XName?("ItemName")!!))
            )
        )
        Assert.Contains(
            target.Descendants(MsbuildNs + "EmbeddedResource"),
            (item XElement) -> string(item.Attribute(XName?("Include")!!)) == "@(_Temporary)"
        )
    }

    @Fact
    func Core_Targets_Declares_AfterCompile_Hook_In_CompileDependsOn() {
        let path = Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets")
        let doc = XDocument.Load(path)
        Assert.Contains(
            doc.Descendants(MsbuildNs + "Target"),
            (target XElement) -> string(target.Attribute(XName?("Name")!!)) == "AfterCompile"
        )
        Assert.Contains(
            doc.Descendants(MsbuildNs + "CompileDependsOn"),
            (property XElement) -> property.Value.Contains("AfterCompile", StringComparison.Ordinal)
        )
    }

    shared {
        private let MsbuildNs XNamespace? = "http://schemas.microsoft.com/developer/msbuild/2003"
        private prop SdkProjectPath string -> RepoRoot.ResolveSourcePath(
            Path.Combine(RepoRoot.SdkSourceDir, "Gsharp.NET.Sdk.csproj")
        )

        /// Matches a `ProjectReference` that points at
        /// `<projectName>/<projectName>`, tolerating both path
        /// separators and both project-file extensions. The cs2gs self-migration
        /// corpus rewrites these references to `.gsproj` with forward slashes,
        /// and the assertion is about the reference's target, not its spelling.
        /// @param reference The `ProjectReference` element.
        /// @param projectName The referenced project's directory and base file name.
        /// @returns `true` when the reference targets that project.
        private func ReferencesProject(reference XElement, projectName string) bool {
            let include = (string(reference.Attribute(XName?("Include")!!)) ?? string.Empty).Replace('\\', '/')
            let stem = projectName + "/" + projectName + "."
            return include.EndsWith(stem + "csproj", StringComparison.Ordinal) || include.EndsWith(
                stem + "gsproj",
                StringComparison.Ordinal
            )
        }
    }
}
