// <copyright file="Issue4631SdkPinTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text.Json
import System.Threading
import System.Threading.Tasks
import System.Xml.Linq
import Cs2Gs.Pipeline
import Xunit
import Cs2Gs.Cli
import System.Reflection

/// Issue #4631 (C1): a repository migration can pin an exact
/// `Gsharp.NET.Sdk` version (`--sdk-version`) that no newer local
/// build displaces, and can write that pin under `global.json`
/// `msbuild-sdks` (`--sdk-pin global-json`) instead of into every
/// generated project, keeping nested scopes on the same version.
/// MSBuild lets a versioned `Sdk="Name/Version"`
/// attribute silently override a `global.json` pin, so in global-json
/// mode every project in the mirror must carry the bare name, and
/// `validate` must follow the tree's pin rather than re-resolve one.
class Issue4631SdkPinTests : IDisposable {
    private let root string

    /// Initializes a new isolated test directory.
    init() {
        this.root = Path.Combine(Path.GetTempPath(), "issue-4631-sdk-pin", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(this.root)
    }

    /// Removes the isolated test directory.
    func Dispose() {
        try {
            Directory.Delete(this.root, recursive: true)
        } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    /// The pin preserves every other `global.json` setting and holds exactly one entry.
    @Fact
    func WriteGlobalJsonPin_PreservesSdkSection_AndReplacesCaseVariantKey() {
        File.WriteAllText(Path.Combine(this.root, "global.json"), `{
  "sdk": { "version": "10.0.300", "rollForward": "latestFeature" },
  "msbuild-sdks": { "gsharp.net.sdk": "0.0.0", "Other.Sdk": "1.2.3", "GSHARP.NET.SDK": "0.0.9" },
}`)
        let created = SdkPin.WriteGlobalJsonPin(this.root, PinnedVersion)
        Assert.False(created)
        using let document = JsonDocument.Parse(File.ReadAllText(Path.Combine(this.root, "global.json")))
        let sdk = document.RootElement.GetProperty("sdk")
        Assert.Equal("10.0.300", sdk.GetProperty("version").GetString())
        Assert.Equal("latestFeature", sdk.GetProperty("rollForward").GetString())
        let pins = Dictionary[string, string](StringComparer.Ordinal)
        for pin in document.RootElement.GetProperty("msbuild-sdks").EnumerateObject() {
            pins.Add(pin.Name, pin.Value.GetString()!!)
        }
        Assert.Equal(
            Dictionary[string, string](StringComparer.Ordinal){
                ["Other.Sdk"] = "1.2.3",
                ["Gsharp.NET.Sdk"] = PinnedVersion
            },
            pins
        )
        Assert.Equal(PinnedVersion, SdkPin.ReadGlobalJsonPin(this.root))
    }

    /// A repository without `global.json` gets one holding only the pin.
    @Fact
    func WriteGlobalJsonPin_CreatesTheFileWhenAbsent() {
        Assert.Null(SdkPin.ReadGlobalJsonPin(this.root))
        Assert.True(SdkPin.WriteGlobalJsonPin(this.root, PinnedVersion))
        Assert.Equal(PinnedVersion, SdkPin.ReadGlobalJsonPin(this.root))
    }

    /// A non-object `msbuild-sdks` is reported, never overwritten.
    @Fact
    func WriteGlobalJsonPin_RefusesToOverwriteANonObjectMsbuildSdks() {
        let path = Path.Combine(this.root, "global.json")
        File.WriteAllText(path, "{ \"msbuild-sdks\": \"Other.Sdk/1.0.0\" }")
        Assert.Throws[InvalidOperationException](
            func () object? {
                return SdkPin.WriteGlobalJsonPin(this.root, PinnedVersion)
            }
        )
        Assert.Equal("{ \"msbuild-sdks\": \"Other.Sdk/1.0.0\" }", File.ReadAllText(path))
        Assert.Throws[InvalidOperationException](
            func () object? {
                return SdkPin.ReadGlobalJsonPin(this.root)
            }
        )
    }

    /// An explicit JSON null is malformed, not an absent `msbuild-sdks` property.
    @Fact
    func GlobalJsonPin_RejectsExplicitNullMsbuildSdks() {
        let path = Path.Combine(this.root, "global.json")
        const json = "{ \"msbuild-sdks\": null }"
        File.WriteAllText(path, json)
        Assert.Throws[InvalidOperationException](
            func () object? {
                return SdkPin.ReadGlobalJsonPin(this.root)
            }
        )
        Assert.Throws[InvalidOperationException](
            func () object? {
                return SdkPin.WriteGlobalJsonPin(this.root, PinnedVersion)
            }
        )
        Assert.Equal(json, File.ReadAllText(path))
    }

    /// Two spellings of the SDK key are one key to MSBuild, so reading must not
    /// silently pick the first; writing still collapses them to one.
    @Fact
    func ReadGlobalJsonPin_RejectsCaseVariantDuplicateKeys() {
        File.WriteAllText(
            Path.Combine(this.root, "global.json"),
            "{ \"msbuild-sdks\": { \"Gsharp.NET.Sdk\": \"" + PinnedVersion + "\", \"gsharp.net.sdk\": \"9.9.9\" } }"
        )
        Assert.Throws[InvalidOperationException](
            func () object? {
                return SdkPin.ReadGlobalJsonPin(this.root)
            }
        )
        Assert.True(SdkPin.WriteGlobalJsonPin(this.root, PinnedVersion) == false)
        Assert.Equal(PinnedVersion, SdkPin.ReadGlobalJsonPin(this.root))
    }

    /// A malformed per-project pin names the project instead of failing deep inside resolution.
    @Fact
    func ReadProjectPin_RejectsAMalformedVersion_NamingTheProject() {
        let project = Path.Combine(this.root, "Broken.gsproj")
        File.WriteAllText(project, "<Project Sdk=\"Gsharp.NET.Sdk/latest\" />")
        let error = Assert.Throws[InvalidOperationException](
            func () object? {
                return SdkPin.ReadProjectPin([]string{project})
            }
        )
        Assert.Contains("Broken.gsproj", error.Message, StringComparison.Ordinal)
        Assert.Contains("'latest'", error.Message, StringComparison.Ordinal)
    }

    /// Every MSBuild SDK declaration form participates in pin validation.
    /// @param projectXml The project declaring the pinned SDK.
    @Theory
    @InlineData("<Project Sdk=\"Gsharp.NET.Sdk/0.3.1;Other.Sdk/1.2.3\" />")
    @InlineData("<Project Sdk=\"Other.Sdk/1.2.3;Gsharp.NET.Sdk/0.3.1\" />")
    @InlineData(
        "<Project><Sdk Name=\"Other.Sdk\" Version=\"1.2.3\" /><Sdk Name=\"Gsharp.NET.Sdk\" Version=\"0.3.1\" /></Project>"
    )
    @InlineData(
        "<Project><Import Project=\"Sdk.props\" Sdk=\"Gsharp.NET.Sdk\" Version=\"0.3.1\" /><Import Project=\"Sdk.targets\" Sdk=\"Gsharp.NET.Sdk\" Version=\"0.3.1\" /></Project>"
    )
    func ReadProjectPin_RecognizesAllSdkDeclarations(projectXml string) {
        let project = Path.Combine(this.root, "Existing.gsproj")
        File.WriteAllText(project, projectXml)
        Assert.Equal("0.3.1", SdkPin.ReadProjectPin([]string{project}))
    }

    /// Translated projects cannot retain an old version in an explicit SDK declaration.
    /// @param declaration The SDK declaration in the source project.
    @Theory
    @InlineData("<Sdk Name=\"Gsharp.NET.Sdk\" Version=\"0.3.1\" />")
    @InlineData("<Import Project=\"Sdk.props\" Sdk=\"Gsharp.NET.Sdk\" Version=\"0.3.1\" />")
    func Transform_RemovesExplicitSdkVersionsInGlobalJsonMode(declaration string) {
        let project = Path.Combine(this.root, "Existing.csproj")
        File.WriteAllText(project, "<Project>" + declaration + "</Project>")
        let transformed = GSharpProjectTransformer.Transform(
            project,
            this.root,
            "Gsharp.NET.Sdk",
            Dictionary[string, string]()
        )
        Assert.Null(transformed.Root!!.Attribute(XName?("Sdk")!!))
        let explicitSdk XElement? = transformed.Root!!.Element(XName?("Sdk")!!) ?? transformed.Root!!.Element(
            XName?("Import")!!
        )
        Assert.NotNull(explicitSdk)
        Assert.Null(explicitSdk!!.Attribute(XName?("Version")!!))
    }

    /// Only the source compiler SDK is replaced; other declarations keep their order and shape.
    /// @param sourceXml The source SDK declarations.
    /// @param expectedXml The declarations after migration.
    @Theory
    @InlineData(
        "<Project Sdk=\"Microsoft.NET.Sdk;Other.Sdk/1.2.3\" />",
        "<Project Sdk=\"Gsharp.NET.Sdk;Other.Sdk/1.2.3\" />"
    )
    @InlineData(
        "<Project Sdk=\"Other.Sdk/1.2.3;Microsoft.NET.Sdk\" />",
        "<Project Sdk=\"Other.Sdk/1.2.3;Gsharp.NET.Sdk\" />"
    )
    @InlineData("<Project Sdk=\"Other.Sdk/1.2.3\" />", "<Project Sdk=\"Gsharp.NET.Sdk;Other.Sdk/1.2.3\" />")
    @InlineData(
        "<Project><Sdk Name=\"Other.Sdk\" Version=\"1.2.3\" /><Sdk Name=\"Microsoft.NET.Sdk\" /></Project>",
        "<Project><Sdk Name=\"Other.Sdk\" Version=\"1.2.3\" /><Sdk Name=\"Gsharp.NET.Sdk\" /></Project>"
    )
    @InlineData(
        "<Project><Import Project=\"Sdk.props\" Sdk=\"Microsoft.NET.Sdk\" /><Import Project=\"Sdk.props\" Sdk=\"Other.Sdk\" Version=\"1.2.3\" /><Import Project=\"Sdk.targets\" Sdk=\"Microsoft.NET.Sdk\" /></Project>",
        "<Project><Import Project=\"Sdk.props\" Sdk=\"Gsharp.NET.Sdk\" /><Import Project=\"Sdk.props\" Sdk=\"Other.Sdk\" Version=\"1.2.3\" /><Import Project=\"Sdk.targets\" Sdk=\"Gsharp.NET.Sdk\" /></Project>"
    )
    func Transform_PreservesUnrelatedSourceSdkDeclarations(sourceXml string, expectedXml string) {
        let project = Path.Combine(this.root, "Existing.csproj")
        File.WriteAllText(project, sourceXml)
        let transformed = GSharpProjectTransformer.Transform(
            project,
            this.root,
            "Gsharp.NET.Sdk",
            Dictionary[string, string]()
        )
        Assert.True(XNode.DeepEquals(XDocument.Parse(expectedXml).Root, transformed.Root))
    }

    /// Explicit SDK elements retain the same source defaults and target kind as SDK attributes.
    /// @param sdk The source SDK.
    @Theory
    @InlineData("Microsoft.NET.Sdk.Web")
    @InlineData("Microsoft.NET.Sdk.Worker")
    func Transform_ExplicitDotnetSdkKeepsExecutableDefaults(sdk string) {
        let project = Path.Combine(this.root, "Existing.csproj")
        File.WriteAllText(project, "<Project><Sdk Name=\"" + sdk + "\" /></Project>")
        Assert.Equal(TargetKind.Exe, CorpusDiscovery.ReadTargetKind(project))
        let transformed = GSharpProjectTransformer.Transform(
            project,
            this.root,
            "Gsharp.NET.Sdk",
            Dictionary[string, string]()
        )
        Assert.Null(transformed.Root!!.Attribute(XName?("Sdk")!!))
        Assert.Equal(
            "Gsharp.NET.Sdk",
            transformed.Root!!.Element(XName?("Sdk")!!)!!.Attribute(XName?("Name")!!)!!.Value
        )
        Assert.Equal("Exe", Assert.Single(transformed.Descendants("OutputType")).Value)
        if sdk == "Microsoft.NET.Sdk.Web" {
            Assert.Equal(
                "Microsoft.AspNetCore.App",
                Assert.Single(transformed.Descendants("FrameworkReference")).Attribute(XName?("Include")!!)!!.Value
            )
        }
    }

    /// Per-project mode pins explicit SDK elements and imports without losing their shape.
    /// @param declaration The SDK declaration in the source project.
    @Theory
    @InlineData("<Sdk Name=\"Gsharp.NET.Sdk\" Version=\"0.3.1\" />")
    @InlineData("<Import Project=\"Sdk.props\" Sdk=\"Gsharp.NET.Sdk\" Version=\"0.3.1\" />")
    func RebindProjectSdk_UpdatesExplicitVersions(declaration string) {
        let project = XElement.Parse(
            "<Project>" + declaration + "<Sdk Name=\"Other.Sdk\" Version=\"1.2.3\" /></Project>"
        )
        Assert.True(SdkPin.RebindProjectSdk(project, "Gsharp.NET.Sdk/" + PinnedVersion))
        let explicitSdk XElement? = project.Element(XName?("Import")!!) ?? project.Element(XName?("Sdk")!!)
        Assert.Equal(PinnedVersion, explicitSdk!!.Attribute(XName?("Version")!!)?.Value)
        let otherSdk = project.Elements("Sdk").Last()
        Assert.Equal("Other.Sdk", otherSdk.Attribute(XName?("Name")!!)!!.Value)
        Assert.Equal("1.2.3", otherSdk.Attribute(XName?("Version")!!)!!.Value)
    }

    /// A malformed pin in a tree is an error, not "no pin".
    @Fact
    func ReadGlobalJsonPin_RejectsAMalformedVersion() {
        File.WriteAllText(
            Path.Combine(this.root, "global.json"),
            "{ \"msbuild-sdks\": { \"Gsharp.NET.Sdk\": \"latest\" } }"
        )
        let error = Assert.Throws[InvalidOperationException](
            func () object? {
                return SdkPin.ReadGlobalJsonPin(this.root)
            }
        )
        Assert.Contains("'latest'", error.Message, StringComparison.Ordinal)
    }

    /// The version is written verbatim into XML and JSON, so only well-formed versions pass.
    /// @param version The candidate version.
    /// @param valid Whether it must be accepted.
    @Theory
    @InlineData("0.4.1200", true)
    @InlineData("0.4.1129-g6c4824cbc0", true)
    @InlineData("1.2.3-alpha.1", true)
    @InlineData("1.2.3-alpha..1", false)
    @InlineData("1.2.3-alpha.", false)
    @InlineData("1.2.3-", false)
    @InlineData("0.4", false)
    @InlineData("0.4.1200/x", false)
    @InlineData("0.4.1200\"", false)
    @InlineData("", false)
    @InlineData(nil, false)
    func SdkVersionArgument_IsValidatedStrictly(version string?, valid bool) {
        Assert.Equal(valid, SdkPinArguments.IsValidVersion(version))
    }

    /// `--sdk-pin` accepts exactly the two documented spellings.
    @Fact
    func SdkPinArgument_ParsesOnlyTheDocumentedLocations() {
        Assert.True(SdkPinArguments.TryParseLocation("project", out var project))
        Assert.Equal(SdkPinLocation.ProjectFile, project)
        Assert.True(SdkPinArguments.TryParseLocation("global-json", out var globalJson))
        Assert.Equal(SdkPinLocation.GlobalJson, globalJson)
        Assert.False(SdkPinArguments.TryParseLocation("globaljson", out _))
        Assert.False(SdkPinArguments.TryParseLocation("Project", out _))
    }

    /// An explicit project pin is rejected in diagnostic mode, including when repeated.
    /// @param firstPin The first pin option.
    /// @param secondPin A later pin option, or an empty string.
    @Theory
    @InlineData("project", "")
    @InlineData("global-json", "project")
    func Migrate_DiagnosticRunRejectsExplicitSdkPin(firstPin string, secondPin string) {
        let args = List[string]{"migrate", "--diagnostic-run", "--corpus", this.root, "--sdk-pin", firstPin}
        if secondPin.Length > 0 {
            args.Add("--sdk-pin")
            args.Add(secondPin)
        }
        let parse MethodInfo? = typeof(Program).GetMethod(
            "ParseMigrateArgs",
            BindingFlags.NonPublic | BindingFlags.Static
        )
        Assert.NotNull(parse)
        let parameters[]object = []object{args.ToArray(), false}
        let result object? = parse!!.Invoke(nil, parameters)
        Assert.Null(result)
    }

    /// Explicit local package lookup selects and stages the requested version, not a newer one.
    @Fact
    func FindLocalPackageVersion_SelectsAndStagesTheExactVersion() {
        const packageId = "Gsharp.NET.Sdk"
        const newerVersion = "9.9.9-newer"
        let repoRoot = Path.Combine(this.root, "package-repo")
        let packageDirectory = Path.Combine(repoRoot, "out", "bin", "Release", "nupkgs")
        Directory.CreateDirectory(packageDirectory)
        let requestedPath = Path.Combine(packageDirectory, packageId + "." + PinnedVersion + ".nupkg")
        File.WriteAllText(requestedPath, "requested")
        File.WriteAllText(Path.Combine(packageDirectory, packageId + "." + newerVersion + ".nupkg"), "newer")
        let found = GsharpTestProjectRunner.FindLocalPackageVersion(repoRoot, packageId, PinnedVersion, "Release")!!
        Assert.Equal(requestedPath, found)
        GsharpTestProjectRunner.EnsureInLocalFeed(repoRoot, found)
        Assert.Equal("requested", File.ReadAllText(Path.Combine(repoRoot, ".nugs", Path.GetFileName(requestedPath))))
    }

    /// An explicit version is what every generated project pins, whatever
    /// newer nupkg the local build left behind; no `global.json` pin is
    /// written in the default per-project mode.
    /// @returns A task representing the asynchronous test.
    @Fact
    async func Migrate_ExplicitSdkVersion_IsPinnedInsteadOfTheNewestLocalBuild() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            // The pipeline cannot run without a built gsc (issue #1749).
            return
        }
        let fixture = this.CreateFixture(sourceGlobalJson: nil)
        let options = this.RepositoryOptions(compiler, fixture)
        options.SdkVersion = PinnedVersion
        let run = await MigrationPipeline(options, []IMigrationStage{TranslateStage()}).RunAsync(fixture.Apps)
        Assert.True(run.Succeeded)
        Assert.Equal("Gsharp.NET.Sdk/" + PinnedVersion, SdkAttribute(fixture.MirroredWidget))
        Assert.Equal("Gsharp.NET.Sdk/" + PinnedVersion, SdkAttribute(fixture.MirroredExtensions))
        Assert.Equal("Gsharp.NET.Sdk/" + PinnedVersion, SdkAttribute(fixture.MirroredLegacy))
        Assert.Equal("Microsoft.Build.NoTargets/3.7.0", SdkAttribute(fixture.MirroredDocs))
        Assert.False(File.Exists(Path.Combine(fixture.Destination, "global.json")))
    }

    /// Global-json mode: one pin in the mirror's `global.json` (the
    /// source's `sdk` section kept), and the bare SDK name on every
    /// project — translated ones AND the excluded already-G# project the
    /// mirror rebinds — because a versioned attribute would override the pin.
    /// @returns A task representing the asynchronous test.
    @Fact
    async func Migrate_GlobalJsonPin_WritesOnePin_AndBareSdkAttributes() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let fixture = this.CreateFixture(SourceGlobalJson)
        let options = this.RepositoryOptions(compiler, fixture)
        options.SdkVersion = PinnedVersion
        options.SdkPinLocation = SdkPinLocation.GlobalJson
        let run = await MigrationPipeline(options, []IMigrationStage{TranslateStage()}).RunAsync(fixture.Apps)
        Assert.True(run.Succeeded)
        Assert.Equal("Gsharp.NET.Sdk", SdkAttribute(fixture.MirroredWidget))
        Assert.Equal("Gsharp.NET.Sdk", SdkAttribute(fixture.MirroredExtensions))
        Assert.Equal("Gsharp.NET.Sdk", SdkAttribute(fixture.MirroredLegacy))
        Assert.Equal("Microsoft.Build.NoTargets/3.7.0", SdkAttribute(fixture.MirroredDocs))
        Assert.Equal(PinnedVersion, SdkPin.ReadGlobalJsonPin(fixture.Destination))
        using let globalJson = JsonDocument.Parse(File.ReadAllText(Path.Combine(fixture.Destination, "global.json")))
        Assert.Equal("10.0.300", globalJson.RootElement.GetProperty("sdk").GetProperty("version").GetString())
    }

    /// A source without `global.json` still gets the pin, and the mirror's
    /// completeness check accepts the file the run created.
    /// @returns A task representing the asynchronous test.
    @Fact
    async func Migrate_GlobalJsonPin_CreatesGlobalJson_AndTheMirrorStaysComplete() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let fixture = this.CreateFixture(sourceGlobalJson: nil)
        let options = this.RepositoryOptions(compiler, fixture)
        options.SdkVersion = PinnedVersion
        options.SdkPinLocation = SdkPinLocation.GlobalJson
        let run = await MigrationPipeline(options, []IMigrationStage{TranslateStage()}).RunAsync(fixture.Apps)
        Assert.True(run.Succeeded)
        Assert.Equal(PinnedVersion, SdkPin.ReadGlobalJsonPin(fixture.Destination))
        Assert.Equal("Gsharp.NET.Sdk", SdkAttribute(fixture.MirroredWidget))
    }

    /// Global-json migration replaces malformed or duplicate old G# pins consistently.
    /// @param sourceJson The source root configuration.
    /// @returns A task representing the asynchronous test.
    @Theory
    @InlineData("{ \"msbuild-sdks\": { \"Gsharp.NET.Sdk\": \"latest\", \"Other.Sdk\": \"1.2.3\" } }")
    @InlineData(
        "{ \"msbuild-sdks\": { \"Gsharp.NET.Sdk\": \"0.3.1\", \"gsharp.net.sdk\": \"0.3.2\", \"Other.Sdk\": \"1.2.3\" } }"
    )
    async func Migrate_GlobalJsonPin_CanonicalizesExistingRootPin(sourceJson string) {
        let compiler string? = FindCompiler()
        Assert.NotNull(compiler)
        let fixture = this.CreateFixture(sourceJson)
        let options = this.RepositoryOptions(compiler, fixture)
        options.SdkVersion = PinnedVersion
        options.SdkPinLocation = SdkPinLocation.GlobalJson
        let run = await MigrationPipeline(options, []IMigrationStage{TranslateStage()}).RunAsync(fixture.Apps)
        Assert.True(run.Succeeded)
        Assert.Equal(PinnedVersion, SdkPin.ReadGlobalJsonPin(fixture.Destination))
        using let document = JsonDocument.Parse(
            File.ReadAllText(Path.Combine(fixture.Destination, SdkPin.GlobalJsonFileName))
        )
        Assert.Equal("1.2.3", document.RootElement.GetProperty("msbuild-sdks").GetProperty("Other.Sdk").GetString())
    }

    /// Project mode rejects G# pins in every effective nested configuration.
    /// @param rootConfig Whether the source already has a root configuration without a G# pin.
    /// @returns A task representing the asynchronous test.
    @Theory
    @InlineData(false)
    @InlineData(true)
    async func Migrate_ProjectPinRejectsNestedGlobalPin(rootConfig bool) {
        let compiler string? = FindCompiler()
        Assert.NotNull(compiler)
        let fixture = this.CreateFixture(
            if rootConfig {
                SourceGlobalJson
            } else {
                default(string?)
            }
        )
        File.WriteAllText(
            Path.Combine(fixture.Source, "src", "Widget", "global.json"),
            "{ \"msbuild-sdks\": { \"Gsharp.NET.Sdk\": \"0.3.356\" } }"
        )
        let options = this.RepositoryOptions(compiler, fixture)
        options.SdkVersion = PinnedVersion
        let error = await Assert.ThrowsAsync[InvalidOperationException](
            func () Task {
                return MigrationPipeline(options, []IMigrationStage{TranslateStage()}).RunAsync(fixture.Apps)
            }
        )
        Assert.Contains("Nested global.json", error.Message, StringComparison.Ordinal)
        Assert.Contains("src/Widget/global.json", error.Message, StringComparison.Ordinal)
        Assert.Contains("0.3.356", error.Message, StringComparison.Ordinal)
    }

    /// Global-json mode updates nested configs so each scope uses the root pin.
    /// @returns A task representing the asynchronous test.
    @Fact
    async func Migrate_GlobalJsonPin_UpdatesNestedGlobalJsonPin() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let fixture = this.CreateFixture(sourceGlobalJson: nil)
        File.WriteAllText(
            Path.Combine(fixture.Source, "src", "Widget", SdkPin.GlobalJsonFileName),
            "{ \"sdk\": { \"version\": \"10.0.300\", \"rollForward\": \"latestFeature\" }, \"msbuild-sdks\": { \"Other.Sdk\": \"1.2.3\", \"Gsharp.NET.Sdk\": \"0.3.356\" } }"
        )
        let sampleDirectory = Path.Combine(fixture.Source, "samples", "HotReload")
        Directory.CreateDirectory(sampleDirectory)
        File.WriteAllText(
            Path.Combine(sampleDirectory, SdkPin.GlobalJsonFileName),
            "{ \"msbuild-sdks\": { \"Gsharp.NET.Sdk\": \"0.3.356\" } }"
        )
        let options = this.RepositoryOptions(compiler, fixture)
        options.SdkVersion = PinnedVersion
        options.SdkPinLocation = SdkPinLocation.GlobalJson
        let run = await MigrationPipeline(options, []IMigrationStage{TranslateStage()}).RunAsync(fixture.Apps)
        Assert.True(run.Succeeded)
        Assert.Equal(PinnedVersion, SdkPin.ReadGlobalJsonPin(fixture.Destination))
        let nestedPath = Path.Combine(fixture.Destination, "src", "Widget", SdkPin.GlobalJsonFileName)
        Assert.Equal(PinnedVersion, SdkPin.ReadGlobalJsonPinFile(nestedPath))
        using let nested = JsonDocument.Parse(File.ReadAllText(nestedPath))
        Assert.Equal("10.0.300", nested.RootElement.GetProperty("sdk").GetProperty("version").GetString())
        Assert.Equal("latestFeature", nested.RootElement.GetProperty("sdk").GetProperty("rollForward").GetString())
        Assert.Equal("1.2.3", nested.RootElement.GetProperty("msbuild-sdks").GetProperty("Other.Sdk").GetString())
        Assert.Equal(
            PinnedVersion,
            SdkPin.ReadGlobalJsonPinFile(
                Path.Combine(fixture.Destination, "samples", "HotReload", SdkPin.GlobalJsonFileName)
            )
        )
        let probe = PinProbeStage()
        let validated = await MigrationPipeline(
            this.ValidateOptions(compiler, fixture),
            []IMigrationStage{probe}
        ).ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(options.ArtifactRoot!!, run.RunId))
        Assert.True(validated.Succeeded)
        let observation = Assert.Single(probe.Observations)
        Assert.Equal("Gsharp.NET.Sdk", observation.SdkMoniker)
        Assert.Equal(PinnedVersion, observation.AnalyzerVerifierPackageVersion)
        Assert.Equal(PinnedVersion, observation.SdkVersion)
    }

    /// Rebinding preserves other SDKs and removes every version overriding the root pin.
    /// @param sourceXml The excluded project's SDK declarations.
    /// @param expectedXml The declarations after rebinding to the root pin.
    /// @returns A task representing the asynchronous test.
    @Theory
    @InlineData(
        "<Project Sdk=\"Gsharp.NET.Sdk/0.3.1;Other.Sdk/1.2.3\" />",
        "<Project Sdk=\"Gsharp.NET.Sdk;Other.Sdk/1.2.3\" />"
    )
    @InlineData(
        "<Project Sdk=\"Other.Sdk/1.2.3;Gsharp.NET.Sdk/0.3.1\" />",
        "<Project Sdk=\"Other.Sdk/1.2.3;Gsharp.NET.Sdk\" />"
    )
    @InlineData(
        "<Project><Sdk Name=\"Other.Sdk\" Version=\"1.2.3\" /><Sdk Name=\"Gsharp.NET.Sdk\" Version=\"0.3.1\" /></Project>",
        "<Project><Sdk Name=\"Other.Sdk\" Version=\"1.2.3\" /><Sdk Name=\"Gsharp.NET.Sdk\" /></Project>"
    )
    @InlineData(
        "<Project><Import Project=\"Sdk.props\" Sdk=\"Gsharp.NET.Sdk\" Version=\"0.3.1\" /><Import Project=\"Sdk.props\" Sdk=\"Other.Sdk\" Version=\"1.2.3\" /><Import Project=\"Sdk.targets\" Sdk=\"Gsharp.NET.Sdk\" Version=\"0.3.1\" /></Project>",
        "<Project><Import Project=\"Sdk.props\" Sdk=\"Gsharp.NET.Sdk\" /><Import Project=\"Sdk.props\" Sdk=\"Other.Sdk\" Version=\"1.2.3\" /><Import Project=\"Sdk.targets\" Sdk=\"Gsharp.NET.Sdk\" /></Project>"
    )
    async func Migrate_GlobalJsonPin_RebindsAllSdkDeclarationsWithoutDroppingOtherSdks(
        sourceXml string,
        expectedXml string
    ) {
        let compiler string? = FindCompiler()
        Assert.NotNull(compiler)
        let fixture = this.CreateFixture(sourceGlobalJson: nil)
        let legacy = Path.Combine(fixture.Source, "src", "Legacy", "Legacy.csproj")
        File.WriteAllText(legacy, sourceXml)
        let options = this.RepositoryOptions(compiler, fixture)
        options.SdkVersion = PinnedVersion
        options.SdkPinLocation = SdkPinLocation.GlobalJson
        let migrated = await MigrationPipeline(options, []IMigrationStage{TranslateStage()}).RunAsync(fixture.Apps)
        Assert.True(migrated.Succeeded)
        Assert.True(XNode.DeepEquals(XDocument.Parse(expectedXml).Root, XDocument.Load(fixture.MirroredLegacy).Root))
        let probe = PinProbeStage()
        let validated = await MigrationPipeline(
            this.ValidateOptions(compiler, fixture),
            []IMigrationStage{probe}
        ).ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(options.ArtifactRoot!!, migrated.RunId))
        Assert.True(validated.Succeeded)
        Assert.Equal("Gsharp.NET.Sdk", Assert.Single(probe.Observations).SdkMoniker)
        File.WriteAllText(fixture.MirroredLegacy, sourceXml)
        let error = await Assert.ThrowsAsync[InvalidOperationException](
            func () Task {
                return MigrationPipeline(
                    this.ValidateOptions(compiler, fixture),
                    []IMigrationStage{PinProbeStage()}
                ).ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(options.ArtifactRoot!!, migrated.RunId))
            }
        )
        Assert.Contains("both in global.json", error.Message, StringComparison.Ordinal)
    }

    /// Bootstrap rebinding must not discard unrelated root SDKs or imports.
    /// @param sdkAttribute The optional root SDK declaration.
    /// @returns A task representing the asynchronous test.
    @Theory
    @InlineData(nil)
    @InlineData("Microsoft.NET.Sdk;Other.Sdk/1.2.3")
    @InlineData("Other.Sdk/1.2.3")
    async func Migrate_GlobalJsonPin_BootstrapRebindingPreservesOtherSdkImports(sdkAttribute string?) {
        let compiler string? = FindCompiler()
        Assert.NotNull(compiler)
        let fixture = this.CreateFixture(sourceGlobalJson: nil)
        File.WriteAllText(Path.Combine(fixture.Source, "src", "Extensions", "Extensions.csproj"), `<Project>
  <Import Project="custom.props" />
  <Import Project="Sdk.props" Sdk="Microsoft.NET.Sdk" />
  <Import Project="Gsharp.NET.Sdk.Bootstrap.targets" />
  <Import Project="Sdk.targets" Sdk="Other.Sdk" Version="1.2.3" />
  <Import Project="custom.targets" Condition="'$(EnableCustomTargets)' == 'true'" />
</Project>`)
        let sourceProject = Path.Combine(fixture.Source, "src", "Extensions", "Extensions.csproj")
        let source = XDocument.Load(sourceProject)
        source.Root!!.SetAttributeValue(XName?("Sdk")!!, sdkAttribute)
        source.Save(sourceProject)
        let options = this.RepositoryOptions(compiler, fixture)
        options.SdkVersion = PinnedVersion
        options.SdkPinLocation = SdkPinLocation.GlobalJson
        let run = await MigrationPipeline(options, []IMigrationStage{TranslateStage()}).RunAsync(fixture.Apps)
        Assert.True(run.Succeeded)
        let project = XDocument.Load(fixture.MirroredExtensions)
        Assert.Equal(
            if sdkAttribute == nil {
                "Gsharp.NET.Sdk"
            } else {
                "Gsharp.NET.Sdk;Other.Sdk/1.2.3"
            },
            project.Root!!.Attribute(XName?("Sdk")!!)!!.Value
        )
        let imports = project.Root!!.Elements("Import").ToArray()
        Assert.Equal(
            []string{"custom.props", "Sdk.targets", "custom.targets"},
            imports.Select(($import XElement) -> $import.Attribute(XName?("Project")!!)!!.Value).ToArray()
        )
        Assert.Equal("'$$(EnableCustomTargets)' == 'true'", imports[2].Attribute(XName?("Condition")!!)!!.Value)
        let import_ = imports[1]
        Assert.Equal("Other.Sdk", import_.Attribute(XName?("Sdk")!!)!!.Value)
        Assert.Equal("1.2.3", import_.Attribute(XName?("Version")!!)!!.Value)
        Assert.Equal("Sdk.targets", import_.Attribute(XName?("Project")!!)!!.Value)
    }

    /// Copied native projects use the run's pin while template payloads remain untouched.
    /// @param location The pin mode.
    /// @returns A task representing the asynchronous test.
    @Theory
    @InlineData(SdkPinLocation(0))
    @InlineData(SdkPinLocation(1))
    async func Migrate_RebindsCopiedNativeProjectsWithoutChangingTemplates(location SdkPinLocation) {
        let compiler string? = FindCompiler()
        Assert.NotNull(compiler)
        let fixture = this.CreateFixture(sourceGlobalJson: nil)
        let nativeDirectory = Path.Combine(fixture.Source, "samples", "ConcurrencyPatterns", "gsharp")
        Directory.CreateDirectory(nativeDirectory)
        const nativeXml = "<Project Sdk=\"Gsharp.NET.Sdk/0.4.591;Other.Sdk/1.2.3\" />"
        File.WriteAllText(Path.Combine(nativeDirectory, "Patterns.gsproj"), nativeXml)
        let templateDirectory = Path.Combine(fixture.Source, "templates", "dotnet")
        Directory.CreateDirectory(Path.Combine(templateDirectory, ".template.config"))
        File.WriteAllText(Path.Combine(templateDirectory, ".template.config", "template.json"), "{}")
        const templateXml = "<Project Sdk=\"Gsharp.NET.Sdk/$$sdkVersion$$\" />"
        const templateGlobalJson = "{ \"msbuild-sdks\": { \"Gsharp.NET.Sdk\": \"$$sdkVersion$$\" } }"
        File.WriteAllText(Path.Combine(templateDirectory, "Template.gsproj"), templateXml)
        Directory.CreateDirectory(Path.Combine(templateDirectory, "nested"))
        File.WriteAllText(Path.Combine(templateDirectory, "nested", "global.json"), templateGlobalJson)
        let visualDirectory = Path.Combine(fixture.Source, "templates", "visual")
        Directory.CreateDirectory(Path.Combine(visualDirectory, "child", "settings"))
        File.WriteAllText(
            Path.Combine(visualDirectory, "Template.vstemplate"),
            "<VSTemplate xmlns=\"http://schemas.microsoft.com/developer/vstemplate/2005\"><TemplateContent><Project File=\"child\\Template.gsproj\"><Folder Name=\"settings\"><ProjectItem>global.json</ProjectItem></Folder></Project></TemplateContent></VSTemplate>"
        )
        File.WriteAllText(Path.Combine(visualDirectory, "child", "Template.gsproj"), templateXml)
        File.WriteAllText(Path.Combine(visualDirectory, "child", "settings", "global.json"), templateGlobalJson)
        File.WriteAllText(
            Path.Combine(visualDirectory, "NotTemplate.gsproj"),
            "<Project Sdk=\"Gsharp.NET.Sdk/0.4.591\" />"
        )
        let itemDirectory = Path.Combine(fixture.Source, "templates", "item")
        Directory.CreateDirectory(itemDirectory)
        File.WriteAllText(
            Path.Combine(itemDirectory, "Template.vstemplate"),
            "<VSTemplate xmlns=\"http://schemas.microsoft.com/developer/vstemplate/2005\" Type=\"Item\"><TemplateContent><ProjectItem>Item.gsproj</ProjectItem><ProjectItem>global.json</ProjectItem></TemplateContent></VSTemplate>"
                .Replace("<ProjectItem>", "<ProjectItem>\n    ", StringComparison.Ordinal).Replace(
                "</ProjectItem>",
                "\n  </ProjectItem>",
                StringComparison.Ordinal
            )
        )
        File.WriteAllText(Path.Combine(itemDirectory, "Item.gsproj"), templateXml)
        File.WriteAllText(Path.Combine(itemDirectory, "global.json"), templateGlobalJson)
        let options = this.RepositoryOptions(compiler, fixture)
        options.SdkVersion = PinnedVersion
        options.SdkPinLocation = location
        let migrated = await MigrationPipeline(options, []IMigrationStage{TranslateStage()}).RunAsync(fixture.Apps)
        Assert.True(migrated.Succeeded)
        let moniker = if location == SdkPinLocation.GlobalJson {
            "Gsharp.NET.Sdk"
        } else {
            "Gsharp.NET.Sdk/" + PinnedVersion
        }
        let native = Path.Combine(fixture.Destination, "samples", "ConcurrencyPatterns", "gsharp", "Patterns.gsproj")
        Assert.Equal(moniker + ";Other.Sdk/1.2.3", SdkAttribute(native))
        Assert.Equal(
            moniker,
            SdkAttribute(Path.Combine(fixture.Destination, "templates", "visual", "NotTemplate.gsproj"))
        )
        Assert.Equal(
            templateXml,
            File.ReadAllText(Path.Combine(fixture.Destination, "templates", "dotnet", "Template.gsproj"))
        )
        Assert.Equal(
            templateXml,
            File.ReadAllText(Path.Combine(fixture.Destination, "templates", "visual", "child", "Template.gsproj"))
        )
        Assert.Equal(
            templateGlobalJson,
            File.ReadAllText(Path.Combine(fixture.Destination, "templates", "dotnet", "nested", "global.json"))
        )
        Assert.Equal(
            templateGlobalJson,
            File.ReadAllText(
                Path.Combine(fixture.Destination, "templates", "visual", "child", "settings", "global.json")
            )
        )
        Assert.Equal(
            templateXml,
            File.ReadAllText(Path.Combine(fixture.Destination, "templates", "item", "Item.gsproj"))
        )
        Assert.Equal(
            templateGlobalJson,
            File.ReadAllText(Path.Combine(fixture.Destination, "templates", "item", "global.json"))
        )
        let probe = PinProbeStage()
        let validated = await MigrationPipeline(
            this.ValidateOptions(compiler, fixture),
            []IMigrationStage{probe}
        ).ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(options.ArtifactRoot!!, migrated.RunId))
        Assert.True(validated.Succeeded)
        Assert.Equal(moniker, Assert.Single(probe.Observations).SdkMoniker)
        File.WriteAllText(native, nativeXml)
        let error = await Assert.ThrowsAsync[InvalidOperationException](
            func () Task {
                return MigrationPipeline(
                    this.ValidateOptions(compiler, fixture),
                    []IMigrationStage{PinProbeStage()}
                ).ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(options.ArtifactRoot!!, migrated.RunId))
            }
        )
        Assert.Contains("0.4.591", error.Message, StringComparison.Ordinal)
    }

    /// Imported MSBuild files share the project pin and template exclusions.
    /// @param location The pin mode.
    /// @param extension The imported MSBuild file extension.
    /// @returns A task representing the asynchronous test.
    @Theory
    @InlineData(SdkPinLocation(0), ".props")
    @InlineData(SdkPinLocation(0), ".targets")
    @InlineData(SdkPinLocation(0), ".proj")
    @InlineData(SdkPinLocation(1), ".props")
    @InlineData(SdkPinLocation(1), ".targets")
    @InlineData(SdkPinLocation(1), ".proj")
    async func Migrate_ImportedBuildFilesShareThePin_AndValidateRejectsTampering(
        location SdkPinLocation,
        extension string
    ) {
        let compiler string? = FindCompiler()
        Assert.NotNull(compiler)
        let fixture = this.CreateFixture(sourceGlobalJson: nil)
        let nativeDirectory = Path.Combine(fixture.Source, "native")
        Directory.CreateDirectory(nativeDirectory)
        File.WriteAllText(
            Path.Combine(nativeDirectory, "Native.gsproj"),
            "<Project Sdk=\"Gsharp.NET.Sdk/0.4.591\"><Import Project=\"custom" + extension + "\" /></Project>"
        )
        const importedXml = `<Project>
  <Import Sdk="Other.Sdk" Version="1.2.3" Project="Other.targets" />
  <Import Sdk="Gsharp.NET.Sdk" Version="0.4.591" Project="Sdk.targets" Condition="'$(UseGsharp)' == 'true'" />
</Project>`
        File.WriteAllText(Path.Combine(nativeDirectory, "custom" + extension), importedXml)
        let templateDirectory = Path.Combine(fixture.Source, "templates", "imported")
        Directory.CreateDirectory(Path.Combine(templateDirectory, ".template.config"))
        File.WriteAllText(Path.Combine(templateDirectory, ".template.config", "template.json"), "{}")
        let templateXml = importedXml.Replace("0.4.591", "$$sdkVersion$$", StringComparison.Ordinal)
        File.WriteAllText(Path.Combine(templateDirectory, "custom" + extension), templateXml)
        let options = this.RepositoryOptions(compiler, fixture)
        options.SdkVersion = PinnedVersion
        options.SdkPinLocation = location
        let migrated = await MigrationPipeline(options, []IMigrationStage{TranslateStage()}).RunAsync(fixture.Apps)
        Assert.True(migrated.Succeeded)
        let importedPath = Path.Combine(fixture.Destination, "native", "custom" + extension)
        let imported = XDocument.Load(importedPath)
        let imports = imported.Root!!.Elements("Import").ToArray()
        Assert.Equal(2, imports.Length)
        Assert.Equal("Other.Sdk", imports[0].Attribute(XName?("Sdk")!!)!!.Value)
        Assert.Equal("1.2.3", imports[0].Attribute(XName?("Version")!!)!!.Value)
        Assert.Equal("Gsharp.NET.Sdk", imports[1].Attribute(XName?("Sdk")!!)!!.Value)
        Assert.Equal(
            if location == SdkPinLocation.GlobalJson {
                default(string?)
            } else {
                PinnedVersion
            },
            imports[1].Attribute(XName?("Version")!!)?.Value
        )
        Assert.Equal("'$$(UseGsharp)' == 'true'", imports[1].Attribute(XName?("Condition")!!)!!.Value)
        Assert.Equal(
            templateXml,
            File.ReadAllText(Path.Combine(fixture.Destination, "templates", "imported", "custom" + extension))
        )
        let probe = PinProbeStage()
        let validated = await MigrationPipeline(
            this.ValidateOptions(compiler, fixture),
            []IMigrationStage{probe}
        ).ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(options.ArtifactRoot!!, migrated.RunId))
        Assert.True(validated.Succeeded)
        Assert.Equal(PinnedVersion, Assert.Single(probe.Observations).SdkVersion)
        imports[1].SetAttributeValue(XName?("Version")!!, "0.0.2-tampered")
        imported.Save(importedPath)
        let error = await Assert.ThrowsAsync[InvalidOperationException](
            func () Task {
                return MigrationPipeline(
                    this.ValidateOptions(compiler, fixture),
                    []IMigrationStage{PinProbeStage()}
                ).ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(options.ArtifactRoot!!, migrated.RunId))
            }
        )
        Assert.Contains("0.0.2-tampered", error.Message, StringComparison.Ordinal)
    }

    /// A source `global.json` that already pins the SDK cannot be mixed
    /// with versioned project attributes: that would build projects against
    /// different SDKs without a word.
    /// @returns A task representing the asynchronous test.
    @Fact
    async func Migrate_PerProjectPin_OverASourceGlobalJsonPin_FailsLoudly() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let fixture = this.CreateFixture("{ \"msbuild-sdks\": { \"Gsharp.NET.Sdk\": \"0.0.2-source\" } }")
        let options = this.RepositoryOptions(compiler, fixture)
        options.SdkVersion = PinnedVersion
        let error = await Assert.ThrowsAsync[InvalidOperationException](
            func () Task {
                return MigrationPipeline(options, []IMigrationStage{TranslateStage()}).RunAsync(fixture.Apps)
            }
        )
        Assert.Contains("--sdk-pin global-json", error.Message, StringComparison.Ordinal)
    }

    /// `validate` over a global-json tree builds with the tree's pin and
    /// the bare attribute, without being told: it must never re-resolve a
    /// versioned moniker that would override the tree.
    /// @returns A task representing the asynchronous test.
    @Fact
    async func Validate_FollowsTheMigratedTreesGlobalJsonPin() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let fixture = this.CreateFixture(SourceGlobalJson)
        let migrate = this.RepositoryOptions(compiler, fixture)
        migrate.SdkVersion = PinnedVersion
        migrate.SdkPinLocation = SdkPinLocation.GlobalJson
        let migrated = await MigrationPipeline(migrate, []IMigrationStage{TranslateStage()}).RunAsync(fixture.Apps)
        Assert.True(migrated.Succeeded)
        let probe = PinProbeStage()
        let validate = this.ValidateOptions(compiler, fixture)
        let validated = await MigrationPipeline(validate, []IMigrationStage{probe}).ValidateAsync(
            fixture.Apps,
            fixture.Apps,
            Path.Combine(migrate.ArtifactRoot!!, migrated.RunId)
        )
        Assert.True(validated.Succeeded)
        let observation = Assert.Single(probe.Observations)
        Assert.Equal("Gsharp.NET.Sdk", observation.SdkMoniker)
        Assert.Equal(PinnedVersion, observation.AnalyzerVerifierPackageVersion)
        Assert.Equal(PinnedVersion, observation.SdkVersion)
    }

    /// Validation rejects nested configuration without the tree's root pin.
    /// @param nestedJson The nested configuration.
    /// @param actualPin The pin named in the error.
    /// @returns A task representing the asynchronous test.
    @Theory
    @InlineData("{ \"msbuild-sdks\": { \"Gsharp.NET.Sdk\": \"0.3.356\" } }", "0.3.356")
    @InlineData("{ \"sdk\": { \"version\": \"10.0.300\", \"rollForward\": \"latestFeature\" } }", "<missing>")
    async func Validate_RejectsNestedGlobalJsonWithoutMatchingRootPin(nestedJson string, actualPin string) {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let fixture = this.CreateFixture(sourceGlobalJson: nil)
        let migrate = this.RepositoryOptions(compiler, fixture)
        migrate.SdkVersion = PinnedVersion
        migrate.SdkPinLocation = SdkPinLocation.GlobalJson
        let migrated = await MigrationPipeline(migrate, []IMigrationStage{TranslateStage()}).RunAsync(fixture.Apps)
        Assert.True(migrated.Succeeded)
        File.WriteAllText(Path.Combine(fixture.Destination, "src", "Widget", SdkPin.GlobalJsonFileName), nestedJson)
        let error = await Assert.ThrowsAsync[InvalidOperationException](
            func () Task {
                return MigrationPipeline(
                    this.ValidateOptions(compiler, fixture),
                    []IMigrationStage{PinProbeStage()}
                ).ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(migrate.ArtifactRoot!!, migrated.RunId))
            }
        )
        Assert.Contains("Nested global.json", error.Message, StringComparison.Ordinal)
        Assert.Contains("src/Widget/global.json", error.Message, StringComparison.Ordinal)
        Assert.Contains(actualPin, error.Message, StringComparison.Ordinal)
    }

    /// Validation cannot accept a nested global pin without a root global pin.
    /// @param rootConfig Whether the migrated root has configuration without a G# pin.
    /// @returns A task representing the asynchronous test.
    @Theory
    @InlineData(false)
    @InlineData(true)
    async func Validate_ProjectPinRejectsNestedGlobalPin(rootConfig bool) {
        let compiler string? = FindCompiler()
        Assert.NotNull(compiler)
        let fixture = this.CreateFixture(
            if rootConfig {
                SourceGlobalJson
            } else {
                default(string?)
            }
        )
        let migrate = this.RepositoryOptions(compiler, fixture)
        migrate.SdkVersion = PinnedVersion
        let migrated = await MigrationPipeline(migrate, []IMigrationStage{TranslateStage()}).RunAsync(fixture.Apps)
        Assert.True(migrated.Succeeded)
        File.WriteAllText(
            Path.Combine(fixture.Destination, "src", "Widget", "global.json"),
            "{ \"msbuild-sdks\": { \"Gsharp.NET.Sdk\": \"0.3.356\" } }"
        )
        let error = await Assert.ThrowsAsync[InvalidOperationException](
            func () Task {
                return MigrationPipeline(
                    this.ValidateOptions(compiler, fixture),
                    []IMigrationStage{PinProbeStage()}
                ).ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(migrate.ArtifactRoot!!, migrated.RunId))
            }
        )
        Assert.Contains("Nested global.json", error.Message, StringComparison.Ordinal)
        Assert.Contains("src/Widget/global.json", error.Message, StringComparison.Ordinal)
        Assert.Contains("0.3.356", error.Message, StringComparison.Ordinal)
    }

    /// Every G# SDK declaration in project mode must carry the recorded pin.
    /// @param projectXml The bare SDK declaration.
    /// @returns A task representing the asynchronous test.
    @Theory
    @InlineData("<Project Sdk=\"Gsharp.NET.Sdk;Other.Sdk/1.2.3\" />")
    @InlineData("<Project><Sdk Name=\"Gsharp.NET.Sdk\" /></Project>")
    @InlineData("<Project><Import Project=\"Sdk.props\" Sdk=\"Gsharp.NET.Sdk\" /></Project>")
    async func Validate_ProjectPinRejectsBareSdkDeclarations(projectXml string) {
        let compiler string? = FindCompiler()
        Assert.NotNull(compiler)
        let fixture = this.CreateFixture(sourceGlobalJson: nil)
        let migrate = this.RepositoryOptions(compiler, fixture)
        migrate.SdkVersion = PinnedVersion
        let migrated = await MigrationPipeline(migrate, []IMigrationStage{TranslateStage()}).RunAsync(fixture.Apps)
        Assert.True(migrated.Succeeded)
        File.WriteAllText(fixture.MirroredWidget, projectXml)
        let error = await Assert.ThrowsAsync[InvalidOperationException](
            func () Task {
                return MigrationPipeline(
                    this.ValidateOptions(compiler, fixture),
                    []IMigrationStage{PinProbeStage()}
                ).ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(migrate.ArtifactRoot!!, migrated.RunId))
            }
        )
        Assert.Contains(fixture.MirroredWidget, error.Message, StringComparison.Ordinal)
        Assert.Contains("unversioned", error.Message, StringComparison.Ordinal)
    }

    /// Validation checks pins in excluded mirrored projects, not just translated projects.
    /// @returns A task representing the asynchronous test.
    @Fact
    async func Validate_RejectsAProjectPinInAnExcludedMirroredProject() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let fixture = this.CreateFixture(sourceGlobalJson: nil)
        let migrate = this.RepositoryOptions(compiler, fixture)
        migrate.SdkVersion = PinnedVersion
        migrate.SdkPinLocation = SdkPinLocation.GlobalJson
        let migrated = await MigrationPipeline(migrate, []IMigrationStage{TranslateStage()}).RunAsync(fixture.Apps)
        Assert.True(migrated.Succeeded)
        let project = XDocument.Load(fixture.MirroredLegacy)
        project.Root!!.SetAttributeValue(XName?("Sdk")!!, "Gsharp.NET.Sdk/0.3.1")
        project.Save(fixture.MirroredLegacy)
        let error = await Assert.ThrowsAsync[InvalidOperationException](
            func () Task {
                return MigrationPipeline(
                    this.ValidateOptions(compiler, fixture),
                    []IMigrationStage{PinProbeStage()}
                ).ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(migrate.ArtifactRoot!!, migrated.RunId))
            }
        )
        Assert.Contains("both in global.json", error.Message, StringComparison.Ordinal)
        Assert.Contains("0.3.1", error.Message, StringComparison.Ordinal)
    }

    /// An explicit `validate --sdk-version` that disagrees with the tree is an error, never a tie-break.
    /// @returns A task representing the asynchronous test.
    @Fact
    async func Validate_SdkVersionThatDisagreesWithTheTree_Throws() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let fixture = this.CreateFixture(sourceGlobalJson: nil)
        let migrate = this.RepositoryOptions(compiler, fixture)
        migrate.SdkVersion = PinnedVersion
        migrate.SdkPinLocation = SdkPinLocation.GlobalJson
        let migrated = await MigrationPipeline(migrate, []IMigrationStage{TranslateStage()}).RunAsync(fixture.Apps)
        Assert.True(migrated.Succeeded)
        let validate = this.ValidateOptions(compiler, fixture)
        validate.SdkVersion = "0.0.3-other"
        let error = await Assert.ThrowsAsync[InvalidOperationException](
            func () Task {
                return MigrationPipeline(validate, []IMigrationStage{PinProbeStage()}).ValidateAsync(
                    fixture.Apps,
                    fixture.Apps,
                    Path.Combine(migrate.ArtifactRoot!!, migrated.RunId)
                )
            }
        )
        Assert.Contains(PinnedVersion, error.Message, StringComparison.Ordinal)
        Assert.Contains("0.0.3-other", error.Message, StringComparison.Ordinal)
    }

    /// Per-project mode across the migrate/validate split: validate keeps the
    /// version the migrated projects record instead of re-resolving the
    /// newest local package, which would rewrite every project.
    /// @returns A task representing the asynchronous test.
    @Fact
    async func Validate_KeepsThePerProjectPinTheMigratedTreeRecords() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let fixture = this.CreateFixture(sourceGlobalJson: nil)
        let migrate = this.RepositoryOptions(compiler, fixture)
        migrate.SdkVersion = PinnedVersion
        let migrated = await MigrationPipeline(migrate, []IMigrationStage{TranslateStage()}).RunAsync(fixture.Apps)
        Assert.True(migrated.Succeeded)
        for projectPath in Directory.EnumerateFiles(fixture.Destination, "*.csproj", SearchOption.AllDirectories) {
            let project = XDocument.Load(projectPath)
            if SdkPin.IsGsharpSdkAttribute(project.Root?.Attribute(XName?("Sdk")!!)?.Value) {
                project.Root!!.SetAttributeValue(XName?("Sdk")!!, "Microsoft.NET.Sdk")
                project.Save(projectPath)
            }
        }
        let probe = PinProbeStage()
        let validated = await MigrationPipeline(
            this.ValidateOptions(compiler, fixture),
            []IMigrationStage{probe}
        ).ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(migrate.ArtifactRoot!!, migrated.RunId))
        Assert.True(validated.Succeeded)
        let observation = Assert.Single(probe.Observations)
        Assert.Equal("Gsharp.NET.Sdk/" + PinnedVersion, observation.SdkMoniker)
        Assert.Equal(PinnedVersion, observation.AnalyzerVerifierPackageVersion)
        Assert.Equal(PinnedVersion, observation.SdkVersion)
        let disagreeing = this.ValidateOptions(compiler, fixture)
        disagreeing.SdkVersion = "0.0.3-other"
        let error = await Assert.ThrowsAsync[InvalidOperationException](
            func () Task {
                return MigrationPipeline(disagreeing, []IMigrationStage{PinProbeStage()}).ValidateAsync(
                    fixture.Apps,
                    fixture.Apps,
                    Path.Combine(migrate.ArtifactRoot!!, migrated.RunId)
                )
            }
        )
        Assert.Contains(PinnedVersion, error.Message, StringComparison.Ordinal)
    }

    /// An explicit parity SDK pin remains usable when no local package is present.
    @Fact
    func ParityRunner_ExplicitPinWithoutLocalPackageAttemptsRestore() {
        let repository = Path.Combine(this.root, "parity-sdk-repository")
        Directory.CreateDirectory(Path.Combine(repository, "feed"))
        File.WriteAllText(
            Path.Combine(repository, "nuget.config"),
            "<configuration><packageSources><clear /><add key=\"offline\" value=\"feed\" /></packageSources></configuration>"
        )
        let project = GsharpTestProject{
            SdkVersion: PinnedVersion,
            LibraryName: "PinnedLibrary",
            TestsName: "PinnedLibrary.Tests"
        }
        let work = Path.Combine(repository, "work")
        let result = GsharpTestProjectRunner(repository).Run(project, work)
        Assert.Equal(GsharpTestRunStatus.BuildFailed, result.Status)
        Assert.Equal(
            "Gsharp.NET.Sdk/" + PinnedVersion,
            SdkAttribute(Path.Combine(work, "PinnedLibrary", "PinnedLibrary.gsproj"))
        )
        Assert.Equal(
            "Gsharp.NET.Sdk/" + PinnedVersion,
            SdkAttribute(Path.Combine(work, "PinnedLibrary.Tests", "PinnedLibrary.Tests.gsproj"))
        )
    }

    private func RepositoryOptions(compiler string?, fixture Issue4631SdkPinTests.Fixture) PipelineOptions {
        let options = PipelineOptions{
            GscPath: compiler,
            SourceRoot: fixture.Source,
            OutputRoot: fixture.Destination,
            ArtifactRoot: Path.Combine(this.root, "runs"),
            OutputLayout: MigrationOutputLayout.Repository,
            Config: "Release"
        }
        options.ExcludedProjectPaths.AddRange(fixture.ExcludedProjects)
        return options
    }

    private func ValidateOptions(compiler string?, fixture Issue4631SdkPinTests.Fixture) PipelineOptions {
        let options = PipelineOptions{
            GscPath: compiler,
            SourceRoot: fixture.Source,
            OutputRoot: fixture.Destination,
            ArtifactRoot: Path.Combine(this.root, "validate-runs"),
            Config: "Release"
        }
        options.ExcludedProjectPaths.AddRange(fixture.ExcludedProjects)
        return options
    }

    // One translated library plus one excluded, already-G# project built with
    // an imported bootstrap SDK (the src/Sdk/Gsharp.Extensions shape the
    // mirror rebinds onto the pinned SDK).
    private func CreateFixture(sourceGlobalJson string?) Issue4631SdkPinTests.Fixture {
        let source = Path.Combine(this.root, "source")
        let widgetDirectory = Path.Combine(source, "src", "Widget")
        let extensionsDirectory = Path.Combine(source, "src", "Extensions")
        Directory.CreateDirectory(widgetDirectory)
        Directory.CreateDirectory(extensionsDirectory)
        let widget = Path.Combine(widgetDirectory, "Widget.csproj")
        File.WriteAllText(
            widget,
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup>" +
                "<TargetFramework>net10.0</TargetFramework>" +
                "<Nullable>enable</Nullable>" +
                "</PropertyGroup></Project>"
        )
        File.WriteAllText(
            Path.Combine(widgetDirectory, "Widget.cs"),
            "namespace Widget { public static class Answer { public static int Value() => 42; } }"
        )
        let extensions = Path.Combine(extensionsDirectory, "Extensions.csproj")
        File.WriteAllText(
            extensions,
            "<Project><Import Project=\"bootstrap.targets\" /><PropertyGroup>" +
                "<TargetFramework>net10.0</TargetFramework>" +
                "</PropertyGroup></Project>"
        )
        File.WriteAllText(Path.Combine(extensionsDirectory, "bootstrap.targets"), "<Project />")
        File.WriteAllText(Path.Combine(extensionsDirectory, "Extensions.gs"), `namespace Extensions

public func Two() int {
    return 2
}
`)
        // An excluded, already-G# project that pins an older SDK version
        // itself, and an excluded project on another SDK entirely.
        let legacyDirectory = Path.Combine(source, "src", "Legacy")
        Directory.CreateDirectory(legacyDirectory)
        let legacy = Path.Combine(legacyDirectory, "Legacy.csproj")
        File.WriteAllText(
            legacy,
            "<Project Sdk=\"Gsharp.NET.Sdk/0.3.1\"><PropertyGroup>" +
                "<TargetFramework>net10.0</TargetFramework>" +
                "</PropertyGroup></Project>"
        )
        File.WriteAllText(Path.Combine(legacyDirectory, "Legacy.gs"), `namespace Legacy

public func Three() int {
    return 3
}
`)
        let docsDirectory = Path.Combine(source, "src", "Docs")
        Directory.CreateDirectory(docsDirectory)
        let docs = Path.Combine(docsDirectory, "Docs.csproj")
        File.WriteAllText(docs, "<Project Sdk=\"Microsoft.Build.NoTargets/3.7.0\" />")
        if sourceGlobalJson != nil {
            File.WriteAllText(Path.Combine(source, "global.json"), sourceGlobalJson)
        }
        let destination = Path.Combine(this.root, "destination")
        return Issue4631SdkPinTests.Fixture(
            source,
            destination,
            []string{extensions, legacy, docs},
            Path.Combine(destination, "src", "Widget", "Widget.gsproj"),
            Path.Combine(destination, "src", "Extensions", "Extensions.csproj"),
            Path.Combine(destination, "src", "Legacy", "Legacy.csproj"),
            Path.Combine(destination, "src", "Docs", "Docs.csproj"),
            []CorpusApp{
                CorpusApp(
                    "src/Widget/Widget.csproj",
                    widget,
                    TargetKind.Library,
                    relativeProjectPath: Path.Combine("src", "Widget", "Widget.csproj")
                )
            }
        )
    }

    private data class Fixture(
        Source string,
        Destination string,
        ExcludedProjects IReadOnlyList[string],
        MirroredWidget string,
        MirroredExtensions string,
        MirroredLegacy string,
        MirroredDocs string,
        Apps IReadOnlyList[CorpusApp]
    ) : IEquatable[Issue4631SdkPinTests.Fixture] { }

    private data struct PinObservation(
        SdkMoniker string?,
        AnalyzerVerifierPackageVersion string?,
        SdkVersion string?
    ) : IEquatable[PinObservation] { }

    /// Records the SDK pin a validate run hands its stages.
    private class PinProbeStage : IMigrationStage {
        init() {
            Observations = List[PinObservation]()
        }

        prop Kind MigrationStageKind -> MigrationStageKind.Compile

        internal prop Observations List[PinObservation] {
            get;
        }

        func ExecuteAsync(
            context StageExecutionContext,
            cancellationToken CancellationToken = default(CancellationToken)
        ) Task[StageOutcome] {
            this.Observations.Add(
                PinObservation(
                    context.Options.RepositorySdkMoniker,
                    context.Options.RepositoryAnalyzerVerifierPackageVersion,
                    context.Options.RepositorySdkVersion
                )
            )
            return Task.FromResult(StageOutcome.Passed())
        }
    }

    shared {
        // Deliberately a version no build ever produces, so the assertions can
        // only pass if the explicit value (not the newest local nupkg) was used.
        private const PinnedVersion string = "0.0.1-issue4631"

        private const SourceGlobalJson string = `{
  // The repository's .NET SDK selection must survive the pin.
  "sdk": {
    "version": "10.0.300",
    "rollForward": "latestFeature"
  }
}`

        private func SdkAttribute(projectPath string) string? -> XDocument
            .Load(projectPath)
            .Root
            ?.Attribute(XName?("Sdk")!!)
            ?.Value

        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
