// <copyright file="SdkCompileRunnerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Threading.Tasks
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Xunit
import System.Text.RegularExpressions
import System.Xml.Linq

/// Unit tests for (cref:SdkCompileRunner)'s pure reference-partitioning
/// logic (issue #2261): reconstructing `PackageReference` id/version pairs
/// from NuGet packages-cache paths, deduping on id with higher-version-wins,
/// and dropping shared-framework assemblies. These are safely testable without
/// a live NuGet cache or a real `dotnet build`; the SDK-availability and
/// end-to-end build paths are covered by the cs2gs pipeline's own corpus runs.
open class SdkCompileRunnerTests {
    @Fact
    func PartitionReferences_ReconstructsPackageReference_FromNugetPackagesRootPath() {
        let references = []string{PackagesRoot + "/communitytoolkit.mvvm/8.4.0/lib/net8.0/CommunityToolkit.Mvvm.dll"}
        let (packages, loose) = SdkCompileRunner.PartitionReferences(references, PackagesRoot, RuntimeDir)
        let (id, version) = Assert.Single(packages)
        Assert.Equal("communitytoolkit.mvvm", id)
        Assert.Equal("8.4.0", version)
        Assert.Empty(loose)
    }

    @Fact
    func PartitionReferences_HonorsNugetPackagesEnvOverride_ForRootDetection() {
        const CustomRoot = "/ci/nuget-cache"
        let references = []string{CustomRoot + "/serilog/3.1.1/lib/net8.0/Serilog.dll"}
        let (packages, loose) = SdkCompileRunner.PartitionReferences(references, CustomRoot, RuntimeDir)
        let (id, version) = Assert.Single(packages)
        Assert.Equal("serilog", id)
        Assert.Equal("3.1.1", version)
        Assert.Empty(loose)
    }

    @Theory
    @InlineData("lib")
    @InlineData("ref")
    @InlineData("analyzers")
    @InlineData("runtimes")
    @InlineData("build")
    @InlineData("buildTransitive")
    @InlineData("contentFiles")
    func PartitionReferences_RecognizesGenericPackagesShape_ForAnyKnownAssetDirectory(assetDir string) {
        let path = "/some/other/cache/packages/spectre.console/0.49.1/" + assetDir + "/net8.0/Spectre.Console.dll"
        let package_ = SdkCompileRunner.TryParsePackageFromPath(path, nugetPackagesRoot: nil)
        Assert.NotNull(package_)
        Assert.Equal("spectre.console", package_!!.Id)
        Assert.Equal("0.49.1", package_!!.Version)
    }

    @Fact
    func PartitionReferences_DedupsById_KeepingHigherVersion() {
        let references = []string{
            PackagesRoot + "/communitytoolkit.mvvm/8.2.0/lib/net8.0/CommunityToolkit.Mvvm.dll",
            PackagesRoot + "/communitytoolkit.mvvm/8.4.0/lib/net8.0/CommunityToolkit.Mvvm.dll",
            PackagesRoot + "/communitytoolkit.mvvm/8.3.0-preview.1/lib/net8.0/CommunityToolkit.Mvvm.dll"
        }
        let (packages, loose) = SdkCompileRunner.PartitionReferences(references, PackagesRoot, RuntimeDir)
        let (id, version) = Assert.Single(packages)
        Assert.Equal("communitytoolkit.mvvm", id)
        Assert.Equal("8.4.0", version)
        Assert.Empty(loose)
    }

    @Fact
    func PartitionReferences_SkipsSharedFrameworkAssemblies_ByFileName() {
        let references = []string{
            RuntimeDir + "/System.Private.CoreLib.dll",
            "/some/other/place/System.Private.CoreLib.dll"
        }
        using let runtimeDir = TempRuntimeDir.WithFakeAssembly("System.Private.CoreLib.dll")
        let (packages, loose) = SdkCompileRunner.PartitionReferences(references, PackagesRoot, runtimeDir.Path)
        Assert.Empty(packages)
        Assert.Empty(loose)
    }

    @Fact
    func PartitionReferences_KeepsLooseSiblingReferences_Unpartitioned() {
        let references = []string{"/repo/out/bin/Release/SomeLib/SomeLib.dll"}
        let (packages, loose) = SdkCompileRunner.PartitionReferences(references, PackagesRoot, RuntimeDir)
        Assert.Empty(packages)
        let reference = Assert.Single(loose)
        Assert.Equal("/repo/out/bin/Release/SomeLib/SomeLib.dll", reference)
    }

    @Fact
    func TryParsePackageFromPath_ReturnsNull_ForNonCachePath() {
        let package_ = SdkCompileRunner.TryParsePackageFromPath(
            "/repo/out/bin/Release/SomeLib/SomeLib.dll",
            PackagesRoot
        )
        Assert.Null(package_)
    }

    @Fact
    func BuildProjectXml_EmitsDeclaredNerdbankGitVersioningPackageReference_WithBumpedVersionAndPrivateAssets() {
        // Issue #2267: nbgv is a build/dev-only dependency (PrivateAssets=all, no
        // lib/ DLL) so it contributes no compile-time reference DLL for the
        // `packages` reconstruction to recover. When the source project declared
        // it (captured as a DeclaredPackageReference by the Translate stage),
        // BuildProjectXml must still emit it as a real <PackageReference> so
        // nbgv's ThisAssembly MSBuild generator runs under `dotnet build`.
        let declared = []DeclaredPackageReference{
            DeclaredPackageReference(
                NerdbankGitVersioningPolicy.PackageId,
                NerdbankGitVersioningPolicy.MinimumGSharpVersion,
                privateAssets: "all"
            )
        }
        let xml = SdkCompileRunner.BuildProjectXml(
            sdkVersion: "1.0.0",
            target: TargetKind.Exe,
            rootNamespace: nil,
            gsFilePaths: []string{"/app/Program.gs"},
            packages: Array.Empty[(Id string, Version string)](),
            references: Array.Empty[string](),
            analyzerReferences: Array.Empty[string](),
            declaredPackageReferences: declared
        )
        Assert.Contains(
            "<PackageReference Include=\"Nerdbank.GitVersioning\" Version=\"3.11.13-beta\" PrivateAssets=\"all\" />",
            xml
        )
    }

    @Fact
    func BuildProjectXml_OmitsVersionOnDeclaredNbgvPackageReference_WhenCentralPackageManagementIsUsed() {
        // Issue #2319: under CPM the version comes exclusively from the copied
        // Directory.Packages.props's <PackageVersion> item. A Version=
        // attribute on the generated <PackageReference> as well is rejected by
        // NuGet's CPM validation (NU1008), so BuildProjectXml must omit it here.
        let declared = []DeclaredPackageReference{
            DeclaredPackageReference(
                NerdbankGitVersioningPolicy.PackageId,
                NerdbankGitVersioningPolicy.MinimumGSharpVersion,
                privateAssets: "all"
            )
        }
        let xml = SdkCompileRunner.BuildProjectXml(
            sdkVersion: "1.0.0",
            target: TargetKind.Exe,
            rootNamespace: nil,
            gsFilePaths: []string{"/app/Program.gs"},
            packages: Array.Empty[(Id string, Version string)](),
            references: Array.Empty[string](),
            analyzerReferences: Array.Empty[string](),
            declaredPackageReferences: declared,
            usesCentralPackageManagement: true
        )
        Assert.Contains("<PackageReference Include=\"Nerdbank.GitVersioning\" PrivateAssets=\"all\" />", xml)
        Assert.DoesNotContain("Version=", xml)
    }

    @Fact
    func BuildProjectXml_OmitsVersionOnReconstructedPackage_WhenCentralPackageManagementIsUsed() {
        // Issue #2319: the same Version= suppression must apply to the
        // DLL-reconstructed `packages` set, not just the declared build-only
        // set, so BuildProjectXml stays internally consistent whenever CPM
        // governs the generated app (even though in the real --via-sdk
        // CompileStage call shape `packages` is always empty once declared
        // PackageReference items are present).
        let xml = SdkCompileRunner.BuildProjectXml(
            sdkVersion: "1.0.0",
            target: TargetKind.Library,
            rootNamespace: nil,
            gsFilePaths: []string{"/app/Lib.gs"},
            packages: List[(Id string, Version string)]{("communitytoolkit.mvvm", "8.4.0")},
            references: Array.Empty[string](),
            analyzerReferences: Array.Empty[string](),
            declaredPackageReferences: Array.Empty[DeclaredPackageReference](),
            usesCentralPackageManagement: true
        )
        Assert.Contains("<PackageReference Include=\"communitytoolkit.mvvm\" />", xml)
        Assert.DoesNotContain("Version=", xml)
    }

    @Fact
    func BuildProjectXml_DoesNotDuplicateDeclaredPackage_WhenAlreadyReconstructedFromDll() {
        // A package that DID resolve a compile-time DLL is already fully
        // represented in `packages`; the caller (SdkCompileRunner.Compile) filters
        // it out of `declaredPackageReferences` before calling BuildProjectXml, but
        // BuildProjectXml itself renders both lists as given, so this test locks
        // in that contract at the call-site level via the public Compile-adjacent
        // helper: rendering the same id twice must not happen when the caller
        // only passes the DLL-less declared set (the realistic call shape).
        let xml = SdkCompileRunner.BuildProjectXml(
            sdkVersion: "1.0.0",
            target: TargetKind.Library,
            rootNamespace: nil,
            gsFilePaths: []string{"/app/Lib.gs"},
            packages: List[(Id string, Version string)]{("communitytoolkit.mvvm", "8.4.0")},
            references: Array.Empty[string](),
            analyzerReferences: Array.Empty[string](),
            declaredPackageReferences: Array.Empty[DeclaredPackageReference]()
        )
        Assert.Contains("<PackageReference Include=\"communitytoolkit.mvvm\" Version=\"8.4.0\" />", xml)
        Assert.Single(Regex.Matches(xml, "<PackageReference"))
    }

    @Fact
    func BuildProjectXml_ExcludesRuntimeAssetsForReconstructedMicrosoftBuildFramework() {
        let xml = SdkCompileRunner.BuildProjectXml(
            sdkVersion: "1.0.0",
            target: TargetKind.Exe,
            rootNamespace: nil,
            gsFilePaths: []string{"/app/Program.gs"},
            packages: List[(Id string, Version string)]{("microsoft.build.framework", "17.11.48")},
            references: Array.Empty[string](),
            analyzerReferences: Array.Empty[string]()
        )
        Assert.Contains(
            "<PackageReference Include=\"microsoft.build.framework\" Version=\"17.11.48\" ExcludeAssets=\"runtime\" />",
            xml
        )
    }

    @Fact
    func FindEmittedAssembly_UsesSourceAssemblyNameAndNeverFallsBackToDependency() {
        let directory = Path.Combine(
            Environment.CurrentDirectory,
            "artifacts",
            "sdk-assembly-probe-" + Guid.NewGuid().ToString("N")
        )
        try {
            let bin = Path.Combine(directory, "bin", "Release", "net10.0")
            Directory.CreateDirectory(bin)
            File.WriteAllText(Path.Combine(bin, "Dependency.dll"), string.Empty)
            let expected = Path.Combine(bin, "gsi.dll")
            File.WriteAllText(expected, string.Empty)
            Assert.Equal(expected, SdkCompileRunner.FindEmittedAssembly(directory, "Repl", "Release", "gsi"))
            File.Delete(expected)
            Assert.Null(SdkCompileRunner.FindEmittedAssembly(directory, "Repl", "Release", "gsi"))
        } finally {
            if Directory.Exists(directory) {
                Directory.Delete(directory, recursive: true)
            }
        }
    }

    @Fact
    func ReconstructedPackages_SurviveProjectReferences_AndClearForPackageReferences() {
        let packages = List[(Id string, Version string)]{("example", "1.0.0")}
        let projectReferences = []DeclaredProjectItem{
            DeclaredProjectItem(nil, XElement.Parse("<ProjectReference Include=\"../Lib/Lib.csproj\" />"))
        }
        let xml = SdkCompileRunner.BuildProjectXml(
            sdkVersion: "1.0.0",
            target: TargetKind.Library,
            rootNamespace: nil,
            gsFilePaths: []string{"Program.gs"},
            packages,
            references: Array.Empty[string](),
            analyzerReferences: Array.Empty[string](),
            projectReferences: projectReferences
        )
        Assert.Contains("<PackageReference Include=\"example\" Version=\"1.0.0\" />", xml)
        Assert.Contains("<ProjectReference Include=\"../Lib/Lib.csproj\" />", xml)
        SdkCompileRunner.ApplyDeclaredPackageReferencePolicy(
            packages,
            []DeclaredProjectItem{DeclaredProjectItem(nil, XElement.Parse("<PackageReference Include=\"Example\" />"))}
        )
        Assert.Empty(packages)
    }

    @Fact
    func BuildProjectXml_EmitsCapturedSourceAssemblyName() {
        let xml = SdkCompileRunner.BuildProjectXml(
            sdkVersion: "1.0.0",
            target: TargetKind.Library,
            rootNamespace: nil,
            gsFilePaths: []string{"Program.gs"},
            packages: Array.Empty[(Id string, Version string)](),
            references: Array.Empty[string](),
            analyzerReferences: Array.Empty[string](),
            assemblyName: "gsi"
        )
        Assert.Contains("<AssemblyName>gsi</AssemblyName>", xml)
    }

    @Fact
    func IsRepresentedByProjectReference_MissingAssemblyFallsBackToFileName() {
        let missingAssembly = Path.Combine(Environment.CurrentDirectory, "artifacts", "Missing.Project.dll")
        let projectReferences = []DeclaredProjectItem{
            DeclaredProjectItem(
                nil,
                XElement.Parse("<ProjectReference Include=\"Missing.Project.csproj\" />"),
                sourceAssemblyName: "Missing.Project"
            )
        }
        Assert.True(SdkCompileRunner.IsRepresentedByProjectReferenceForTest(missingAssembly, projectReferences))
    }

    @Theory
    @InlineData("/usr/share/dotnet/sdk/10.0/Sdks/Microsoft.NET.Sdk.Razor/source-generators/Razor.dll", false)
    @InlineData("C:\\dotnet\\sdk\\10.0\\Sdks\\Microsoft.NET.Sdk.Razor\\source-generators\\Razor.dll", false)
    @InlineData("/packages/example/analyzers/dotnet/cs/Generator.dll", true)
    func ShouldForwardAnalyzer_SkipsRazorSdkGenerators(path string, expected bool) {
        Assert.Equal(expected, TranslateStage.ShouldForwardAnalyzer(path))
    }

    @Fact
    func BuildProjectXml_PreservesRootNamespaceAndAvaloniaXamlItems() {
        let xml = SdkCompileRunner.BuildProjectXml(
            sdkVersion: "1.0.0",
            target: TargetKind.Library,
            rootNamespace: "Oahu.Core.UI.Avalonia",
            gsFilePaths: []string{"/migration/BookLibraryView_axaml.gs"},
            packages: List[(Id string, Version string)]{("avalonia", "11.2.7")},
            references: Array.Empty[string](),
            analyzerReferences: Array.Empty[string](),
            additionalFiles: []string{"/source/Views/BookLibraryView.axaml;SourceItemGroup=AvaloniaXaml"}
        )
        Assert.Contains("<RootNamespace>Oahu.Core.UI.Avalonia</RootNamespace>", xml)
        Assert.Contains("<AvaloniaXaml Include=\"/source/Views/BookLibraryView.axaml\" />", xml)
    }

    @Fact
    func BuildProjectXml_PreservesDeclaredDependencyMetadataAndConditions() {
        let packages = []DeclaredProjectItem{
            DeclaredProjectItem(
                "'$$(TargetFramework)' == 'net10.0'",
                XElement.Parse(
                    "<PackageReference Include=\"Example\" Version=\"1.2.3\" " +
                        "PrivateAssets=\"all\"><Aliases>sample</Aliases></PackageReference>"
                )
            )
        }
        let projects = []DeclaredProjectItem{
            DeclaredProjectItem(
                nil,
                XElement.Parse(
                    "<ProjectReference Include=\"../Lib/Lib.gsproj\" " +
                        "ReferenceOutputAssembly=\"false\"><Private>true</Private></ProjectReference>"
                )
            )
        }
        let xml = SdkCompileRunner.BuildProjectXml(
            sdkVersion: "1.0.0",
            target: TargetKind.Library,
            rootNamespace: nil,
            gsFilePaths: []string{"Lib.gs"},
            packages: Array.Empty[(Id string, Version string)](),
            references: Array.Empty[string](),
            analyzerReferences: Array.Empty[string](),
            packageReferences: packages,
            projectReferences: projects
        )
        Assert.Contains("<ItemGroup Condition=\"'$$(TargetFramework)' == 'net10.0'\">", xml)
        Assert.Contains(
            "<PackageReference Include=\"Example\" Version=\"1.2.3\" PrivateAssets=\"all\"><Aliases>sample</Aliases></PackageReference>",
            xml
        )
        Assert.Contains(
            "<ProjectReference Include=\"../Lib/Lib.gsproj\" ReferenceOutputAssembly=\"false\"><Private>true</Private></ProjectReference>",
            xml
        )
    }

    @Fact
    func RequiresExplicitProjectItem_UsesDefaultGlobForCopiedAvaloniaXaml() {
        Assert.False(
            SdkCompileRunner.RequiresExplicitProjectItem(
                "/migration/Oahu.UI",
                "/migration/Oahu.UI/Views/BookLibraryView.axaml;SourceItemGroup=AvaloniaXaml"
            )
        )
        Assert.True(
            SdkCompileRunner.RequiresExplicitProjectItem(
                "/migration/Oahu.UI",
                "/source/Oahu.UI/Views/BookLibraryView.axaml;SourceItemGroup=AvaloniaXaml"
            )
        )
    }

    @Fact
    func WriteIsolationBoundary_PreservesCopiedProjectBuildFiles() {
        let directory = Path.Combine(
            Directory.GetCurrentDirectory(),
            "sdkcompilerunnertests-isolation-" + Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        let propsPath = Path.Combine(directory, "Directory.Build.props")
        const Props = "<Project><PropertyGroup><Custom>true</Custom></PropertyGroup></Project>"
        File.WriteAllText(propsPath, Props)
        try {
            GsharpTestProjectRunner.WriteIsolationBoundary(directory)
            Assert.Equal(Props, File.ReadAllText(propsPath))
            Assert.True(File.Exists(Path.Combine(directory, "Directory.Build.targets")))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func ParseRelayedGsErrors_ParsesTargetsRelayedError_WithTrailingProjectSuffix() {
        const Output = "Determining projects to restore...\n" +
            "/Users/dev/.nuget-packages/gsharp.net.sdk/1.2.3/build/Gsharp.NET.Core.Sdk.targets(505,5): " +
            "error GS9998: TypeLoadException: Could not load type 'X'. [/Users/dev/out/App.gsproj]\n" +
            "Build FAILED.\n"
        let diagnostics = SdkCompileRunner.ParseRelayedGsErrors(Output)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS9998", diagnostic.Id)
        Assert.Equal("TypeLoadException: Could not load type 'X'. [/Users/dev/out/App.gsproj]", diagnostic.Message)
        Assert.Equal("error", diagnostic.Severity)
        Assert.Equal(
            "/Users/dev/.nuget-packages/gsharp.net.sdk/1.2.3/build/Gsharp.NET.Core.Sdk.targets",
            diagnostic.File
        )
        Assert.Equal(505, diagnostic.Line)
        Assert.Equal(5, diagnostic.Column)
    }

    @Fact
    func ParseRelayedGsErrors_ParsesGsgenAnchoredError() {
        const Output = "gsgen(1,1): error GS9200: Type must be a type provided by the runtime. (Parameter 'elementType')\n"
        let diagnostics = SdkCompileRunner.ParseRelayedGsErrors(Output)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS9200", diagnostic.Id)
        Assert.Equal("Type must be a type provided by the runtime. (Parameter 'elementType')", diagnostic.Message)
        Assert.Equal("gsgen", diagnostic.File)
        Assert.Equal(1, diagnostic.Line)
        Assert.Equal(1, diagnostic.Column)
    }

    @Fact
    func ParseRelayedGsErrors_DeduplicatesIdenticalRepeatedLines() {
        // MSBuild prints each error once inline and again in the final
        // "Build FAILED" summary — the harness must not double-report it.
        const ErrorLine = "/sdk/build/Gsharp.NET.Core.Sdk.targets(505,5): error GS9998: TypeLoadException: boom. [/out/App.gsproj]"
        const Output = ErrorLine +
            "\n" +
            "gsgen(1,1): error GS9200: Type must be a type provided by the runtime.\n" +
            "Build FAILED.\n" +
            "    " +
            ErrorLine +
            "\n" +
            "gsgen(1,1): error GS9200: Type must be a type provided by the runtime.\n"
        let diagnostics = SdkCompileRunner.ParseRelayedGsErrors(Output)
        Assert.Equal(2, diagnostics.Count)
        Assert.Equal("GS9998", diagnostics[0].Id)
        Assert.Equal("GS9200", diagnostics[1].Id)
    }

    @Fact
    func ParseRelayedGsErrors_ParsesLocationlessErrorLine_WithBestEffortLocation() {
        let diagnostics = SdkCompileRunner.ParseRelayedGsErrors("error GS9200: something went wrong\n")
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS9200", diagnostic.Id)
        Assert.Equal("something went wrong", diagnostic.Message)
        Assert.Equal("unknown", diagnostic.File)
        Assert.Equal(1, diagnostic.Line)
        Assert.Equal(1, diagnostic.Column)
    }

    @Fact
    func ParseRelayedGsErrors_ReturnsEmpty_ForGenuinelyUnparseableOutput() {
        // No GSxxxx error line at all: the caller keeps the synthetic GS9999
        // fallback as the true last resort.
        const Output = "MSBUILD : error MSB1009: Project file does not exist.\n" +
            "/src/App.cs(3,1): error CS0246: The type or namespace name 'Foo' could not be found\n" +
            "/src/App.gs(3,1,3,4): warning GS0100: not an error\n" +
            "Build FAILED.\n"
        Assert.Empty(SdkCompileRunner.ParseRelayedGsErrors(Output))
        Assert.Empty(SdkCompileRunner.ParseRelayedGsErrors(string.Empty))
        Assert.Empty(SdkCompileRunner.ParseRelayedGsErrors(nil))
    }

    @Fact
    func ParseRelayedBuildErrors_ParsesMsBuildTaskError() {
        // Issue #3672: the exact shape that walled four selfmig apps behind an
        // opaque GS9999 — one MSB3202 line buried under ~80 warning lines.
        const Output = "/migrated/build/gsharp.props(24,5): warning : Gsharp project does not exist: '/migrated/src/Core/Core.csproj'\n" +
            "  Gsharp.NET.Sdk -> /migrated/out/bin/Release/Gsharp.NET.Sdk/Gsharp.NET.Sdk.dll\n" +
            "/migrated/src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj(104,5): error MSB3202: " +
            "The project file \"/migrated/src/Compiler/Compiler.csproj\" was not found.\n" +
            "Build FAILED.\n"
        let diagnostics = SdkCompileRunner.ParseRelayedBuildErrors(Output)
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("MSB3202", diagnostic.Id)
        Assert.Equal("The project file \"/migrated/src/Compiler/Compiler.csproj\" was not found.", diagnostic.Message)
        Assert.Equal("error", diagnostic.Severity)
        Assert.Equal("/migrated/src/Sdk/Gsharp.NET.Sdk/Gsharp.NET.Sdk.gsproj", diagnostic.File)
        Assert.Equal(104, diagnostic.Line)
        Assert.Equal(5, diagnostic.Column)
    }

    @Fact
    func ParseRelayedBuildErrors_ParsesRestoreAndCsharpAndLocationFreeShapes() {
        const Output = "MSBUILD : error MSB1009: Project file does not exist.\n" +
            "/src/App.csproj : error NU1101: Unable to find package Foo.\n" +
            "/src/App.cs(3,1): error CS0246: The type or namespace name 'Foo' could not be found\n" +
            "/src/App.gs(3,1,3,4): warning GS0100: not an error\n" +
            "Build FAILED.\n"
        let diagnostics = SdkCompileRunner.ParseRelayedBuildErrors(Output)
        Assert.Equal(3, diagnostics.Count)
        Assert.Equal([]string{"MSB1009", "NU1101", "CS0246"}, diagnostics.Select((d GscDiagnostic) -> d.Id).ToArray())
        Assert.Equal("MSBUILD", diagnostics[0].File)
        Assert.Equal(1, diagnostics[0].Line)
        Assert.Equal("/src/App.cs", diagnostics[2].File)
        Assert.Equal(3, diagnostics[2].Line)
    }

    @Fact
    func ParseRelayedBuildErrors_ReturnsEmpty_WhenNoErrorLinePresent() {
        const Output = "/src/App.gs(3,1,3,4): warning GS0100: not an error\n" +
            "    0 Error(s)\n" +
            "Build succeeded.\n"
        Assert.Empty(SdkCompileRunner.ParseRelayedBuildErrors(Output))
        Assert.Empty(SdkCompileRunner.ParseRelayedBuildErrors(string.Empty))
        Assert.Empty(SdkCompileRunner.ParseRelayedBuildErrors(nil))
    }

    @Fact
    func BuildMirroredBuildArguments_DisablesPackagingOnBuild() {
        // Issue #3672: packing is not what the compile stage measures, and a
        // source project's pack targets reach out to sibling repo .csproj paths
        // the mirror never produced (MSB3202).
        let args = SdkCompileRunner.BuildMirroredBuildArguments(
            "/out/App.gsproj",
            "/artifacts/app",
            "Release",
            "/out/nuget.config"
        )
        Assert.Equal("build", args[0])
        Assert.Equal("/out/App.gsproj", args[1])
        Assert.Contains("-p:GeneratePackageOnBuild=false", args)
        Assert.Contains("-p:RestoreForceEvaluate=true", args)
        Assert.Contains("-p:RestoreLockedMode=false", args)
        Assert.Contains("-p:Cs2GsArtifactRoot=/artifacts/app", args)
        Assert.Contains("-p:RestoreConfigFile=/out/nuget.config", args)
        // Issue #3782: the strict compile — the one whose verdict the gate acts
        // on — must not carry the polish loop's demotion.
        Assert.DoesNotContain(args, (a string) -> a.StartsWith("-p:WarningsNotAsErrors=", StringComparison.Ordinal))
    }

    @Fact
    func Transform_PrunesSuppressedProjectReferenceFromMirroredPackagesLockJson() {
        let root = Path.Combine(Path.GetTempPath(), "cs2gs-lock-prune-" + Guid.NewGuid().ToString("N"))
        let srcDir = Path.Combine(root, "src", "Repl")
        let destDir = Path.Combine(root, "dest", "Repl")
        Directory.CreateDirectory(srcDir)
        Directory.CreateDirectory(destDir)
        try {
            let csprojPath = Path.Combine(srcDir, "Repl.csproj")
            File.WriteAllText(csprojPath, `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="../Core/Core.csproj" />
    <ProjectReference Include="../Sdk/Gsharp.Extensions/Gsharp.Extensions.csproj" />
  </ItemGroup>
</Project>`)
            let lockPath = Path.Combine(destDir, "packages.lock.json")
            File.WriteAllText(lockPath, `{
  "version": 1,
  "dependencies": {
    "net10.0": {
      "GSharp.Core": {
        "type": "Project"
      },
      "GSharp.Gsharp.Extensions": {
        "type": "Project"
      },
      "GSharp.Repl": {
        "type": "Project",
        "dependencies": {
          "GSharp.Core": "[1.0.0, )",
          "GSharp.Gsharp.Extensions": "[1.0.0, )"
        }
      }
    }
  }
}`)
            let generatedPaths = Dictionary[string, string](StringComparer.OrdinalIgnoreCase){
                [Path.GetFullPath(Path.Combine(srcDir, "../Core/Core.csproj"))] = Path.GetFullPath(
                    Path.Combine(destDir, "../Core/Core.gsproj")
                )
            }
            let _ = GSharpProjectTransformer.Transform(csprojPath, destDir, "Gsharp.NET.Sdk", generatedPaths)
            let updatedLock = File.ReadAllText(lockPath)
            Assert.Contains("GSharp.Core", updatedLock)
            Assert.DoesNotContain("GSharp.Gsharp.Extensions", updatedLock)
        } finally {
            if Directory.Exists(root) {
                Directory.Delete(root, recursive: true)
            }
        }
    }

    @Fact
    func BuildMirroredBuildArguments_DemotesTheRequestedWarnings() {
        // Issue #3782: survey mode. WarningsNotAsErrors is a GLOBAL property, so
        // it reaches every project in the graph — which is the whole point: one
        // build then reports every redundant `!!` instead of erroring out at the
        // first project that holds one.
        let args = SdkCompileRunner.BuildMirroredBuildArguments(
            "/out/App.gsproj",
            "/artifacts/app",
            "Release",
            "/out/nuget.config",
            NullAssertionPolishPass.SurveyWarningsNotAsErrors
        )
        Assert.Contains("-p:WarningsNotAsErrors=GS0536", args)
    }

    @Fact
    func BuildMirroredBuildArguments_SharesRunLevelNugetPackagesRootAcrossSiblingApps() {
        let runRoot = Path.Combine(Path.GetTempPath(), "cs2gs-run-" + Guid.NewGuid().ToString("N"))
        let firstApp = Path.Combine(runRoot, "app-a")
        let secondApp = Path.Combine(runRoot, "app-b")
        let firstArgs = SdkCompileRunner.BuildMirroredBuildArguments(
            "/out/A.gsproj",
            firstApp,
            "Release",
            "/out/nuget.config"
        )
        let secondArgs = SdkCompileRunner.BuildMirroredBuildArguments(
            "/out/B.gsproj",
            secondApp,
            "Release",
            "/out/nuget.config"
        )
        let expectedRestorePackages = "-p:RestorePackagesPath=" + Path.Combine(
            Path.GetFullPath(runRoot),
            ".nuget-packages"
        )
        Assert.Contains(expectedRestorePackages, firstArgs)
        Assert.Contains(expectedRestorePackages, secondArgs)
        Assert.Contains("-p:Cs2GsArtifactRoot=" + firstApp, firstArgs)
        Assert.Contains("-p:Cs2GsArtifactRoot=" + secondApp, secondArgs)
    }

    @Fact
    async func TryResolveRepositoryTransitiveProjects_UsesEvaluatedCompileReferencesAndFallsBackWhenUnavailable() {
        let root = Path.Combine(Path.GetTempPath(), "cs2gs-repo-projects-" + Guid.NewGuid().ToString("N"))
        let importedDir = Path.Combine(root, "Imported")
        let falseCondDir = Path.Combine(root, "FalseCond")
        let nonCompileDir = Path.Combine(root, "NonCompile")
        let extDir = Path.Combine(root, "Ext")
        let appDir = Path.Combine(root, "App")
        Directory.CreateDirectory(importedDir)
        Directory.CreateDirectory(falseCondDir)
        Directory.CreateDirectory(nonCompileDir)
        Directory.CreateDirectory(extDir)
        Directory.CreateDirectory(appDir)
        try {
            let importedProj = Path.Combine(importedDir, "Imported.csproj")
            let falseCondProj = Path.Combine(falseCondDir, "FalseCond.csproj")
            let nonCompileProj = Path.Combine(nonCompileDir, "NonCompile.csproj")
            let extProj = Path.Combine(extDir, "Ext.csproj")
            let importedProps = Path.Combine(root, "refs.props")
            let appProj = Path.Combine(appDir, "App.csproj")
            File.WriteAllText(
                importedProj,
                "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>"
            )
            File.WriteAllText(
                falseCondProj,
                "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>"
            )
            File.WriteAllText(
                nonCompileProj,
                "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>"
            )
            File.WriteAllText(
                extProj,
                "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><ProjectReference Include=\"../Imported/Imported.csproj\" /></ItemGroup></Project>"
            )
            File.WriteAllText(
                importedProps,
                "<Project><ItemGroup><ProjectReference Include=\"$$(MSBuildThisFileDirectory)Ext/Ext.csproj\" /></ItemGroup></Project>"
            )
            File.WriteAllText(appProj, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <Import Project="../refs.props" />
  <ItemGroup>
    <ProjectReference Condition="'false'" Include="../FalseCond/FalseCond.csproj" />
    <ProjectReference Include="../NonCompile/NonCompile.csproj" ReferenceOutputAssembly="false" />
  </ItemGroup>
</Project>`)
            let evaluated = await CSharpProjectLoader.EvaluateCompileProjectReferencePathsAsync(
                []string{appProj, extProj, importedProj, falseCondProj, nonCompileProj}
            )
            let appEvaluated = evaluated[Path.GetFullPath(appProj)]
            Assert.Contains(Path.GetFullPath(extProj), appEvaluated)
            Assert.Contains(Path.GetFullPath(importedProj), appEvaluated)
            Assert.DoesNotContain(Path.GetFullPath(falseCondProj), appEvaluated)
            Assert.DoesNotContain(Path.GetFullPath(nonCompileProj), appEvaluated)
            let importedLoaded = CSharpProjectLoader.LoadInMemory(
                [](string, string){("Imported.cs", "public class ImportedType {}")},
                assemblyName: "Imported"
            )
            let appWithoutEdges = CSharpProjectLoader.LoadInMemory(
                [](string, string){("App.cs", "public class AppType {}")},
                assemblyName: "App"
            )
            let mapWithoutEdges = Dictionary[string, LoadedCSharpProject](StringComparer.OrdinalIgnoreCase){
                [Path.GetFullPath(importedProj)] = importedLoaded,
                [Path.GetFullPath(appProj)] = appWithoutEdges
            }
            Assert.False(
                TranslateStage.TryResolveRepositoryTransitiveProjects(
                    appProj,
                    mapWithoutEdges,
                    []string{extProj},
                    out _
                )
            )
            let mapWithEdges = Dictionary[string, LoadedCSharpProject](StringComparer.OrdinalIgnoreCase){
                [Path.GetFullPath(importedProj)] = importedLoaded,
                [Path.GetFullPath(appProj)] = appWithoutEdges.WithEvaluatedProjectReferencePaths(appEvaluated)
            }
            Assert.False(
                TranslateStage.TryResolveRepositoryTransitiveProjects(
                    appProj,
                    mapWithEdges,
                    Array.Empty[string](),
                    out _
                )
            )
            Assert.True(
                TranslateStage.TryResolveRepositoryTransitiveProjects(
                    appProj,
                    mapWithEdges,
                    []string{extProj},
                    out var resolved
                )
            )
            Assert.Equal(2, resolved.Count)
            Assert.Same(appWithoutEdges.Compilation, resolved[0].Compilation)
            Assert.Same(importedLoaded.Compilation, resolved[1].Compilation)
        } finally {
            if Directory.Exists(root) {
                Directory.Delete(root, recursive: true)
            }
        }
    }

    @Fact
    async func RepositoryMigration_PrebuiltSiblingTupleFlowAndSharedLibraryCache_PreservesEvidenceAndComputesOnce() {
        var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
        var compiler string? = nil
        while dir != nil && compiler == nil {
            for config in[]string{"Release", "Debug"} {
                let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                if File.Exists(candidate) {
                    compiler = candidate
                    break
                }
            }
            dir = dir.Parent
        }
        if compiler == nil {
            return
        }
        let root = Path.Combine(Path.GetTempPath(), "cs2gs-prebuilt-sibling-" + Guid.NewGuid().ToString("N"))
        let source = Path.Combine(root, "source")
        let destination = Path.Combine(root, "destination")
        let libDir = Path.Combine(source, "src", "Lib")
        let consumerADir = Path.Combine(source, "src", "ConsumerA")
        let consumerBDir = Path.Combine(source, "src", "ConsumerB")
        Directory.CreateDirectory(libDir)
        Directory.CreateDirectory(consumerADir)
        Directory.CreateDirectory(consumerBDir)
        try {
            let libProj = Path.Combine(libDir, "Lib.csproj")
            let consumerAProj = Path.Combine(consumerADir, "ConsumerA.csproj")
            let consumerBProj = Path.Combine(consumerBDir, "ConsumerB.csproj")
            File.WriteAllText(libProj, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>disable</Nullable>
  </PropertyGroup>
</Project>`)
            File.WriteAllText(Path.Combine(libDir, "Lib.cs"), `namespace LibNs;
public static class Lib
{
    public static string GetNull() => null;
    public static string GetNonNull() => "ok";
    public static string Identity(string value) => value;
}`)
            File.WriteAllText(consumerAProj, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>disable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Lib/Lib.csproj" />
  </ItemGroup>
</Project>`)
            File.WriteAllText(Path.Combine(consumerADir, "ConsumerA.cs"), `using LibNs;
namespace ConsumerANs;
public static class ConsumerA
{
    public static (string, string) Wrap() => (Lib.GetNull(), Lib.GetNonNull());
}`)
            File.WriteAllText(consumerBProj, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>disable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Lib/Lib.csproj" />
  </ItemGroup>
</Project>`)
            File.WriteAllText(Path.Combine(consumerBDir, "ConsumerB.cs"), `using LibNs;
namespace ConsumerBNs;
public static class ConsumerB
{
    public static (string, string) WrapAgain() => (Lib.GetNull(), Lib.GetNonNull());
    public static string CallIdentity()
    {
        string maybeNull = null;
        return Lib.Identity(maybeNull);
    }
}`)
            for args in[]string{
                "build \"" + libProj + "\" -nologo -v:q",
                "restore \"" + consumerAProj + "\" -nologo -v:q",
                "restore \"" + consumerBProj + "\" -nologo -v:q"
            } {
                let buildInfo = ProcessStartInfo("dotnet", args){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let buildProc = Process.Start(buildInfo)!!
                buildProc.WaitForExit()
                Assert.Equal(0, buildProc.ExitCode)
            }
            let options = PipelineOptions{
                GscPath: compiler,
                SourceRoot: source,
                OutputRoot: destination,
                ArtifactRoot: Path.Combine(root, "runs"),
                OutputLayout: MigrationOutputLayout.Repository,
                CompileViaSdk: true,
                Config: "Release"
            }
            let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage()})
            let result = await pipeline.RunAsync(
                []CorpusApp{
                    CorpusApp(
                        "src/Lib/Lib.csproj",
                        libProj,
                        TargetKind.Library,
                        relativeProjectPath: Path.Combine("src", "Lib", "Lib.csproj")
                    ),
                    CorpusApp(
                        "src/ConsumerA/ConsumerA.csproj",
                        consumerAProj,
                        TargetKind.Library,
                        relativeProjectPath: Path.Combine("src", "ConsumerA", "ConsumerA.csproj")
                    ),
                    CorpusApp(
                        "src/ConsumerB/ConsumerB.csproj",
                        consumerBProj,
                        TargetKind.Library,
                        relativeProjectPath: Path.Combine("src", "ConsumerB", "ConsumerB.csproj")
                    )
                }
            )
            Assert.True(result.Succeeded)
            let consumerAGs = File.ReadAllText(Path.Combine(destination, "src", "ConsumerA", "ConsumerA.gs"))
            let consumerBGs = File.ReadAllText(Path.Combine(destination, "src", "ConsumerB", "ConsumerB.gs"))
            let libGs = File.ReadAllText(Path.Combine(destination, "src", "Lib", "Lib.gs"))
            // Prebuilt sibling scalar-to-tuple flow promotes the nullable first
            // element (`GetNull()`) while keeping the non-null second element
            // (`GetNonNull()`) non-null (ADR-0154 discrimination witness).
            Assert.Contains("func Wrap()(string?, string)", consumerAGs, StringComparison.Ordinal)
            Assert.Contains("func WrapAgain()(string?, string)", consumerBGs, StringComparison.Ordinal)
            // ConsumerB's oblivious `Lib.Identity(null)` call does not leak
            // reverse-dependent taint back into Lib's own signature.
            Assert.Contains("func Identity(value string) string", libGs, StringComparison.Ordinal)
            // Shared library taint analysis is computed exactly once across
            // Lib, ConsumerA, and ConsumerB.
            let libLoaded = options.RepositoryLoadedProjects!![Path.GetFullPath(libProj)]
            Assert.Equal(1, ObliviousNullabilityAnalyzer.ComputeCount(libLoaded.Compilation))
            // Separate consumers A and B (without a pre-registered repository
            // union) also must not invalidate the shared library's cached
            // analysis when each registers its own sibling set.
            let freshLib = await CSharpProjectLoader.LoadProjectAsync(libProj)
            let freshConsumerA = await CSharpProjectLoader.LoadProjectAsync(consumerAProj)
            let freshConsumerB = await CSharpProjectLoader.LoadProjectAsync(consumerBProj)
            let docA = Assert.Single(freshConsumerA.Documents)
            let docB = Assert.Single(freshConsumerB.Documents)
            CSharpToGSharpTranslator().TranslateDocument(
                docA,
                TranslationContext(
                    freshConsumerA.Compilation,
                    docA.SemanticModel,
                    docA.FilePath,
                    []Microsoft.CodeAnalysis.CSharp.CSharpCompilation{freshConsumerA.Compilation, freshLib.Compilation}
                )
            )
            Assert.Equal(1, ObliviousNullabilityAnalyzer.ComputeCount(freshLib.Compilation))
            CSharpToGSharpTranslator().TranslateDocument(
                docB,
                TranslationContext(
                    freshConsumerB.Compilation,
                    docB.SemanticModel,
                    docB.FilePath,
                    []Microsoft.CodeAnalysis.CSharp.CSharpCompilation{freshConsumerB.Compilation, freshLib.Compilation}
                )
            )
            Assert.Equal(1, ObliviousNullabilityAnalyzer.ComputeCount(freshLib.Compilation))
        } finally {
            if Directory.Exists(root) {
                Directory.Delete(root, recursive: true)
            }
        }
    }

    /// A scratch directory populated with one fake shared-framework assembly
    /// file, so (cref:SdkCompileRunner.PartitionReferences)'s runtime-dir
    /// enumeration (which requires a directory that actually exists on disk)
    /// can be exercised deterministically.
    private class TempRuntimeDir : IDisposable {
        private init(path string) {
            this.Path = path
        }

        prop Path string {
            get;
        }

        func Dispose() {
            if Directory.Exists(this.Path) {
                Directory.Delete(this.Path, recursive: true)
            }
        }

        shared {
            func WithFakeAssembly(fileName string) TempRuntimeDir {
                let path = Path.Combine(
                    Directory.GetCurrentDirectory(),
                    "sdkcompilerunnertests-scratch-" + Guid.NewGuid().ToString("N")
                )
                Directory.CreateDirectory(path)
                File.WriteAllBytes(Path.Combine(path, fileName), Array.Empty[uint8]())
                return TempRuntimeDir(path)
            }
        }
    }

    shared {
        private const PackagesRoot string = "/Users/dev/.nuget/packages"
        private const RuntimeDir string = "/usr/local/share/dotnet/shared/Microsoft.NETCore.App/10.0.0"
    }
}
