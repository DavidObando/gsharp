// <copyright file="DiagnosticIdUniquenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #1655: a <c>GS####</c> diagnostic ID is a stable public contract —
/// it appears in <c>/nowarn</c> and <c>/warnaserror</c> flags, IDE quick-info,
/// and documentation. Two unrelated diagnostics sharing one ID silently break
/// that contract (suppressing one silently suppresses the other). This test
/// scans every <c>Report(location, "GS####", message)</c> call site under
/// <c>src/</c> and fails if any ID is used for more than one distinct message
/// shape, so a future collision fails CI instead of shipping.
/// </summary>
public class DiagnosticIdUniquenessTests
{
    // Interpolation holes ("{name}", "{0}", nested braces) vary call to call;
    // normalize them to a single placeholder so two reports of the *same*
    // diagnostic with different interpolated values are not flagged as a
    // collision, while two genuinely different message templates still are.
    private static readonly Regex InterpolationHole = new(@"\{[^{}]*\}", RegexOptions.Compiled);

    // Matches `Report(<args>, "GSxxxx", <message>)` — the DiagnosticBag helper
    // form, where <message> is a (possibly interpolated) C# string literal.
    private static readonly Regex ReportCall = new(
        @"\bReport\([^;]*?""(GS\d{4})""\s*,\s*(\$?""(?:[^""\\]|\\.)*"")",
        RegexOptions.Compiled | RegexOptions.Singleline);

    // Matches `new Diagnostic(<args>, "GSxxxx", <severity>, <message>)` — the
    // low-level form used outside DiagnosticBag (e.g. AsyncEmitPrecheck),
    // where <message> is typically an identifier/expression rather than a
    // literal. The expression text itself is the "shape" being compared.
    private static readonly Regex NewDiagnosticCall = new(
        @"new\s+Diagnostic\([^;]*?""(GS\d{4})""\s*,\s*DiagnosticSeverity\.\w+\s*,\s*([^,;()]+?)\s*\)",
        RegexOptions.Compiled | RegexOptions.Singleline);

    [Fact]
    public void Every_DiagnosticId_Maps_To_Exactly_One_Message_Shape()
    {
        var repoRoot = FindRepoRoot();
        var srcRoot = Path.Combine(repoRoot, "src");
        Assert.True(Directory.Exists(srcRoot), $"src directory not found: {srcRoot}");

        // id -> set of (normalized message template -> example "file:line" site)
        var idToTemplates = new Dictionary<string, Dictionary<string, string>>();

        foreach (var file in Directory.EnumerateFiles(srcRoot, "*.cs", SearchOption.AllDirectories))
        {
            var text = File.ReadAllText(file);
            RecordMatches(ReportCall, text, file, repoRoot, idToTemplates);
            RecordMatches(NewDiagnosticCall, text, file, repoRoot, idToTemplates);
        }

        Assert.NotEmpty(idToTemplates);

        var collisions = idToTemplates
            .Where(kv => kv.Value.Count > 1)
            .OrderBy(kv => kv.Key, StringComparer.Ordinal)
            .Select(kv => $"{kv.Key} is used for {kv.Value.Count} distinct messages:\n" +
                          string.Join("\n", kv.Value.Select(t => $"    {t.Value}: {t.Key}")))
            .ToArray();

        Assert.True(
            collisions.Length == 0,
            "Duplicate diagnostic IDs found (each GS#### must map to exactly one message shape):\n\n" +
            string.Join("\n\n", collisions));
    }

    private static void RecordMatches(
        Regex pattern,
        string text,
        string file,
        string repoRoot,
        Dictionary<string, Dictionary<string, string>> idToTemplates)
    {
        foreach (Match match in pattern.Matches(text))
        {
            var id = match.Groups[1].Value;
            var rawMessage = match.Groups[2].Value;
            var template = InterpolationHole.Replace(rawMessage, "{}");
            var line = text[..match.Index].Count(c => c == '\n') + 1;
            var site = $"{Path.GetRelativePath(repoRoot, file)}:{line}";

            if (!idToTemplates.TryGetValue(id, out var templates))
            {
                templates = new Dictionary<string, string>();
                idToTemplates[id] = templates;
            }

            // Keep the first site seen for each distinct template so the
            // failure message can point at both call sites of a collision.
            if (!templates.ContainsKey(template))
            {
                templates[template] = site;
            }
        }
    }

    private static string FindRepoRoot()
    {
        var dir = Path.GetDirectoryName(typeof(DiagnosticIdUniquenessTests).Assembly.Location);
        while (!string.IsNullOrEmpty(dir))
        {
            if (File.Exists(Path.Combine(dir, ".config", "dotnet-tools.json")))
            {
                return dir;
            }

            dir = Path.GetDirectoryName(dir);
        }

        return Environment.CurrentDirectory;
    }
}
