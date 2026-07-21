using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Xml.Linq;
using Xunit;

namespace GSharp.VisualStudio;

public sealed class TestExplorerFixtureContractTests
{
    private static readonly string[] RequiredFrameworks =
    {
        "mstest",
        "nunit",
        "xunit",
    };

    private static readonly string[] RequiredScenarios =
    {
        "discovery-and-source-mapping",
        "run-selected",
        "debug-selected",
        "cancellation",
        "failure-output",
        "refresh-after-build",
        "portable-pdb-stepping",
    };

    [Fact]
    public void FixturesUseOnlyStandardFrameworkAdapters()
    {
        string fixtureRoot = FixtureRoot();
        using JsonDocument manifest = LoadManifest(fixtureRoot);
        JsonElement[] frameworks = manifest.RootElement.GetProperty("frameworks")
            .EnumerateArray().ToArray();
        Assert.Equal(
            RequiredFrameworks,
            frameworks.Select(item => RequiredString(item, "id")).OrderBy(value => value));

        string fixtureSolution = File.ReadAllText(Path.Combine(
            fixtureRoot,
            "TestExplorerFixtures.sln"));
        Assert.Equal(
            frameworks.Length,
            fixtureSolution.Split('\n').Count(line => line.StartsWith("Project(", StringComparison.Ordinal)));
        Assert.All(
            frameworks,
            framework => Assert.Contains($"\"{RequiredString(framework, "project")}\"", fixtureSolution));

        foreach (JsonElement framework in frameworks)
        {
            string projectPath = Path.Combine(
                fixtureRoot,
                RequiredString(framework, "project").Replace('/', Path.DirectorySeparatorChar));
            XDocument project = XDocument.Load(projectPath);
            XElement root = Assert.IsType<XElement>(project.Root);
            Assert.Equal("Gsharp.NET.Sdk/0.3.159", root.Attribute("Sdk")?.Value);
            Assert.Equal("true", Property(root, "IsTestProject"));
            Assert.Equal("portable", Property(root, "DebugType"));

            Dictionary<string, string> packages = root.Descendants("PackageReference")
                .ToDictionary(
                    item => item.Attribute("Include")?.Value ?? string.Empty,
                    item => item.Attribute("Version")?.Value ?? string.Empty,
                    StringComparer.Ordinal);
            Assert.Equal("17.11.1", packages["Microsoft.NET.Test.Sdk"]);

            JsonElement testFramework = framework.GetProperty("testFramework");
            JsonElement adapter = framework.GetProperty("adapter");
            Assert.Equal(
                RequiredString(testFramework, "version"),
                packages[RequiredString(testFramework, "package")]);
            Assert.Equal(
                RequiredString(adapter, "version"),
                packages[RequiredString(adapter, "package")]);
            Assert.Equal(3, packages.Count);
        }
    }

    [Fact]
    public void ManifestPinsAcceptanceScenariosAndSourceLines()
    {
        string fixtureRoot = FixtureRoot();
        using JsonDocument manifest = LoadManifest(fixtureRoot);
        Assert.Equal(1, manifest.RootElement.GetProperty("schemaVersion").GetInt32());
        Assert.Equal(
            "validated-with-manual-ui-gates",
            RequiredString(manifest.RootElement, "executionStatus"));

        JsonElement[] scenarios = manifest.RootElement.GetProperty("scenarios")
            .EnumerateArray().ToArray();
        Assert.Equal(
            RequiredScenarios.OrderBy(value => value),
            scenarios.Select(item => RequiredString(item, "id")).OrderBy(value => value));
        Assert.Equal(
            "manual-required",
            RequiredString(
                scenarios.Single(scenario => RequiredString(scenario, "id") == "debug-selected"),
                "validation"));
        Assert.All(
            scenarios.Where(scenario => RequiredString(scenario, "id") != "debug-selected"),
            scenario => Assert.StartsWith("automated", RequiredString(scenario, "validation")));

        foreach (JsonElement framework in manifest.RootElement.GetProperty("frameworks").EnumerateArray())
        {
            JsonElement discovery = framework.GetProperty("expectedDiscovery");
            Assert.Equal(
                discovery.GetProperty("total").GetInt32(),
                discovery.GetProperty("passedOnRunAll").GetInt32()
                    + discovery.GetProperty("failedOnRunAll").GetInt32()
                    + discovery.GetProperty("skippedOnRunAll").GetInt32());
            Assert.True(discovery.GetProperty("parameterizedCases").GetInt32() > 1);

            string projectDirectory = Path.GetDirectoryName(Path.Combine(
                fixtureRoot,
                RequiredString(framework, "project").Replace('/', Path.DirectorySeparatorChar)))!;
            foreach (JsonElement mapping in framework.GetProperty("sourceMappings").EnumerateArray())
            {
                string sourcePath = Path.Combine(projectDirectory, RequiredString(mapping, "file"));
                string[] lines = File.ReadAllLines(sourcePath);
                int line = mapping.GetProperty("line").GetInt32();
                Assert.InRange(line, 1, lines.Length);
                Assert.Contains(RequiredString(mapping, "anchor"), lines[line - 1]);
            }
        }
    }

    private static string Property(XElement project, string name)
        => project.Descendants(name).Single().Value;

    private static JsonDocument LoadManifest(string fixtureRoot)
        => JsonDocument.Parse(File.ReadAllText(Path.Combine(
            fixtureRoot,
            "test-explorer-acceptance.json")));

    private static string RequiredString(JsonElement element, string property)
    {
        string? value = element.GetProperty(property).GetString();
        Assert.False(string.IsNullOrWhiteSpace(value), $"'{property}' must not be empty.");
        return value!;
    }

    private static string FixtureRoot()
    {
        DirectoryInfo? directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "GSharp.sln")))
        {
            directory = directory.Parent;
        }

        return Path.Combine(
            directory?.FullName ?? throw new DirectoryNotFoundException("Could not locate repository root."),
            "src",
            "vs-gsharp",
            "test",
            "TestExplorerFixtures");
    }
}
