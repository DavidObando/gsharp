using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Xml.Linq;
using Xunit;

namespace GSharp.VisualStudio;

public sealed class ProjectDebugAcceptanceTests
{
    private static readonly string[] ExpectedScenarioIds =
    {
        "VS26-NATIVE-BUILD",
        "VS26-NATIVE-DEBUG-ATTACH",
        "VS26-NATIVE-DEBUG-BREAKPOINTS",
        "VS26-NATIVE-DEBUG-LAUNCH",
        "VS26-NATIVE-PROJECT-SYSTEM",
        "VS26-NATIVE-RUN",
    };

    [Fact]
    public void Manifest_CoversExecutableProjectAndDebugPaths()
    {
        string fixtureRoot = FindFixtureRoot();
        using JsonDocument manifest = JsonDocument.Parse(File.ReadAllText(
            Path.Combine(fixtureRoot, "project-debug.acceptance.json")));

        Assert.Equal(1, manifest.RootElement.GetProperty("schemaVersion").GetInt32());
        Assert.True(File.Exists(Path.Combine(
            fixtureRoot,
            RequiredString(manifest.RootElement, "solution"))));
        Assert.True(File.Exists(Path.Combine(
            fixtureRoot,
            RequiredString(manifest.RootElement, "driver"))));

        JsonElement[] projects = manifest.RootElement.GetProperty("projects")
            .EnumerateArray().ToArray();
        Assert.Equal(
            new[] { "avalonia", "console", "library", "web" },
            projects.Select(project => RequiredString(project, "kind")).OrderBy(value => value));

        foreach (JsonElement project in projects)
        {
            string path = Path.Combine(
                fixtureRoot,
                RequiredString(project, "path").Replace('/', Path.DirectorySeparatorChar));
            Assert.True(File.Exists(path), $"Missing acceptance project: {path}");

            XDocument xml = XDocument.Load(path);
            Assert.StartsWith("Gsharp.NET.Sdk/", (string?)xml.Root?.Attribute("Sdk"));
            Assert.Equal("net10.0", Property(xml, "TargetFramework"));
            Assert.Equal("portable", Property(xml, "DebugType"));

            string[] operations = RequiredStrings(project, "operations");
            Assert.Contains("restore", operations);
            Assert.Contains("build", operations);
            Assert.Contains("rebuild", operations);
            Assert.Contains("clean", operations);

            bool runnable = !string.Equals(
                RequiredString(project, "kind"),
                "library",
                StringComparison.Ordinal);
            Assert.Equal(runnable ? "Exe" : "Library", Property(xml, "OutputType"));
            Assert.Equal(runnable, project.GetProperty("startup").GetBoolean());
            if (runnable)
            {
                Assert.Contains("run", operations);
                Assert.Contains("debug", operations);
                string launchSettingsPath = Path.Combine(
                    Path.GetDirectoryName(path)!,
                    "Properties",
                    "launchSettings.json");
                Assert.True(File.Exists(launchSettingsPath));
                using JsonDocument launchSettings = JsonDocument.Parse(
                    File.ReadAllText(launchSettingsPath));
                Assert.All(
                    launchSettings.RootElement.GetProperty("profiles").EnumerateObject(),
                    profile => Assert.Equal(
                        "Project",
                        RequiredString(profile.Value, "commandName")));
            }
        }

        JsonElement[] scenarios = manifest.RootElement.GetProperty("scenarios")
            .EnumerateArray().ToArray();
        Assert.Equal(
            ExpectedScenarioIds,
            scenarios.Select(scenario => RequiredString(scenario, "id")).OrderBy(value => value));

        string matrixPath = Path.Combine(
            FindRepositoryRoot(),
            "src",
            "vs-gsharp",
            "test",
            "VsGsharp.UnitTests",
            "TestData",
            "visual-studio-2026-feature-matrix.json");
        using JsonDocument matrix = JsonDocument.Parse(File.ReadAllText(matrixPath));
        string[] matrixCoverage = matrix.RootElement.GetProperty("features")
            .EnumerateArray()
            .SelectMany(feature => RequiredStrings(feature, "acceptanceCoverageIds"))
            .ToArray();
        Assert.All(ExpectedScenarioIds, id => Assert.Contains(id, matrixCoverage));
    }

    [Fact]
    public void Fixture_ExercisesReferencesGeneratedSourcesAndPortablePdbDocuments()
    {
        string fixtureRoot = FindFixtureRoot();
        XDocument console = XDocument.Load(Path.Combine(fixtureRoot, "Console", "Console.gsproj"));
        Assert.Contains(
            console.Descendants().Where(element => element.Name.LocalName == "ProjectReference"),
            item => ((string?)item.Attribute("Include"))?.EndsWith(
                "Library.gsproj",
                StringComparison.Ordinal) == true);
        Assert.Contains(
            console.Descendants().Where(element => element.Name.LocalName == "PackageReference"),
            item => (string?)item.Attribute("Include") == "Newtonsoft.Json");

        XDocument avalonia = XDocument.Load(Path.Combine(
            fixtureRoot,
            "Avalonia",
            "AvaloniaFixture.gsproj"));
        Assert.Contains(
            avalonia.Descendants().Where(element => element.Name.LocalName == "PackageReference"),
            item => (string?)item.Attribute("Include") == "Avalonia");
        string mainView = File.ReadAllText(Path.Combine(fixtureRoot, "Avalonia", "MainView.gs"));
        Assert.Contains("InitializeComponent()", mainView);
        Assert.True(File.Exists(Path.Combine(fixtureRoot, "Avalonia", "MainView.axaml")));

        using JsonDocument manifest = JsonDocument.Parse(File.ReadAllText(
            Path.Combine(fixtureRoot, "project-debug.acceptance.json")));
        JsonElement breakpointScenario = manifest.RootElement.GetProperty("scenarios")
            .EnumerateArray()
            .Single(scenario =>
                RequiredString(scenario, "id") == "VS26-NATIVE-DEBUG-BREAKPOINTS");
        Assert.Equal(
            new[]
            {
                "breakpoint-bind",
                "handled-exception-step",
                "inspect-locals",
                "step-into",
                "step-over",
                "verify-portable-pdb-documents",
            },
            RequiredStrings(breakpointScenario, "debugChecks").OrderBy(value => value));

        foreach (JsonElement breakpoint in breakpointScenario.GetProperty("breakpoints").EnumerateArray())
        {
            string source = Path.Combine(
                fixtureRoot,
                RequiredString(breakpoint, "source").Replace('/', Path.DirectorySeparatorChar));
            string marker = RequiredString(breakpoint, "marker");
            Assert.Equal(1, Count(File.ReadAllText(source), marker));
        }

        foreach (string document in RequiredStrings(breakpointScenario, "pdbDocuments"))
        {
            Assert.True(File.Exists(Path.Combine(
                fixtureRoot,
                document.Replace('/', Path.DirectorySeparatorChar))));
        }
    }

    [Fact]
    public void Sdk_UsesStandardManagedCpsAndForwardsDebugArtifacts()
    {
        string root = FindRepositoryRoot();
        string sdkRoot = Path.Combine(root, "src", "Sdk", "Gsharp.NET.Sdk");
        XDocument sdkTargets = XDocument.Load(Path.Combine(sdkRoot, "Sdk", "Sdk.targets"));
        string[] capabilities = sdkTargets.Descendants()
            .Where(element => element.Name.LocalName == "ProjectCapability")
            .Select(element => (string?)element.Attribute("Include") ?? string.Empty)
            .ToArray();
        Assert.Contains("Managed", capabilities);
        Assert.Contains("AssemblyReferences", capabilities);
        Assert.Contains("ProjectReferences", capabilities);
        Assert.Contains("PackageReferences", capabilities);
        Assert.Contains("DependenciesTree", capabilities);
        Assert.Contains("LaunchProfiles", capabilities);
        Assert.Contains(
            "Microsoft.Managed.DesignTime.targets",
            Property(sdkTargets, "GsharpDesignTimeTargetsPath"));
        Assert.Contains(
            sdkTargets.Descendants().Where(element => element.Name.LocalName == "Import"),
            import => (string?)import.Attribute("Project") == "$(GsharpDesignTimeTargetsPath)");

        XDocument coreTargets = XDocument.Load(Path.Combine(
            sdkRoot,
            "build",
            "Gsharp.NET.Core.Sdk.targets"));
        XElement buildTask = coreTargets.Descendants()
            .Single(element => element.Name.LocalName == "BuildTask");
        Assert.Equal("$(MSBuildProjectDirectory)", (string?)buildTask.Attribute("BasePath"));
        Assert.Equal("$(DebugType)", (string?)buildTask.Attribute("DebugType"));
        Assert.Equal("@(_DebugSymbolsIntermediatePath)", (string?)buildTask.Attribute("PdbFile"));
        Assert.Equal("$(SourceLink)", (string?)buildTask.Attribute("SourceLink"));
        Assert.Contains(
            coreTargets.Descendants().Where(element => element.Name.LocalName == "Target"),
            target => (string?)target.Attribute("Name") == "CompileDesignTime");
        Assert.Contains(
            coreTargets.Descendants().Where(element => element.Name.LocalName == "FileWrites"),
            item => (string?)item.Attribute("Include") == "@(_DebugSymbolsIntermediatePath)");
        Assert.Contains(
            coreTargets.Descendants().Where(element => element.Name.LocalName == "Compile"),
            item => (string?)item.Attribute("Include") == "@(_GsharpGeneratedGsFile)");

        string compiler = File.ReadAllText(Path.Combine(
            root,
            "src",
            "Compiler",
            "Program.cs"));
        Assert.Contains("var fullPath = Path.GetFullPath(path);", compiler);
        Assert.Contains("SyntaxTree.Load(fullPath)", compiler);
        Assert.Contains("pdbOutputPath = Path.GetFullPath(pdbOutputPath);", compiler);
    }

    [Fact]
    public void NativeCps_OwnsTheProjectBrowseObjectContext()
    {
        string extensionSource = Path.Combine(
            FindRepositoryRoot(),
            "src",
            "vs-gsharp",
            "src",
            "VsGsharp",
            "GSharpBrowseObjectContext.cs");
        Assert.False(
            File.Exists(extensionSource),
            "Do not aggregate a partial IVsBrowseObjectContext over CPS's native project hierarchy.");
    }

    private static string Property(XDocument document, string name)
        => document.Descendants()
            .Single(element => element.Name.LocalName == name)
            .Value;

    private static int Count(string value, string needle)
    {
        int count = 0;
        int index = 0;
        while ((index = value.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += needle.Length;
        }

        return count;
    }

    private static string RequiredString(JsonElement element, string property)
    {
        string? value = element.GetProperty(property).GetString();
        Assert.False(string.IsNullOrWhiteSpace(value));
        return value!;
    }

    private static string[] RequiredStrings(JsonElement element, string property)
        => element.GetProperty(property).EnumerateArray()
            .Select(value => value.GetString() ?? string.Empty)
            .ToArray();

    private static string FindFixtureRoot()
        => Path.Combine(
            FindRepositoryRoot(),
            "src",
            "vs-gsharp",
            "test",
            "ProjectDebugFixtures");

    private static string FindRepositoryRoot()
    {
        DirectoryInfo? directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "GSharp.sln")))
        {
            directory = directory.Parent;
        }

        return directory?.FullName
            ?? throw new DirectoryNotFoundException("Could not locate the GSharp repository.");
    }
}
