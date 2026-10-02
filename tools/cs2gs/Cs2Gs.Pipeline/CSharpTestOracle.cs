// <copyright file="CSharpTestOracle.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cs2Gs.Pipeline;

/// <summary>
/// Issue #4633: the per-test-name oracle for a mirrored test project — the set
/// of test-case display names the ORIGINAL C# project's xUnit discovery
/// reports, captured once per run before validation (see
/// <c>cs2gs capture-test-oracle</c>) and compared name-for-name against the
/// migrated run's TRX by <see cref="TestNameParity"/>.
/// <para>
/// Before this oracle the repo-app parity check was "exit 0 and at least as
/// many cases as the C# original has <c>[Fact]</c> methods": <c>[Theory]</c>
/// rows were not counted at all and no name was ever compared, so a migrated
/// suite could lose thousands of cases (2,371 in <c>test/Core.Tests</c>) and
/// stay green.
/// </para>
/// <para>
/// Discovery, not execution, is the C# side on purpose: listing a suite costs
/// seconds, running the C# originals again would roughly double the nightly.
/// Both sides run with <see cref="RunSettingsArgument"/>, which overrides the
/// repository's <c>methodDisplay: method</c> so every display name is fully
/// qualified (<c>Namespace.Class.Method(args)</c>); with bare method names,
/// two classes' <c>Works</c> tests would be indistinguishable.
/// </para>
/// </summary>
public sealed class CSharpTestOracle
{
    /// <summary>
    /// The VSTest RunSettings override both sides pass after <c>--</c>. It
    /// takes precedence over <c>xunit.runner.json</c>.
    /// </summary>
    public const string RunSettingsArgument = "xUnit.MethodDisplay=ClassAndMethod";

    /// <summary>The line <c>dotnet test --list-tests</c> prints before the names.</summary>
    public const string ListHeader = "The following Tests are available:";

    /// <summary>The suffix of one app's oracle file in the oracle directory.</summary>
    public const string FileSuffix = ".csharp-tests.json";

    private const string ListIndent = "    ";

    /// <summary>Gets or sets the corpus app id this oracle describes.</summary>
    [JsonPropertyName("appId")]
    [JsonPropertyOrder(0)]
    public string AppId { get; set; }

    /// <summary>Gets or sets the number of discovered test cases.</summary>
    [JsonPropertyName("testCount")]
    [JsonPropertyOrder(1)]
    public int TestCount { get; set; }

    /// <summary>Gets or sets the discovered test-case display names, sorted ordinally.</summary>
    [JsonPropertyName("tests")]
    [JsonPropertyOrder(2)]
    public List<string> Tests { get; set; } = new List<string>();

    /// <summary>
    /// The oracle file name for an app: the sanitized app id plus
    /// <see cref="FileSuffix"/>.
    /// </summary>
    /// <param name="appId">The corpus app id.</param>
    /// <returns>The file name (no directory).</returns>
    public static string FileNameFor(string appId)
    {
        if (string.IsNullOrEmpty(appId))
        {
            throw new ArgumentException("An app id is required.", nameof(appId));
        }

        return MigrationPipeline.SanitizeAppId(appId) + FileSuffix;
    }

    /// <summary>
    /// Parses the output of <c>dotnet test --list-tests</c> into display names.
    /// Fails loudly rather than returning an empty list: an oracle with no
    /// names would turn the per-name check into a check of nothing, which is
    /// the exact defect this oracle exists to remove.
    /// </summary>
    /// <param name="output">The captured stdout of the listing.</param>
    /// <returns>The discovered display names, in output order.</returns>
    /// <exception cref="InvalidOperationException">
    /// The output has no listing header, or lists no tests.
    /// </exception>
    public static IReadOnlyList<string> ParseListTestsOutput(string output)
    {
        string[] lines = (output ?? string.Empty).Replace("\r\n", "\n").Split('\n');
        int header = Array.FindIndex(
            lines, line => string.Equals(line.Trim(), ListHeader, StringComparison.Ordinal));
        if (header < 0)
        {
            throw new InvalidOperationException(
                "`dotnet test --list-tests` printed no '" + ListHeader + "' line, so the C# " +
                "test oracle cannot be read. Output tail:\n" + Tail(output));
        }

        var names = new List<string>();
        for (int index = header + 1; index < lines.Length; index++)
        {
            string line = lines[index];
            if (!line.StartsWith(ListIndent, StringComparison.Ordinal))
            {
                // The listing is one contiguous indented block; anything after
                // it (an empty line, a later assembly's banner) ends it.
                if (line.Length == 0)
                {
                    continue;
                }

                break;
            }

            string name = line.Substring(ListIndent.Length).TrimEnd();
            if (name.Length > 0)
            {
                names.Add(name);
            }
        }

        if (names.Count == 0)
        {
            throw new InvalidOperationException(
                "`dotnet test --list-tests` listed zero tests. A C# test project with no " +
                "discoverable tests cannot serve as a parity oracle.");
        }

        return names;
    }

    /// <summary>
    /// Builds an oracle from discovered names, sorted ordinally.
    /// </summary>
    /// <param name="appId">The corpus app id.</param>
    /// <param name="names">The discovered display names.</param>
    /// <returns>The oracle.</returns>
    public static CSharpTestOracle Create(string appId, IEnumerable<string> names)
    {
        List<string> sorted = (names ?? Array.Empty<string>()).ToList();
        sorted.Sort(StringComparer.Ordinal);
        return new CSharpTestOracle { AppId = appId, TestCount = sorted.Count, Tests = sorted };
    }

    /// <summary>
    /// Writes this oracle to <paramref name="directory"/> under
    /// <see cref="FileNameFor"/>.
    /// </summary>
    /// <param name="directory">The oracle directory.</param>
    /// <returns>The written path.</returns>
    public string Write(string directory)
    {
        Directory.CreateDirectory(directory);
        string path = Path.Combine(directory, FileNameFor(this.AppId));
        File.WriteAllText(
            path,
            JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        return path;
    }

    /// <summary>
    /// Loads the oracle for <paramref name="appId"/> from
    /// <paramref name="directory"/>, or returns <see langword="null"/> when no
    /// file exists there. The CALLER decides what absence means; in the
    /// self-migration gate it is a failure, never a fallback.
    /// </summary>
    /// <param name="directory">The oracle directory.</param>
    /// <param name="appId">The corpus app id.</param>
    /// <returns>The oracle, or <see langword="null"/> when absent.</returns>
    /// <exception cref="InvalidOperationException">
    /// The file exists but is malformed, names another app, or lists no tests.
    /// </exception>
    public static CSharpTestOracle LoadOrNull(string directory, string appId)
    {
        string path = Path.Combine(directory, FileNameFor(appId));
        if (!File.Exists(path))
        {
            return null;
        }

        CSharpTestOracle oracle;
        try
        {
            oracle = JsonSerializer.Deserialize<CSharpTestOracle>(File.ReadAllText(path));
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException(path + ": not a valid C# test oracle: " + ex.Message, ex);
        }

        if (oracle is null || oracle.Tests is null || oracle.Tests.Count == 0)
        {
            throw new InvalidOperationException(path + ": the C# test oracle lists no tests.");
        }

        if (!string.Equals(oracle.AppId, appId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                path + ": the C# test oracle describes '" + oracle.AppId + "', not '" + appId + "'.");
        }

        return oracle;
    }

    private static string Tail(string output)
    {
        string text = (output ?? string.Empty).Trim();
        return text.Length <= 2000 ? text : text.Substring(text.Length - 2000);
    }
}
