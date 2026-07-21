using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using Xunit;

namespace GSharp.VisualStudio;

public sealed class VisualStudioParityContractTests
{
    private static readonly string[] Areas =
    {
        "editor",
        "navigation",
        "testing",
        "debugging",
        "project",
        "assets",
        "config",
        "lifecycle",
    };

    private static readonly string[] Dispositions =
    {
        "standard-lsp",
        "native-vs-equivalent",
        "native-adapter-required",
        "intentionally-not-applicable",
        "pending-capability-probe",
    };

    private static readonly string[] ContributionKinds =
    {
        "languages",
        "grammars",
        "snippets",
        "configurationDefaults",
        "themes",
        "configuration",
        "commands",
        "keybindings",
        "debuggers",
        "breakpoints",
        "taskDefinitions",
    };

    [Fact]
    public void Matrix_HasUniqueCompleteEntriesAndVerifiableDeadEvidence()
    {
        string root = FindRepositoryRoot();
        using JsonDocument matrix = LoadMatrix(root);
        JsonElement[] features = matrix.RootElement.GetProperty("features")
            .EnumerateArray().ToArray();

        Assert.Equal(1, matrix.RootElement.GetProperty("schemaVersion").GetInt32());
        Assert.Equal("Visual Studio 2026", matrix.RootElement.GetProperty("target").GetString());
        Assert.Equal(
            Areas.OrderBy(value => value),
            features.Select(feature => RequiredString(feature, "area")).Distinct().OrderBy(value => value));
        AssertUnique(features.Select(feature => RequiredString(feature, "id")), "feature id");
        AssertUnique(
            features.SelectMany(feature => RequiredStrings(feature, "acceptanceCoverageIds")),
            "acceptance coverage id");

        foreach (JsonElement feature in features)
        {
            RequiredString(feature, "title");
            Assert.Contains(RequiredString(feature, "area"), Areas);
            Assert.Contains(RequiredString(feature, "vsPath"), Dispositions);
            Assert.NotEmpty(RequiredStrings(feature, "implementationIds"));
            Assert.NotEmpty(RequiredStrings(feature, "acceptanceCoverageIds"));
            RequiredStrings(feature, "serverCapabilities");
            RequiredStrings(feature, "vscodeContributions");
            RequiredStrings(feature, "vscodeCommands");
        }

        JsonElement[] dead = matrix.RootElement.GetProperty("deadContributions")
            .EnumerateArray().ToArray();
        AssertUnique(dead.Select(item => RequiredString(item, "id")), "dead contribution id");
        foreach (JsonElement item in dead)
        {
            Assert.False(string.IsNullOrWhiteSpace(RequiredString(item, "reason")));
            JsonElement[] evidence = item.GetProperty("evidence").EnumerateArray().ToArray();
            Assert.NotEmpty(evidence);
            foreach (JsonElement proof in evidence)
            {
                string path = Path.Combine(
                    root,
                    RequiredString(proof, "file").Replace('/', Path.DirectorySeparatorChar));
                Assert.True(File.Exists(path), $"Dead-contribution evidence does not exist: {path}");
                Assert.Contains(RequiredString(proof, "contains"), File.ReadAllText(path));
            }
        }
    }

    [Fact]
    public void EveryAdvertisedServerCapability_HasOneVisualStudioDisposition()
    {
        string root = FindRepositoryRoot();
        string source = File.ReadAllText(Path.Combine(
            root,
            "src",
            "LanguageServer",
            "Server",
            "ServerCapabilitiesFactory.cs"));
        Match[] matches = Regex.Matches(
            source,
            @"^(?<indent>[ \t]*)(?<name>[A-Z]\w+(?:Provider|Sync))\s*=",
            RegexOptions.Multiline).Cast<Match>().ToArray();
        int topLevelIndent = matches.Min(match => match.Groups["indent"].Value.Length);
        string[] advertised = matches
            .Where(match => match.Groups["indent"].Value.Length == topLevelIndent)
            .Select(match => match.Groups["name"].Value)
            .OrderBy(value => value)
            .ToArray();

        using JsonDocument matrix = LoadMatrix(root);
        string[] dispositions = matrix.RootElement.GetProperty("features")
            .EnumerateArray()
            .SelectMany(feature => RequiredStrings(feature, "serverCapabilities"))
            .ToArray();

        AssertUnique(dispositions, "server capability disposition");
        Assert.Equal(advertised, dispositions.OrderBy(value => value));
    }

    [Fact]
    public void UndocumentedEditorFeatures_HaveEvidenceBackedVisualStudio188Dispositions()
    {
        string root = FindRepositoryRoot();
        using JsonDocument matrix = LoadMatrix(root);
        JsonElement[] features = matrix.RootElement.GetProperty("features")
            .EnumerateArray().ToArray();
        JsonElement[] evidence = matrix.RootElement.GetProperty("capabilityEvidence")
            .EnumerateArray().ToArray();

        AssertUnique(evidence.Select(item => RequiredString(item, "id")), "capability evidence id");
        Dictionary<string, JsonElement> evidenceById = evidence.ToDictionary(
            item => RequiredString(item, "id"));

        string[] featureIds =
        {
            "editor.diagnostics",
            "editor.inlay-hints",
            "editor.linked-editing",
            "editor.selection-ranges",
            "editor.semantic-tokens",
            "navigation.implementation",
            "navigation.type-definition",
        };

        foreach (string featureId in featureIds)
        {
            JsonElement feature = features.Single(
                item => RequiredString(item, "id") == featureId);
            string[] evidenceIds = RequiredStrings(feature, "evidenceIds");
            Assert.NotEmpty(evidenceIds);

            foreach (string evidenceId in evidenceIds)
            {
                Assert.True(evidenceById.TryGetValue(evidenceId, out JsonElement proof));
                Assert.Equal(featureId, RequiredString(proof, "featureId"));
                string evidenceSource = RequiredString(proof, "source");
                if (!evidenceSource.StartsWith("%", StringComparison.Ordinal))
                {
                    Assert.True(File.Exists(Path.Combine(
                        root,
                        evidenceSource.Replace('/', Path.DirectorySeparatorChar))));
                }

                RequiredString(proof, "sourceVersion");
                Assert.NotEmpty(RequiredStrings(proof, "observations"));
            }

            string[] conclusions = evidenceIds
                .Select(id => RequiredString(evidenceById[id], "conclusion"))
                .ToArray();
            string expectedPath = conclusions.Contains("generic-lsp-supported")
                ? "standard-lsp"
                : conclusions.Contains("generic-lsp-unsupported")
                    ? "native-adapter-required"
                    : "pending-capability-probe";
            Assert.Equal(expectedPath, RequiredString(feature, "vsPath"));
        }

        using JsonDocument trace = JsonDocument.Parse(File.ReadAllText(Path.Combine(
            root,
            "src",
            "vs-gsharp",
            "test",
            "VsGsharp.UnitTests",
            "TestData",
            "visual-studio-2026-lsp-capability-trace.json")));
        JsonElement clientCapabilities = trace.RootElement.GetProperty("initializeClientCapabilities");
        Dictionary<string, string> capabilityByFeature = new()
        {
            ["editor.diagnostics"] = "textDocument.diagnostic",
            ["editor.inlay-hints"] = "textDocument.inlayHint",
            ["editor.linked-editing"] = "textDocument.linkedEditingRange",
            ["editor.selection-ranges"] = "textDocument.selectionRange",
            ["editor.semantic-tokens"] = "textDocument.semanticTokens",
            ["navigation.implementation"] = "textDocument.implementation",
            ["navigation.type-definition"] = "textDocument.typeDefinition",
        };
        foreach ((string featureId, string capability) in capabilityByFeature)
        {
            string expectedPath = clientCapabilities.GetProperty(capability).GetBoolean()
                ? "standard-lsp"
                : "native-adapter-required";
            JsonElement feature = features.Single(
                item => RequiredString(item, "id") == featureId);
            Assert.Equal(expectedPath, RequiredString(feature, "vsPath"));
        }

        JsonElement selectionRanges = features.Single(
            item => RequiredString(item, "id") == "editor.selection-ranges");
        string[] selectionConclusions = RequiredStrings(selectionRanges, "evidenceIds")
            .Select(id => RequiredString(evidenceById[id], "conclusion"))
            .OrderBy(value => value)
            .ToArray();
        Assert.Equal(
            new[]
            {
                "generic-lsp-unsupported",
                "no-translation-only-adapter-contract",
                "static-generic-lsp-unsupported",
            },
            selectionConclusions);
    }

    [Fact]
    public void EveryEffectiveVsCodeCommandAndContribution_HasOneDisposition()
    {
        string root = FindRepositoryRoot();
        using JsonDocument package = JsonDocument.Parse(File.ReadAllText(Path.Combine(
            root,
            "src",
            "vscode-gsharp",
            "package.json")));
        JsonElement contributes = package.RootElement.GetProperty("contributes");
        Assert.Equal(
            ContributionKinds.OrderBy(value => value),
            contributes.EnumerateObject().Select(property => property.Name).OrderBy(value => value));

        using JsonDocument matrix = LoadMatrix(root);
        JsonElement[] features = matrix.RootElement.GetProperty("features")
            .EnumerateArray().ToArray();
        string[] covered = features
            .SelectMany(feature => RequiredStrings(feature, "vscodeContributions"))
            .ToArray();
        string[] dead = matrix.RootElement.GetProperty("deadContributions")
            .EnumerateArray()
            .Select(item => RequiredString(item, "id"))
            .ToArray();

        AssertUnique(covered.Concat(dead), "VS Code contribution disposition");
        Assert.Equal(
            ReadContributionIds(contributes).OrderBy(value => value),
            covered.Concat(dead).OrderBy(value => value));

        string sourceRoot = Path.Combine(root, "src", "vscode-gsharp", "src");
        string[] registeredCommands = Directory.GetFiles(sourceRoot, "*.ts", SearchOption.AllDirectories)
            .SelectMany(path => Regex.Matches(
                File.ReadAllText(path),
                @"registerCommand\(\s*['""](?<id>gsharp\.[^'""]+)['""]",
                RegexOptions.Multiline).Cast<Match>())
            .Select(match => match.Groups["id"].Value)
            .Distinct()
            .OrderBy(value => value)
            .ToArray();
        string[] commandDispositions = features
            .SelectMany(feature => RequiredStrings(feature, "vscodeCommands"))
            .ToArray();

        AssertUnique(commandDispositions, "VS Code command disposition");
        Assert.Equal(registeredCommands, commandDispositions.OrderBy(value => value));
    }

    private static IEnumerable<string> ReadContributionIds(JsonElement contributes)
    {
        foreach (JsonElement language in contributes.GetProperty("languages").EnumerateArray())
        {
            yield return $"language:{RequiredString(language, "id")}";
        }

        foreach (JsonElement grammar in contributes.GetProperty("grammars").EnumerateArray())
        {
            yield return $"grammar:{RequiredString(grammar, "scopeName")}";
        }

        foreach (JsonElement snippet in contributes.GetProperty("snippets").EnumerateArray())
        {
            yield return $"snippets:{RequiredString(snippet, "language")}";
        }

        foreach (JsonProperty item in contributes.GetProperty("configurationDefaults").EnumerateObject())
        {
            yield return $"configurationDefaults:{item.Name}";
        }

        foreach (JsonElement theme in contributes.GetProperty("themes").EnumerateArray())
        {
            yield return $"theme:{RequiredString(theme, "label")}";
        }

        foreach (JsonElement section in contributes.GetProperty("configuration").EnumerateArray())
        {
            foreach (JsonProperty setting in section.GetProperty("properties").EnumerateObject())
            {
                yield return $"configuration:{setting.Name}";
            }
        }

        foreach (JsonElement command in contributes.GetProperty("commands").EnumerateArray())
        {
            yield return $"command:{RequiredString(command, "command")}";
        }

        foreach (JsonElement keybinding in contributes.GetProperty("keybindings").EnumerateArray())
        {
            yield return $"keybinding:{RequiredString(keybinding, "command")}";
        }

        foreach (JsonElement debugger in contributes.GetProperty("debuggers").EnumerateArray())
        {
            yield return $"debugger:{RequiredString(debugger, "type")}";
        }

        foreach (JsonElement breakpoint in contributes.GetProperty("breakpoints").EnumerateArray())
        {
            yield return $"breakpoints:{RequiredString(breakpoint, "language")}";
        }

        foreach (JsonElement task in contributes.GetProperty("taskDefinitions").EnumerateArray())
        {
            yield return $"taskDefinition:{RequiredString(task, "type")}";
        }
    }

    private static JsonDocument LoadMatrix(string root)
        => JsonDocument.Parse(File.ReadAllText(Path.Combine(
            root,
            "src",
            "vs-gsharp",
            "test",
            "VsGsharp.UnitTests",
            "TestData",
            "visual-studio-2026-feature-matrix.json")));

    private static string RequiredString(JsonElement element, string property)
    {
        string? value = element.GetProperty(property).GetString();
        Assert.False(string.IsNullOrWhiteSpace(value), $"'{property}' must not be empty.");
        return value!;
    }

    private static string[] RequiredStrings(JsonElement element, string property)
    {
        string[] values = element.GetProperty(property).EnumerateArray()
            .Select(value => value.GetString() ?? string.Empty)
            .ToArray();
        Assert.All(values, value => Assert.False(string.IsNullOrWhiteSpace(value)));
        return values;
    }

    private static void AssertUnique(IEnumerable<string> values, string label)
    {
        string[] duplicates = values.GroupBy(value => value)
            .Where(group => group.Count() > 1)
            .Select(group => group.Key)
            .ToArray();
        Assert.True(duplicates.Length == 0, $"Duplicate {label}: {string.Join(", ", duplicates)}");
    }

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
