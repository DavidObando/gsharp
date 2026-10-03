// <copyright file="Issue4631SdkPinTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Xml.Linq;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4631 (C1): a repository migration can pin an exact
/// <c>Gsharp.NET.Sdk</c> version (<c>--sdk-version</c>) that no newer local
/// build displaces, and can write that pin under <c>global.json</c>
/// <c>msbuild-sdks</c> (<c>--sdk-pin global-json</c>) instead of into every
/// generated project, keeping nested scopes on the same version.
/// MSBuild lets a versioned <c>Sdk="Name/Version"</c>
/// attribute silently override a <c>global.json</c> pin, so in global-json
/// mode every project in the mirror must carry the bare name, and
/// <c>validate</c> must follow the tree's pin rather than re-resolve one.
/// </summary>
public sealed class Issue4631SdkPinTests : IDisposable
{
    // Deliberately a version no build ever produces, so the assertions can
    // only pass if the explicit value (not the newest local nupkg) was used.
    private const string PinnedVersion = "0.0.1-issue4631";

    private const string SourceGlobalJson = """
        {
          // The repository's .NET SDK selection must survive the pin.
          "sdk": {
            "version": "10.0.300",
            "rollForward": "latestFeature"
          }
        }
        """;

    private readonly string root;

    /// <summary>Initializes a new isolated test directory.</summary>
    public Issue4631SdkPinTests()
    {
        this.root = Path.Combine(Path.GetTempPath(), "issue-4631-sdk-pin", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.root);
    }

    /// <summary>Removes the isolated test directory.</summary>
    public void Dispose()
    {
        try
        {
            Directory.Delete(this.root, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    /// <summary>The pin preserves every other <c>global.json</c> setting and holds exactly one entry.</summary>
    [Fact]
    public void WriteGlobalJsonPin_PreservesSdkSection_AndReplacesCaseVariantKey()
    {
        File.WriteAllText(
            Path.Combine(this.root, "global.json"),
            """
            {
              "sdk": { "version": "10.0.300", "rollForward": "latestFeature" },
              "msbuild-sdks": { "gsharp.net.sdk": "0.0.0", "Other.Sdk": "1.2.3", "GSHARP.NET.SDK": "0.0.9" },
            }
            """);

        bool created = SdkPin.WriteGlobalJsonPin(this.root, PinnedVersion);

        Assert.False(created);
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(Path.Combine(this.root, "global.json")));
        JsonElement sdk = document.RootElement.GetProperty("sdk");
        Assert.Equal("10.0.300", sdk.GetProperty("version").GetString());
        Assert.Equal("latestFeature", sdk.GetProperty("rollForward").GetString());
        var pins = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (JsonProperty pin in document.RootElement.GetProperty("msbuild-sdks").EnumerateObject())
        {
            pins.Add(pin.Name, pin.Value.GetString());
        }

        Assert.Equal(
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["Other.Sdk"] = "1.2.3",
                ["Gsharp.NET.Sdk"] = PinnedVersion,
            },
            pins);
        Assert.Equal(PinnedVersion, SdkPin.ReadGlobalJsonPin(this.root));
    }

    /// <summary>A repository without <c>global.json</c> gets one holding only the pin.</summary>
    [Fact]
    public void WriteGlobalJsonPin_CreatesTheFileWhenAbsent()
    {
        Assert.Null(SdkPin.ReadGlobalJsonPin(this.root));

        Assert.True(SdkPin.WriteGlobalJsonPin(this.root, PinnedVersion));

        Assert.Equal(PinnedVersion, SdkPin.ReadGlobalJsonPin(this.root));
    }

    /// <summary>A non-object <c>msbuild-sdks</c> is reported, never overwritten.</summary>
    [Fact]
    public void WriteGlobalJsonPin_RefusesToOverwriteANonObjectMsbuildSdks()
    {
        string path = Path.Combine(this.root, "global.json");
        File.WriteAllText(path, """{ "msbuild-sdks": "Other.Sdk/1.0.0" }""");

        Assert.Throws<InvalidOperationException>(() => SdkPin.WriteGlobalJsonPin(this.root, PinnedVersion));
        Assert.Equal("""{ "msbuild-sdks": "Other.Sdk/1.0.0" }""", File.ReadAllText(path));
        Assert.Throws<InvalidOperationException>(() => SdkPin.ReadGlobalJsonPin(this.root));
    }

    /// <summary>An explicit JSON null is malformed, not an absent <c>msbuild-sdks</c> property.</summary>
    [Fact]
    public void GlobalJsonPin_RejectsExplicitNullMsbuildSdks()
    {
        string path = Path.Combine(this.root, "global.json");
        const string json = """{ "msbuild-sdks": null }""";
        File.WriteAllText(path, json);

        Assert.Throws<InvalidOperationException>(() => SdkPin.ReadGlobalJsonPin(this.root));
        Assert.Throws<InvalidOperationException>(() => SdkPin.WriteGlobalJsonPin(this.root, PinnedVersion));
        Assert.Equal(json, File.ReadAllText(path));
    }

    /// <summary>
    /// Two spellings of the SDK key are one key to MSBuild, so reading must not
    /// silently pick the first; writing still collapses them to one.
    /// </summary>
    [Fact]
    public void ReadGlobalJsonPin_RejectsCaseVariantDuplicateKeys()
    {
        File.WriteAllText(
            Path.Combine(this.root, "global.json"),
            "{ \"msbuild-sdks\": { \"Gsharp.NET.Sdk\": \"" + PinnedVersion + "\", \"gsharp.net.sdk\": \"9.9.9\" } }");

        Assert.Throws<InvalidOperationException>(() => SdkPin.ReadGlobalJsonPin(this.root));
        Assert.True(SdkPin.WriteGlobalJsonPin(this.root, PinnedVersion) is false);
        Assert.Equal(PinnedVersion, SdkPin.ReadGlobalJsonPin(this.root));
    }

    /// <summary>A malformed per-project pin names the project instead of failing deep inside resolution.</summary>
    [Fact]
    public void ReadProjectPin_RejectsAMalformedVersion_NamingTheProject()
    {
        string project = Path.Combine(this.root, "Broken.gsproj");
        File.WriteAllText(project, "<Project Sdk=\"Gsharp.NET.Sdk/latest\" />");

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(
            () => SdkPin.ReadProjectPin(new[] { project }));
        Assert.Contains("Broken.gsproj", error.Message, StringComparison.Ordinal);
        Assert.Contains("'latest'", error.Message, StringComparison.Ordinal);
    }

    /// <summary>Every MSBuild SDK declaration form participates in pin validation.</summary>
    /// <param name="projectXml">The project declaring the pinned SDK.</param>
    [Theory]
    [InlineData("""<Project Sdk="Gsharp.NET.Sdk/0.3.1;Other.Sdk/1.2.3" />""")]
    [InlineData("""<Project Sdk="Other.Sdk/1.2.3;Gsharp.NET.Sdk/0.3.1" />""")]
    [InlineData("""<Project><Sdk Name="Other.Sdk" Version="1.2.3" /><Sdk Name="Gsharp.NET.Sdk" Version="0.3.1" /></Project>""")]
    [InlineData("""<Project><Import Project="Sdk.props" Sdk="Gsharp.NET.Sdk" Version="0.3.1" /><Import Project="Sdk.targets" Sdk="Gsharp.NET.Sdk" Version="0.3.1" /></Project>""")]
    public void ReadProjectPin_RecognizesAllSdkDeclarations(string projectXml)
    {
        string project = Path.Combine(this.root, "Existing.gsproj");
        File.WriteAllText(project, projectXml);

        Assert.Equal("0.3.1", SdkPin.ReadProjectPin(new[] { project }));
    }

    /// <summary>Translated projects cannot retain an old version in an explicit SDK declaration.</summary>
    /// <param name="declaration">The SDK declaration in the source project.</param>
    [Theory]
    [InlineData("""<Sdk Name="Gsharp.NET.Sdk" Version="0.3.1" />""")]
    [InlineData("""<Import Project="Sdk.props" Sdk="Gsharp.NET.Sdk" Version="0.3.1" />""")]
    public void Transform_RemovesExplicitSdkVersionsInGlobalJsonMode(string declaration)
    {
        string project = Path.Combine(this.root, "Existing.csproj");
        File.WriteAllText(project, "<Project>" + declaration + "</Project>");

        XDocument transformed = GSharpProjectTransformer.Transform(
            project,
            this.root,
            "Gsharp.NET.Sdk",
            new Dictionary<string, string>());

        Assert.Null(transformed.Root.Attribute("Sdk"));
        XElement explicitSdk = transformed.Root.Element("Sdk") ?? transformed.Root.Element("Import");
        Assert.NotNull(explicitSdk);
        Assert.Null(explicitSdk.Attribute("Version"));
    }

    /// <summary>Only the source compiler SDK is replaced; other declarations keep their order and shape.</summary>
    /// <param name="sourceXml">The source SDK declarations.</param>
    /// <param name="expectedXml">The declarations after migration.</param>
    [Theory]
    [InlineData(
        """<Project Sdk="Microsoft.NET.Sdk;Other.Sdk/1.2.3" />""",
        """<Project Sdk="Gsharp.NET.Sdk;Other.Sdk/1.2.3" />""")]
    [InlineData(
        """<Project Sdk="Other.Sdk/1.2.3;Microsoft.NET.Sdk" />""",
        """<Project Sdk="Other.Sdk/1.2.3;Gsharp.NET.Sdk" />""")]
    [InlineData(
        """<Project Sdk="Other.Sdk/1.2.3" />""",
        """<Project Sdk="Gsharp.NET.Sdk;Other.Sdk/1.2.3" />""")]
    [InlineData(
        """<Project><Sdk Name="Other.Sdk" Version="1.2.3" /><Sdk Name="Microsoft.NET.Sdk" /></Project>""",
        """<Project><Sdk Name="Other.Sdk" Version="1.2.3" /><Sdk Name="Gsharp.NET.Sdk" /></Project>""")]
    [InlineData(
        """<Project><Import Project="Sdk.props" Sdk="Microsoft.NET.Sdk" /><Import Project="Sdk.props" Sdk="Other.Sdk" Version="1.2.3" /><Import Project="Sdk.targets" Sdk="Microsoft.NET.Sdk" /></Project>""",
        """<Project><Import Project="Sdk.props" Sdk="Gsharp.NET.Sdk" /><Import Project="Sdk.props" Sdk="Other.Sdk" Version="1.2.3" /><Import Project="Sdk.targets" Sdk="Gsharp.NET.Sdk" /></Project>""")]
    public void Transform_PreservesUnrelatedSourceSdkDeclarations(string sourceXml, string expectedXml)
    {
        string project = Path.Combine(this.root, "Existing.csproj");
        File.WriteAllText(project, sourceXml);

        XDocument transformed = GSharpProjectTransformer.Transform(
            project,
            this.root,
            "Gsharp.NET.Sdk",
            new Dictionary<string, string>());

        Assert.True(XNode.DeepEquals(XDocument.Parse(expectedXml).Root, transformed.Root));
    }

    /// <summary>Explicit SDK elements retain the same source defaults and target kind as SDK attributes.</summary>
    /// <param name="sdk">The source SDK.</param>
    [Theory]
    [InlineData("Microsoft.NET.Sdk.Web")]
    [InlineData("Microsoft.NET.Sdk.Worker")]
    public void Transform_ExplicitDotnetSdkKeepsExecutableDefaults(string sdk)
    {
        string project = Path.Combine(this.root, "Existing.csproj");
        File.WriteAllText(project, "<Project><Sdk Name=\"" + sdk + "\" /></Project>");

        Assert.Equal(TargetKind.Exe, CorpusDiscovery.ReadTargetKind(project));
        XDocument transformed = GSharpProjectTransformer.Transform(
            project,
            this.root,
            "Gsharp.NET.Sdk",
            new Dictionary<string, string>());

        Assert.Null(transformed.Root.Attribute("Sdk"));
        Assert.Equal("Gsharp.NET.Sdk", transformed.Root.Element("Sdk").Attribute("Name").Value);
        Assert.Equal("Exe", Assert.Single(transformed.Descendants("OutputType")).Value);
        if (sdk == "Microsoft.NET.Sdk.Web")
        {
            Assert.Equal(
                "Microsoft.AspNetCore.App",
                Assert.Single(transformed.Descendants("FrameworkReference")).Attribute("Include").Value);
        }
    }

    /// <summary>Per-project mode pins explicit SDK elements and imports without losing their shape.</summary>
    /// <param name="declaration">The SDK declaration in the source project.</param>
    [Theory]
    [InlineData("""<Sdk Name="Gsharp.NET.Sdk" Version="0.3.1" />""")]
    [InlineData("""<Import Project="Sdk.props" Sdk="Gsharp.NET.Sdk" Version="0.3.1" />""")]
    public void RebindProjectSdk_UpdatesExplicitVersions(string declaration)
    {
        XElement project = XElement.Parse(
            "<Project>" + declaration + """<Sdk Name="Other.Sdk" Version="1.2.3" /></Project>""");

        Assert.True(SdkPin.RebindProjectSdk(project, "Gsharp.NET.Sdk/" + PinnedVersion));

        XElement explicitSdk = project.Element("Import") ?? project.Element("Sdk");
        Assert.Equal(PinnedVersion, explicitSdk.Attribute("Version")?.Value);
        XElement otherSdk = project.Elements("Sdk").Last();
        Assert.Equal("Other.Sdk", otherSdk.Attribute("Name").Value);
        Assert.Equal("1.2.3", otherSdk.Attribute("Version").Value);
    }

    /// <summary>A malformed pin in a tree is an error, not "no pin".</summary>
    [Fact]
    public void ReadGlobalJsonPin_RejectsAMalformedVersion()
    {
        File.WriteAllText(
            Path.Combine(this.root, "global.json"),
            """{ "msbuild-sdks": { "Gsharp.NET.Sdk": "latest" } }""");

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(
            () => SdkPin.ReadGlobalJsonPin(this.root));
        Assert.Contains("'latest'", error.Message, StringComparison.Ordinal);
    }

    /// <summary>The version is written verbatim into XML and JSON, so only well-formed versions pass.</summary>
    /// <param name="version">The candidate version.</param>
    /// <param name="valid">Whether it must be accepted.</param>
    [Theory]
    [InlineData("0.4.1200", true)]
    [InlineData("0.4.1129-g6c4824cbc0", true)]
    [InlineData("1.2.3-alpha.1", true)]
    [InlineData("1.2.3-alpha..1", false)]
    [InlineData("1.2.3-alpha.", false)]
    [InlineData("1.2.3-", false)]
    [InlineData("0.4", false)]
    [InlineData("0.4.1200/x", false)]
    [InlineData("0.4.1200\"", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void SdkVersionArgument_IsValidatedStrictly(string version, bool valid)
    {
        Assert.Equal(valid, SdkPinArguments.IsValidVersion(version));
    }

    /// <summary><c>--sdk-pin</c> accepts exactly the two documented spellings.</summary>
    [Fact]
    public void SdkPinArgument_ParsesOnlyTheDocumentedLocations()
    {
        Assert.True(SdkPinArguments.TryParseLocation("project", out SdkPinLocation project));
        Assert.Equal(SdkPinLocation.ProjectFile, project);
        Assert.True(SdkPinArguments.TryParseLocation("global-json", out SdkPinLocation globalJson));
        Assert.Equal(SdkPinLocation.GlobalJson, globalJson);
        Assert.False(SdkPinArguments.TryParseLocation("globaljson", out _));
        Assert.False(SdkPinArguments.TryParseLocation("Project", out _));
    }

    /// <summary>An explicit project pin is rejected in diagnostic mode, including when repeated.</summary>
    /// <param name="firstPin">The first pin option.</param>
    /// <param name="secondPin">A later pin option, or an empty string.</param>
    [Theory]
    [InlineData("project", "")]
    [InlineData("global-json", "project")]
    public void Migrate_DiagnosticRunRejectsExplicitSdkPin(string firstPin, string secondPin)
    {
        var args = new List<string>
        {
            "migrate",
            "--diagnostic-run",
            "--corpus",
            this.root,
            "--sdk-pin",
            firstPin,
        };
        if (secondPin.Length > 0)
        {
            args.Add("--sdk-pin");
            args.Add(secondPin);
        }

        System.Reflection.MethodInfo parse = typeof(Cs2Gs.Cli.Program).GetMethod(
            "ParseMigrateArgs",
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
        Assert.NotNull(parse);
        object[] parameters = { args.ToArray(), false };
        object result = parse.Invoke(null, parameters);

        Assert.Null(result);
    }

    /// <summary>Explicit local package lookup selects and stages the requested version, not a newer one.</summary>
    [Fact]
    public void FindLocalPackageVersion_SelectsAndStagesTheExactVersion()
    {
        const string packageId = "Gsharp.NET.Sdk";
        const string newerVersion = "9.9.9-newer";
        string repoRoot = Path.Combine(this.root, "package-repo");
        string packageDirectory = Path.Combine(repoRoot, "out", "bin", "Release", "nupkgs");
        Directory.CreateDirectory(packageDirectory);
        string requestedPath = Path.Combine(packageDirectory, packageId + "." + PinnedVersion + ".nupkg");
        File.WriteAllText(requestedPath, "requested");
        File.WriteAllText(Path.Combine(packageDirectory, packageId + "." + newerVersion + ".nupkg"), "newer");

        string found = GsharpTestProjectRunner.FindLocalPackageVersion(
            repoRoot,
            packageId,
            PinnedVersion,
            "Release");

        Assert.Equal(requestedPath, found);
        GsharpTestProjectRunner.EnsureInLocalFeed(repoRoot, found);
        Assert.Equal(
            "requested",
            File.ReadAllText(Path.Combine(repoRoot, ".nugs", Path.GetFileName(requestedPath))));
    }

    /// <summary>
    /// An explicit version is what every generated project pins, whatever
    /// newer nupkg the local build left behind; no <c>global.json</c> pin is
    /// written in the default per-project mode.
    /// </summary>
    /// <returns>A task representing the asynchronous test.</returns>
    [Fact]
    public async Task Migrate_ExplicitSdkVersion_IsPinnedInsteadOfTheNewestLocalBuild()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            // The pipeline cannot run without a built gsc (issue #1749).
            return;
        }

        Fixture fixture = this.CreateFixture(sourceGlobalJson: null);
        PipelineOptions options = this.RepositoryOptions(compiler, fixture);
        options.SdkVersion = PinnedVersion;

        RunResult run = await new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() })
            .RunAsync(fixture.Apps);

        Assert.True(run.Succeeded);
        Assert.Equal("Gsharp.NET.Sdk/" + PinnedVersion, SdkAttribute(fixture.MirroredWidget));
        Assert.Equal("Gsharp.NET.Sdk/" + PinnedVersion, SdkAttribute(fixture.MirroredExtensions));
        Assert.Equal("Gsharp.NET.Sdk/" + PinnedVersion, SdkAttribute(fixture.MirroredLegacy));
        Assert.Equal("Microsoft.Build.NoTargets/3.7.0", SdkAttribute(fixture.MirroredDocs));
        Assert.False(File.Exists(Path.Combine(fixture.Destination, "global.json")));
    }

    /// <summary>
    /// Global-json mode: one pin in the mirror's <c>global.json</c> (the
    /// source's <c>sdk</c> section kept), and the bare SDK name on every
    /// project — translated ones AND the excluded already-G# project the
    /// mirror rebinds — because a versioned attribute would override the pin.
    /// </summary>
    /// <returns>A task representing the asynchronous test.</returns>
    [Fact]
    public async Task Migrate_GlobalJsonPin_WritesOnePin_AndBareSdkAttributes()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        Fixture fixture = this.CreateFixture(SourceGlobalJson);
        PipelineOptions options = this.RepositoryOptions(compiler, fixture);
        options.SdkVersion = PinnedVersion;
        options.SdkPinLocation = SdkPinLocation.GlobalJson;

        RunResult run = await new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() })
            .RunAsync(fixture.Apps);

        Assert.True(run.Succeeded);
        Assert.Equal("Gsharp.NET.Sdk", SdkAttribute(fixture.MirroredWidget));
        Assert.Equal("Gsharp.NET.Sdk", SdkAttribute(fixture.MirroredExtensions));
        Assert.Equal("Gsharp.NET.Sdk", SdkAttribute(fixture.MirroredLegacy));
        Assert.Equal("Microsoft.Build.NoTargets/3.7.0", SdkAttribute(fixture.MirroredDocs));
        Assert.Equal(PinnedVersion, SdkPin.ReadGlobalJsonPin(fixture.Destination));
        using JsonDocument globalJson = JsonDocument.Parse(
            File.ReadAllText(Path.Combine(fixture.Destination, "global.json")));
        Assert.Equal(
            "10.0.300",
            globalJson.RootElement.GetProperty("sdk").GetProperty("version").GetString());
    }

    /// <summary>
    /// A source without <c>global.json</c> still gets the pin, and the mirror's
    /// completeness check accepts the file the run created.
    /// </summary>
    /// <returns>A task representing the asynchronous test.</returns>
    [Fact]
    public async Task Migrate_GlobalJsonPin_CreatesGlobalJson_AndTheMirrorStaysComplete()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        Fixture fixture = this.CreateFixture(sourceGlobalJson: null);
        PipelineOptions options = this.RepositoryOptions(compiler, fixture);
        options.SdkVersion = PinnedVersion;
        options.SdkPinLocation = SdkPinLocation.GlobalJson;

        RunResult run = await new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() })
            .RunAsync(fixture.Apps);

        Assert.True(run.Succeeded);
        Assert.Equal(PinnedVersion, SdkPin.ReadGlobalJsonPin(fixture.Destination));
        Assert.Equal("Gsharp.NET.Sdk", SdkAttribute(fixture.MirroredWidget));
    }

    /// <summary>Global-json migration replaces malformed or duplicate old G# pins consistently.</summary>
    /// <param name="sourceJson">The source root configuration.</param>
    /// <returns>A task representing the asynchronous test.</returns>
    [Theory]
    [InlineData("""{ "msbuild-sdks": { "Gsharp.NET.Sdk": "latest", "Other.Sdk": "1.2.3" } }""")]
    [InlineData("""{ "msbuild-sdks": { "Gsharp.NET.Sdk": "0.3.1", "gsharp.net.sdk": "0.3.2", "Other.Sdk": "1.2.3" } }""")]
    public async Task Migrate_GlobalJsonPin_CanonicalizesExistingRootPin(string sourceJson)
    {
        string compiler = FindCompiler();
        Assert.NotNull(compiler);
        Fixture fixture = this.CreateFixture(sourceJson);
        PipelineOptions options = this.RepositoryOptions(compiler, fixture);
        options.SdkVersion = PinnedVersion;
        options.SdkPinLocation = SdkPinLocation.GlobalJson;

        RunResult run = await new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() })
            .RunAsync(fixture.Apps);

        Assert.True(run.Succeeded);
        Assert.Equal(PinnedVersion, SdkPin.ReadGlobalJsonPin(fixture.Destination));
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(
            Path.Combine(fixture.Destination, SdkPin.GlobalJsonFileName)));
        Assert.Equal(
            "1.2.3",
            document.RootElement.GetProperty("msbuild-sdks").GetProperty("Other.Sdk").GetString());
    }

    /// <summary>Global-json mode updates nested configs so each scope uses the root pin.</summary>
    /// <returns>A task representing the asynchronous test.</returns>
    [Fact]
    public async Task Migrate_GlobalJsonPin_UpdatesNestedGlobalJsonPin()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        Fixture fixture = this.CreateFixture(sourceGlobalJson: null);
        File.WriteAllText(
            Path.Combine(fixture.Source, "src", "Widget", SdkPin.GlobalJsonFileName),
            """{ "sdk": { "version": "10.0.300", "rollForward": "latestFeature" }, "msbuild-sdks": { "Other.Sdk": "1.2.3", "Gsharp.NET.Sdk": "0.3.356" } }""");
        string sampleDirectory = Path.Combine(fixture.Source, "samples", "HotReload");
        Directory.CreateDirectory(sampleDirectory);
        File.WriteAllText(
            Path.Combine(sampleDirectory, SdkPin.GlobalJsonFileName),
            """{ "msbuild-sdks": { "Gsharp.NET.Sdk": "0.3.356" } }""");
        PipelineOptions options = this.RepositoryOptions(compiler, fixture);
        options.SdkVersion = PinnedVersion;
        options.SdkPinLocation = SdkPinLocation.GlobalJson;

        RunResult run = await new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() })
            .RunAsync(fixture.Apps);

        Assert.True(run.Succeeded);
        Assert.Equal(PinnedVersion, SdkPin.ReadGlobalJsonPin(fixture.Destination));
        string nestedPath = Path.Combine(fixture.Destination, "src", "Widget", SdkPin.GlobalJsonFileName);
        Assert.Equal(PinnedVersion, SdkPin.ReadGlobalJsonPinFile(nestedPath));
        using JsonDocument nested = JsonDocument.Parse(File.ReadAllText(nestedPath));
        Assert.Equal("10.0.300", nested.RootElement.GetProperty("sdk").GetProperty("version").GetString());
        Assert.Equal("latestFeature", nested.RootElement.GetProperty("sdk").GetProperty("rollForward").GetString());
        Assert.Equal("1.2.3", nested.RootElement.GetProperty("msbuild-sdks").GetProperty("Other.Sdk").GetString());
        Assert.Equal(
            PinnedVersion,
            SdkPin.ReadGlobalJsonPinFile(Path.Combine(fixture.Destination, "samples", "HotReload", SdkPin.GlobalJsonFileName)));

        var probe = new PinProbeStage();
        RunResult validated = await new MigrationPipeline(this.ValidateOptions(compiler, fixture), new IMigrationStage[] { probe })
            .ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(options.ArtifactRoot, run.RunId));

        Assert.True(validated.Succeeded);
        PinObservation observation = Assert.Single(probe.Observations);
        Assert.Equal("Gsharp.NET.Sdk", observation.SdkMoniker);
        Assert.Equal(PinnedVersion, observation.AnalyzerVerifierPackageVersion);
    }

    /// <summary>Rebinding preserves other SDKs and removes every version overriding the root pin.</summary>
    /// <param name="sourceXml">The excluded project's SDK declarations.</param>
    /// <param name="expectedXml">The declarations after rebinding to the root pin.</param>
    /// <returns>A task representing the asynchronous test.</returns>
    [Theory]
    [InlineData(
        """<Project Sdk="Gsharp.NET.Sdk/0.3.1;Other.Sdk/1.2.3" />""",
        """<Project Sdk="Gsharp.NET.Sdk;Other.Sdk/1.2.3" />""")]
    [InlineData(
        """<Project Sdk="Other.Sdk/1.2.3;Gsharp.NET.Sdk/0.3.1" />""",
        """<Project Sdk="Other.Sdk/1.2.3;Gsharp.NET.Sdk" />""")]
    [InlineData(
        """<Project><Sdk Name="Other.Sdk" Version="1.2.3" /><Sdk Name="Gsharp.NET.Sdk" Version="0.3.1" /></Project>""",
        """<Project><Sdk Name="Other.Sdk" Version="1.2.3" /><Sdk Name="Gsharp.NET.Sdk" /></Project>""")]
    [InlineData(
        """<Project><Import Project="Sdk.props" Sdk="Gsharp.NET.Sdk" Version="0.3.1" /><Import Project="Sdk.props" Sdk="Other.Sdk" Version="1.2.3" /><Import Project="Sdk.targets" Sdk="Gsharp.NET.Sdk" Version="0.3.1" /></Project>""",
        """<Project><Import Project="Sdk.props" Sdk="Gsharp.NET.Sdk" /><Import Project="Sdk.props" Sdk="Other.Sdk" Version="1.2.3" /><Import Project="Sdk.targets" Sdk="Gsharp.NET.Sdk" /></Project>""")]
    public async Task Migrate_GlobalJsonPin_RebindsAllSdkDeclarationsWithoutDroppingOtherSdks(
        string sourceXml,
        string expectedXml)
    {
        string compiler = FindCompiler();
        Assert.NotNull(compiler);
        Fixture fixture = this.CreateFixture(sourceGlobalJson: null);
        string legacy = Path.Combine(fixture.Source, "src", "Legacy", "Legacy.csproj");
        File.WriteAllText(legacy, sourceXml);
        PipelineOptions options = this.RepositoryOptions(compiler, fixture);
        options.SdkVersion = PinnedVersion;
        options.SdkPinLocation = SdkPinLocation.GlobalJson;

        RunResult migrated = await new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() })
            .RunAsync(fixture.Apps);

        Assert.True(migrated.Succeeded);
        Assert.True(XNode.DeepEquals(XDocument.Parse(expectedXml).Root, XDocument.Load(fixture.MirroredLegacy).Root));
        var probe = new PinProbeStage();
        RunResult validated = await new MigrationPipeline(this.ValidateOptions(compiler, fixture), new IMigrationStage[] { probe })
            .ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(options.ArtifactRoot, migrated.RunId));
        Assert.True(validated.Succeeded);
        Assert.Equal("Gsharp.NET.Sdk", Assert.Single(probe.Observations).SdkMoniker);

        File.WriteAllText(fixture.MirroredLegacy, sourceXml);
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => new MigrationPipeline(this.ValidateOptions(compiler, fixture), new IMigrationStage[] { new PinProbeStage() })
                .ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(options.ArtifactRoot, migrated.RunId)));
        Assert.Contains("both in global.json", error.Message, StringComparison.Ordinal);
    }

    /// <summary>Bootstrap rebinding must not discard an unrelated SDK import.</summary>
    /// <returns>A task representing the asynchronous test.</returns>
    [Fact]
    public async Task Migrate_GlobalJsonPin_BootstrapRebindingPreservesOtherSdkImports()
    {
        string compiler = FindCompiler();
        Assert.NotNull(compiler);
        Fixture fixture = this.CreateFixture(sourceGlobalJson: null);
        File.WriteAllText(
            Path.Combine(fixture.Source, "src", "Extensions", "Extensions.csproj"),
            """
            <Project>
              <Import Project="Sdk.props" Sdk="Microsoft.NET.Sdk" />
              <Import Project="Gsharp.NET.Sdk.Bootstrap.targets" />
              <Import Project="Sdk.targets" Sdk="Other.Sdk" Version="1.2.3" />
            </Project>
            """);
        PipelineOptions options = this.RepositoryOptions(compiler, fixture);
        options.SdkVersion = PinnedVersion;
        options.SdkPinLocation = SdkPinLocation.GlobalJson;

        RunResult run = await new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() })
            .RunAsync(fixture.Apps);

        Assert.True(run.Succeeded);
        XDocument project = XDocument.Load(fixture.MirroredExtensions);
        Assert.Equal("Gsharp.NET.Sdk", project.Root.Attribute("Sdk").Value);
        XElement import = Assert.Single(project.Root.Elements("Import"));
        Assert.Equal("Other.Sdk", import.Attribute("Sdk").Value);
        Assert.Equal("1.2.3", import.Attribute("Version").Value);
        Assert.Equal("Sdk.targets", import.Attribute("Project").Value);
    }

    /// <summary>Copied native projects use the run's pin while template payloads remain untouched.</summary>
    /// <param name="location">The pin mode.</param>
    /// <returns>A task representing the asynchronous test.</returns>
    [Theory]
    [InlineData(SdkPinLocation.ProjectFile)]
    [InlineData(SdkPinLocation.GlobalJson)]
    public async Task Migrate_RebindsCopiedNativeProjectsWithoutChangingTemplates(SdkPinLocation location)
    {
        string compiler = FindCompiler();
        Assert.NotNull(compiler);
        Fixture fixture = this.CreateFixture(sourceGlobalJson: null);
        string nativeDirectory = Path.Combine(fixture.Source, "samples", "ConcurrencyPatterns", "gsharp");
        Directory.CreateDirectory(nativeDirectory);
        const string nativeXml = """<Project Sdk="Gsharp.NET.Sdk/0.4.591;Other.Sdk/1.2.3" />""";
        File.WriteAllText(Path.Combine(nativeDirectory, "Patterns.gsproj"), nativeXml);
        string templateDirectory = Path.Combine(fixture.Source, "templates", "dotnet");
        Directory.CreateDirectory(Path.Combine(templateDirectory, ".template.config"));
        File.WriteAllText(Path.Combine(templateDirectory, ".template.config", "template.json"), "{}");
        const string templateXml = """<Project Sdk="Gsharp.NET.Sdk/$sdkVersion$" />""";
        const string templateGlobalJson = """{ "msbuild-sdks": { "Gsharp.NET.Sdk": "$sdkVersion$" } }""";
        File.WriteAllText(Path.Combine(templateDirectory, "Template.gsproj"), templateXml);
        Directory.CreateDirectory(Path.Combine(templateDirectory, "nested"));
        File.WriteAllText(Path.Combine(templateDirectory, "nested", "global.json"), templateGlobalJson);
        string visualDirectory = Path.Combine(fixture.Source, "templates", "visual");
        Directory.CreateDirectory(Path.Combine(visualDirectory, "child", "settings"));
        File.WriteAllText(
            Path.Combine(visualDirectory, "Template.vstemplate"),
            """<VSTemplate xmlns="http://schemas.microsoft.com/developer/vstemplate/2005"><TemplateContent><Project File="child\Template.gsproj"><Folder Name="settings"><ProjectItem>global.json</ProjectItem></Folder></Project></TemplateContent></VSTemplate>""");
        File.WriteAllText(Path.Combine(visualDirectory, "child", "Template.gsproj"), templateXml);
        File.WriteAllText(Path.Combine(visualDirectory, "child", "settings", "global.json"), templateGlobalJson);
        File.WriteAllText(
            Path.Combine(visualDirectory, "NotTemplate.gsproj"),
            """<Project Sdk="Gsharp.NET.Sdk/0.4.591" />""");
        PipelineOptions options = this.RepositoryOptions(compiler, fixture);
        options.SdkVersion = PinnedVersion;
        options.SdkPinLocation = location;

        RunResult migrated = await new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() })
            .RunAsync(fixture.Apps);

        Assert.True(migrated.Succeeded);
        string moniker = location == SdkPinLocation.GlobalJson ? "Gsharp.NET.Sdk" : "Gsharp.NET.Sdk/" + PinnedVersion;
        string native = Path.Combine(fixture.Destination, "samples", "ConcurrencyPatterns", "gsharp", "Patterns.gsproj");
        Assert.Equal(moniker + ";Other.Sdk/1.2.3", SdkAttribute(native));
        Assert.Equal(
            moniker,
            SdkAttribute(Path.Combine(fixture.Destination, "templates", "visual", "NotTemplate.gsproj")));
        Assert.Equal(
            templateXml,
            File.ReadAllText(Path.Combine(fixture.Destination, "templates", "dotnet", "Template.gsproj")));
        Assert.Equal(
            templateXml,
            File.ReadAllText(Path.Combine(fixture.Destination, "templates", "visual", "child", "Template.gsproj")));
        Assert.Equal(
            templateGlobalJson,
            File.ReadAllText(Path.Combine(fixture.Destination, "templates", "dotnet", "nested", "global.json")));
        Assert.Equal(
            templateGlobalJson,
            File.ReadAllText(Path.Combine(fixture.Destination, "templates", "visual", "child", "settings", "global.json")));
        var probe = new PinProbeStage();
        RunResult validated = await new MigrationPipeline(this.ValidateOptions(compiler, fixture), new IMigrationStage[] { probe })
            .ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(options.ArtifactRoot, migrated.RunId));
        Assert.True(validated.Succeeded);
        Assert.Equal(moniker, Assert.Single(probe.Observations).SdkMoniker);

        File.WriteAllText(native, nativeXml);
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => new MigrationPipeline(this.ValidateOptions(compiler, fixture), new IMigrationStage[] { new PinProbeStage() })
                .ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(options.ArtifactRoot, migrated.RunId)));
        Assert.Contains("0.4.591", error.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// A source <c>global.json</c> that already pins the SDK cannot be mixed
    /// with versioned project attributes: that would build projects against
    /// different SDKs without a word.
    /// </summary>
    /// <returns>A task representing the asynchronous test.</returns>
    [Fact]
    public async Task Migrate_PerProjectPin_OverASourceGlobalJsonPin_FailsLoudly()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        Fixture fixture = this.CreateFixture(
            """{ "msbuild-sdks": { "Gsharp.NET.Sdk": "0.0.2-source" } }""");
        PipelineOptions options = this.RepositoryOptions(compiler, fixture);
        options.SdkVersion = PinnedVersion;

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() })
                .RunAsync(fixture.Apps));
        Assert.Contains("--sdk-pin global-json", error.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// <c>validate</c> over a global-json tree builds with the tree's pin and
    /// the bare attribute, without being told: it must never re-resolve a
    /// versioned moniker that would override the tree.
    /// </summary>
    /// <returns>A task representing the asynchronous test.</returns>
    [Fact]
    public async Task Validate_FollowsTheMigratedTreesGlobalJsonPin()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        Fixture fixture = this.CreateFixture(SourceGlobalJson);
        PipelineOptions migrate = this.RepositoryOptions(compiler, fixture);
        migrate.SdkVersion = PinnedVersion;
        migrate.SdkPinLocation = SdkPinLocation.GlobalJson;
        RunResult migrated = await new MigrationPipeline(migrate, new IMigrationStage[] { new TranslateStage() })
            .RunAsync(fixture.Apps);
        Assert.True(migrated.Succeeded);

        var probe = new PinProbeStage();
        PipelineOptions validate = this.ValidateOptions(compiler, fixture);
        RunResult validated = await new MigrationPipeline(validate, new IMigrationStage[] { probe })
            .ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(migrate.ArtifactRoot, migrated.RunId));

        Assert.True(validated.Succeeded);
        PinObservation observation = Assert.Single(probe.Observations);
        Assert.Equal("Gsharp.NET.Sdk", observation.SdkMoniker);
        Assert.Equal(PinnedVersion, observation.AnalyzerVerifierPackageVersion);
    }

    /// <summary>Validation rejects nested configuration without the tree's root pin.</summary>
    /// <param name="nestedJson">The nested configuration.</param>
    /// <param name="actualPin">The pin named in the error.</param>
    /// <returns>A task representing the asynchronous test.</returns>
    [Theory]
    [InlineData("""{ "msbuild-sdks": { "Gsharp.NET.Sdk": "0.3.356" } }""", "0.3.356")]
    [InlineData("""{ "sdk": { "version": "10.0.300", "rollForward": "latestFeature" } }""", "<missing>")]
    public async Task Validate_RejectsNestedGlobalJsonWithoutMatchingRootPin(string nestedJson, string actualPin)
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        Fixture fixture = this.CreateFixture(sourceGlobalJson: null);
        PipelineOptions migrate = this.RepositoryOptions(compiler, fixture);
        migrate.SdkVersion = PinnedVersion;
        migrate.SdkPinLocation = SdkPinLocation.GlobalJson;
        RunResult migrated = await new MigrationPipeline(migrate, new IMigrationStage[] { new TranslateStage() })
            .RunAsync(fixture.Apps);
        Assert.True(migrated.Succeeded);

        File.WriteAllText(
            Path.Combine(fixture.Destination, "src", "Widget", SdkPin.GlobalJsonFileName),
            nestedJson);
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => new MigrationPipeline(this.ValidateOptions(compiler, fixture), new IMigrationStage[] { new PinProbeStage() })
                .ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(migrate.ArtifactRoot, migrated.RunId)));

        Assert.Contains("Nested global.json", error.Message, StringComparison.Ordinal);
        Assert.Contains("src/Widget/global.json", error.Message, StringComparison.Ordinal);
        Assert.Contains(actualPin, error.Message, StringComparison.Ordinal);
    }

    /// <summary>Validation checks pins in excluded mirrored projects, not just translated projects.</summary>
    /// <returns>A task representing the asynchronous test.</returns>
    [Fact]
    public async Task Validate_RejectsAProjectPinInAnExcludedMirroredProject()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        Fixture fixture = this.CreateFixture(sourceGlobalJson: null);
        PipelineOptions migrate = this.RepositoryOptions(compiler, fixture);
        migrate.SdkVersion = PinnedVersion;
        migrate.SdkPinLocation = SdkPinLocation.GlobalJson;
        RunResult migrated = await new MigrationPipeline(migrate, new IMigrationStage[] { new TranslateStage() })
            .RunAsync(fixture.Apps);
        Assert.True(migrated.Succeeded);

        System.Xml.Linq.XDocument project = XDocument.Load(fixture.MirroredLegacy);
        project.Root.SetAttributeValue("Sdk", "Gsharp.NET.Sdk/0.3.1");
        project.Save(fixture.MirroredLegacy);

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => new MigrationPipeline(this.ValidateOptions(compiler, fixture), new IMigrationStage[] { new PinProbeStage() })
                .ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(migrate.ArtifactRoot, migrated.RunId)));
        Assert.Contains("both in global.json", error.Message, StringComparison.Ordinal);
        Assert.Contains("0.3.1", error.Message, StringComparison.Ordinal);
    }

    /// <summary>An explicit <c>validate --sdk-version</c> that disagrees with the tree is an error, never a tie-break.</summary>
    /// <returns>A task representing the asynchronous test.</returns>
    [Fact]
    public async Task Validate_SdkVersionThatDisagreesWithTheTree_Throws()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        Fixture fixture = this.CreateFixture(sourceGlobalJson: null);
        PipelineOptions migrate = this.RepositoryOptions(compiler, fixture);
        migrate.SdkVersion = PinnedVersion;
        migrate.SdkPinLocation = SdkPinLocation.GlobalJson;
        RunResult migrated = await new MigrationPipeline(migrate, new IMigrationStage[] { new TranslateStage() })
            .RunAsync(fixture.Apps);
        Assert.True(migrated.Succeeded);

        PipelineOptions validate = this.ValidateOptions(compiler, fixture);
        validate.SdkVersion = "0.0.3-other";
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => new MigrationPipeline(validate, new IMigrationStage[] { new PinProbeStage() })
                .ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(migrate.ArtifactRoot, migrated.RunId)));
        Assert.Contains(PinnedVersion, error.Message, StringComparison.Ordinal);
        Assert.Contains("0.0.3-other", error.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// Per-project mode across the migrate/validate split: validate keeps the
    /// version the migrated projects record instead of re-resolving the
    /// newest local package, which would rewrite every project.
    /// </summary>
    /// <returns>A task representing the asynchronous test.</returns>
    [Fact]
    public async Task Validate_KeepsThePerProjectPinTheMigratedTreeRecords()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        Fixture fixture = this.CreateFixture(sourceGlobalJson: null);
        PipelineOptions migrate = this.RepositoryOptions(compiler, fixture);
        migrate.SdkVersion = PinnedVersion;
        RunResult migrated = await new MigrationPipeline(migrate, new IMigrationStage[] { new TranslateStage() })
            .RunAsync(fixture.Apps);
        Assert.True(migrated.Succeeded);

        foreach (string projectPath in Directory.EnumerateFiles(
            fixture.Destination,
            "*.csproj",
            SearchOption.AllDirectories))
        {
            XDocument project = XDocument.Load(projectPath);
            if (SdkPin.IsGsharpSdkAttribute(project.Root?.Attribute("Sdk")?.Value))
            {
                project.Root.SetAttributeValue("Sdk", "Microsoft.NET.Sdk");
                project.Save(projectPath);
            }
        }

        var probe = new PinProbeStage();
        RunResult validated = await new MigrationPipeline(this.ValidateOptions(compiler, fixture), new IMigrationStage[] { probe })
            .ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(migrate.ArtifactRoot, migrated.RunId));

        Assert.True(validated.Succeeded);
        PinObservation observation = Assert.Single(probe.Observations);
        Assert.Equal("Gsharp.NET.Sdk/" + PinnedVersion, observation.SdkMoniker);
        Assert.Equal(PinnedVersion, observation.AnalyzerVerifierPackageVersion);

        PipelineOptions disagreeing = this.ValidateOptions(compiler, fixture);
        disagreeing.SdkVersion = "0.0.3-other";
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => new MigrationPipeline(disagreeing, new IMigrationStage[] { new PinProbeStage() })
                .ValidateAsync(fixture.Apps, fixture.Apps, Path.Combine(migrate.ArtifactRoot, migrated.RunId)));
        Assert.Contains(PinnedVersion, error.Message, StringComparison.Ordinal);
    }

    private static string SdkAttribute(string projectPath) =>
        XDocument.Load(projectPath).Root?.Attribute("Sdk")?.Value;

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }

    private PipelineOptions RepositoryOptions(string compiler, Fixture fixture)
    {
        var options = new PipelineOptions
        {
            GscPath = compiler,
            SourceRoot = fixture.Source,
            OutputRoot = fixture.Destination,
            ArtifactRoot = Path.Combine(this.root, "runs"),
            OutputLayout = MigrationOutputLayout.Repository,
            Config = "Release",
        };
        options.ExcludedProjectPaths.AddRange(fixture.ExcludedProjects);
        return options;
    }

    private PipelineOptions ValidateOptions(string compiler, Fixture fixture)
    {
        var options = new PipelineOptions
        {
            GscPath = compiler,
            SourceRoot = fixture.Source,
            OutputRoot = fixture.Destination,
            ArtifactRoot = Path.Combine(this.root, "validate-runs"),
            Config = "Release",
        };
        options.ExcludedProjectPaths.AddRange(fixture.ExcludedProjects);
        return options;
    }

    // One translated library plus one excluded, already-G# project built with
    // an imported bootstrap SDK (the src/Sdk/Gsharp.Extensions shape the
    // mirror rebinds onto the pinned SDK).
    private Fixture CreateFixture(string sourceGlobalJson)
    {
        string source = Path.Combine(this.root, "source");
        string widgetDirectory = Path.Combine(source, "src", "Widget");
        string extensionsDirectory = Path.Combine(source, "src", "Extensions");
        Directory.CreateDirectory(widgetDirectory);
        Directory.CreateDirectory(extensionsDirectory);

        string widget = Path.Combine(widgetDirectory, "Widget.csproj");
        File.WriteAllText(
            widget,
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup>" +
            "<TargetFramework>net10.0</TargetFramework>" +
            "<Nullable>enable</Nullable>" +
            "</PropertyGroup></Project>");
        File.WriteAllText(
            Path.Combine(widgetDirectory, "Widget.cs"),
            "namespace Widget { public static class Answer { public static int Value() => 42; } }");

        string extensions = Path.Combine(extensionsDirectory, "Extensions.csproj");
        File.WriteAllText(
            extensions,
            "<Project><Import Project=\"bootstrap.targets\" /><PropertyGroup>" +
            "<TargetFramework>net10.0</TargetFramework>" +
            "</PropertyGroup></Project>");
        File.WriteAllText(Path.Combine(extensionsDirectory, "bootstrap.targets"), "<Project />");
        File.WriteAllText(
            Path.Combine(extensionsDirectory, "Extensions.gs"),
            "namespace Extensions\n\npublic func Two() int {\n    return 2\n}\n");

        // An excluded, already-G# project that pins an older SDK version
        // itself, and an excluded project on another SDK entirely.
        string legacyDirectory = Path.Combine(source, "src", "Legacy");
        Directory.CreateDirectory(legacyDirectory);
        string legacy = Path.Combine(legacyDirectory, "Legacy.csproj");
        File.WriteAllText(
            legacy,
            "<Project Sdk=\"Gsharp.NET.Sdk/0.3.1\"><PropertyGroup>" +
            "<TargetFramework>net10.0</TargetFramework>" +
            "</PropertyGroup></Project>");
        File.WriteAllText(
            Path.Combine(legacyDirectory, "Legacy.gs"),
            "namespace Legacy\n\npublic func Three() int {\n    return 3\n}\n");
        string docsDirectory = Path.Combine(source, "src", "Docs");
        Directory.CreateDirectory(docsDirectory);
        string docs = Path.Combine(docsDirectory, "Docs.csproj");
        File.WriteAllText(docs, "<Project Sdk=\"Microsoft.Build.NoTargets/3.7.0\" />");

        if (sourceGlobalJson is not null)
        {
            File.WriteAllText(Path.Combine(source, "global.json"), sourceGlobalJson);
        }

        string destination = Path.Combine(this.root, "destination");
        return new Fixture(
            source,
            destination,
            new[] { extensions, legacy, docs },
            Path.Combine(destination, "src", "Widget", "Widget.gsproj"),
            Path.Combine(destination, "src", "Extensions", "Extensions.csproj"),
            Path.Combine(destination, "src", "Legacy", "Legacy.csproj"),
            Path.Combine(destination, "src", "Docs", "Docs.csproj"),
            new[]
            {
                new CorpusApp(
                    "src/Widget/Widget.csproj",
                    widget,
                    TargetKind.Library,
                    relativeProjectPath: Path.Combine("src", "Widget", "Widget.csproj")),
            });
    }

    private sealed record Fixture(
        string Source,
        string Destination,
        IReadOnlyList<string> ExcludedProjects,
        string MirroredWidget,
        string MirroredExtensions,
        string MirroredLegacy,
        string MirroredDocs,
        IReadOnlyList<CorpusApp> Apps);

    private readonly record struct PinObservation(string SdkMoniker, string AnalyzerVerifierPackageVersion);

    /// <summary>Records the SDK pin a validate run hands its stages.</summary>
    private sealed class PinProbeStage : IMigrationStage
    {
        public MigrationStageKind Kind => MigrationStageKind.Compile;

        internal List<PinObservation> Observations { get; } = new List<PinObservation>();

        public Task<StageOutcome> ExecuteAsync(
            StageExecutionContext context,
            CancellationToken cancellationToken = default)
        {
            this.Observations.Add(new PinObservation(
                context.Options.RepositorySdkMoniker,
                context.Options.RepositoryAnalyzerVerifierPackageVersion));
            return Task.FromResult(StageOutcome.Passed());
        }
    }
}
