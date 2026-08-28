// <copyright file="DiagnosticIdUniquenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using GSharp.Core.CodeAnalysis;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;
using CoreDiagnosticDescriptor = GSharp.Core.CodeAnalysis.DiagnosticDescriptor;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Guards the stable public contract formed by diagnostic IDs, descriptors,
/// report methods, and the diagnostic reference documentation.
/// </summary>
public class DiagnosticIdUniquenessTests
{
    [Fact]
    public void Every_DiagnosticId_Maps_To_Exactly_One_Message_Shape()
    {
        var repoRoot = FindRepoRoot();
        var idToShapes = new Dictionary<string, Dictionary<string, string>>();

        foreach (var field in GetDescriptorFields())
        {
            var descriptor = (CoreDiagnosticDescriptor)field.GetValue(null);
            RecordShape(
                descriptor.Id,
                $"DiagnosticDescriptors.{field.Name}",
                Path.Combine("src", "Core", "CodeAnalysis", "DiagnosticDescriptors.cs"),
                idToShapes);
        }

        foreach (var file in Directory.EnumerateFiles(
                     Path.Combine(repoRoot, "src"),
                     "*.cs",
                     SearchOption.AllDirectories))
        {
            var text = File.ReadAllText(file);
            var root = CSharpSyntaxTree.ParseText(text, path: file).GetCompilationUnitRoot();
            foreach (var creation in root.DescendantNodes().OfType<ObjectCreationExpressionSyntax>())
            {
                if (GetSimpleName(creation.Type) == "Diagnostic" && creation.ArgumentList != null)
                {
                    RecordLiteralCallSite(
                        creation.ArgumentList,
                        creation,
                        file,
                        repoRoot,
                        text,
                        idToShapes);
                }
            }
        }

        Assert.NotEmpty(idToShapes);
        var collisions = idToShapes
            .Where(kv => kv.Value.Count > 1)
            .OrderBy(kv => kv.Key, StringComparer.Ordinal)
            .Select(kv => $"{kv.Key} is used from {kv.Value.Count} distinct shapes:\n" +
                          string.Join("\n", kv.Value.Select(t => $"    {t.Value}: {t.Key}")))
            .ToArray();

        Assert.True(
            collisions.Length == 0,
            "Duplicate diagnostic IDs found (each GS#### must map to exactly one message shape):\n\n" +
            string.Join("\n\n", collisions));
    }

    [Fact]
    public void Every_Report_Uses_A_Descriptor_And_Every_Descriptor_Is_Used()
    {
        var repoRoot = FindRepoRoot();
        var reportDirectory = Path.Combine(repoRoot, "src", "Core", "CodeAnalysis");
        var descriptorNames = GetDescriptorFields()
            .Select(field => field.Name)
            .ToHashSet(StringComparer.Ordinal);
        var referencedDescriptors = new HashSet<string>(StringComparer.Ordinal);

        foreach (var file in Directory.EnumerateFiles(
                     reportDirectory,
                     "DiagnosticBag.Reports.*.cs",
                     SearchOption.TopDirectoryOnly))
        {
            var root = CSharpSyntaxTree.ParseText(File.ReadAllText(file), path: file)
                .GetCompilationUnitRoot();

            foreach (var invocation in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                var name = GetSimpleName(invocation.Expression);
                if (name is not ("Report" or "ReportWithErrorPromotion"))
                {
                    continue;
                }

                var arguments = invocation.ArgumentList.Arguments;
                Assert.True(arguments.Count >= 2, $"{file}: malformed {name} invocation");
                var descriptorAccess = Assert.IsType<MemberAccessExpressionSyntax>(arguments[1].Expression);
                Assert.Equal("DiagnosticDescriptors", descriptorAccess.Expression.ToString());
                var descriptorName = descriptorAccess.Name.Identifier.ValueText;
                var reportMethod = invocation.Ancestors().OfType<MethodDeclarationSyntax>().First();
                Assert.Equal(reportMethod.Identifier.ValueText["Report".Length..], descriptorName);
                referencedDescriptors.Add(descriptorName);
            }

            foreach (var method in root.DescendantNodes().OfType<MethodDeclarationSyntax>()
                         .Where(method => method.Identifier.ValueText.StartsWith("Report", StringComparison.Ordinal)))
            {
                var routesToDiagnostic = method.DescendantNodes()
                    .OfType<InvocationExpressionSyntax>()
                    .Any(invocation => GetSimpleName(invocation.Expression)
                        .StartsWith("Report", StringComparison.Ordinal));
                Assert.True(routesToDiagnostic, $"{method.Identifier.ValueText} does not route to a diagnostic descriptor.");
            }
        }

        foreach (var file in Directory.EnumerateFiles(
                     Path.Combine(repoRoot, "src"),
                     "*.cs",
                     SearchOption.AllDirectories))
        {
            var root = CSharpSyntaxTree.ParseText(File.ReadAllText(file), path: file)
                .GetCompilationUnitRoot();
            foreach (var access in root.DescendantNodes().OfType<MemberAccessExpressionSyntax>()
                         .Where(access => access.Expression.ToString() == "DiagnosticDescriptors"))
            {
                if (descriptorNames.Contains(access.Name.Identifier.ValueText))
                {
                    referencedDescriptors.Add(access.Name.Identifier.ValueText);
                }
            }
        }

        Assert.Equal(
            descriptorNames.OrderBy(name => name, StringComparer.Ordinal),
            referencedDescriptors.OrderBy(name => name, StringComparer.Ordinal));
    }

    [Fact]
    public void Every_Descriptor_MessageFormat_Is_Valid()
    {
        var arguments = Enumerable.Repeat<object>("value", 32).ToArray();
        foreach (var field in GetDescriptorFields())
        {
            var descriptor = (CoreDiagnosticDescriptor)field.GetValue(null);
            var exception = Record.Exception(() =>
            {
                _ = string.Format(descriptor.MessageFormat, arguments);
            });
            Assert.True(exception == null, $"{field.Name} has an invalid message format: {exception}");
        }
    }

    [Fact]
    public void Every_Diagnostic_Is_Documented_In_Both_References_With_Matching_Severity()
    {
        var expectedSeverities = GetDescriptorFields()
            .Select(field => (CoreDiagnosticDescriptor)field.GetValue(null))
            .ToDictionary(
                descriptor => descriptor.Id,
                descriptor => descriptor.Severity.ToString(),
                StringComparer.Ordinal);

        // These diagnostics intentionally live outside DiagnosticDescriptors.
        // Add an entry only for a directly emitted, retired, or reserved ID.
        var documentedNonDescriptorSeverities = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            // Emitted directly by AsyncEmitPrecheck.
            ["GS0190"] = "Error",

            // Retired after generic explicit constructors became supported.
            ["GS0217"] = "Retired",

            // Retired when non-loop labels became valid goto targets.
            ["GS0294"] = "Retired",

            // Retired by ADR-0095 v2 / issue #3611: bare `unmanaged (T) -> R`
            // is the platform-default unmanaged calling convention.
            ["GS0356"] = "Retired",

            // Reserved after auto-properties became valid in data aggregates.
            ["GS0419"] = "Reserved",

            // Emitted directly by the compiler's reference-closure check.
            ["GS9100"] = "Warning",

            // Emitted directly for unexpected emit failures.
            ["GS9998"] = "Error",

            // Synthesized by the test emitted oracle for unexpected runtime failures.
            ["GS9999"] = "Error",
        };

        foreach (var item in documentedNonDescriptorSeverities)
        {
            expectedSeverities.Add(item.Key, item.Value);
        }

        var repoRoot = FindRepoRoot();
        var primaryPath = Path.Combine(repoRoot, "docs", "diagnostics.md");
        var websitePath = Path.Combine(repoRoot, "website", "docs", "ref", "diagnostics.md");
        var primaryRows = AssertDocumentationMatches(primaryPath, expectedSeverities);
        var websiteRows = AssertDocumentationMatches(websitePath, expectedSeverities);
        var differingRows = expectedSeverities.Keys
            .Where(id => primaryRows[id] != websiteRows[id])
            .OrderBy(id => id, StringComparer.Ordinal)
            .Select(id =>
                $"{id}:\n" +
                $"  docs/diagnostics.md: {primaryRows[id]}\n" +
                $"  website/docs/ref/diagnostics.md: {websiteRows[id]}")
            .ToArray();

        Assert.True(
            differingRows.Length == 0,
            "Diagnostic reference rows differ:\n" + string.Join("\n", differingRows));
    }

    private static FieldInfo[] GetDescriptorFields() =>
        typeof(DiagnosticDescriptors)
            .GetFields(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)
            .Where(field => field.FieldType == typeof(CoreDiagnosticDescriptor))
            .ToArray();

    private static IReadOnlyDictionary<string, string> AssertDocumentationMatches(
        string path,
        IReadOnlyDictionary<string, string> expectedSeverities)
    {
        var referencePath = Path.GetRelativePath(FindRepoRoot(), path);
        var documentedRows = Regex.Matches(
                File.ReadAllText(path),
                @"^\|\s*(GS\d{4})\s*\|\s*([^|]+?)\s*\|(.*?)\|\s*$",
                RegexOptions.Multiline)
            .Cast<Match>()
            .ToArray();
        var documentedSeverityGroups = documentedRows
            .GroupBy(match => match.Groups[1].Value, StringComparer.Ordinal)
            .ToArray();
        var duplicateRows = documentedSeverityGroups
            .Where(group => group.Count() != 1)
            .Select(group => $"{group.Key}: {group.Count()} rows")
            .ToArray();

        Assert.True(
            documentedRows.Length == documentedSeverityGroups.Length,
            $"{referencePath} contains duplicate diagnostic rows:\n" +
            string.Join("\n", duplicateRows));

        var conflictingSeverities = documentedSeverityGroups
            .Select(group => (
                Id: group.Key,
                Severities: group
                    .Select(NormalizeDocumentedSeverity)
                    .Distinct(StringComparer.Ordinal)
                    .ToArray()))
            .Where(item => item.Severities.Length > 1)
            .Select(item => $"{item.Id}: {string.Join(", ", item.Severities)}")
            .ToArray();

        Assert.True(
            conflictingSeverities.Length == 0,
            $"{referencePath} documents diagnostics with conflicting severities:\n" +
            string.Join("\n", conflictingSeverities));

        var documentedSeverities = documentedSeverityGroups
            .ToDictionary(
                group => group.Key,
                group => NormalizeDocumentedSeverity(group.First()),
                StringComparer.Ordinal);
        var missing = expectedSeverities.Keys
            .Except(documentedSeverities.Keys, StringComparer.Ordinal)
            .OrderBy(id => id, StringComparer.Ordinal)
            .ToArray();
        var unexpected = documentedSeverities.Keys
            .Except(expectedSeverities.Keys, StringComparer.Ordinal)
            .OrderBy(id => id, StringComparer.Ordinal)
            .ToArray();
        var mismatched = expectedSeverities.Keys
            .Intersect(documentedSeverities.Keys, StringComparer.Ordinal)
            .Where(id => expectedSeverities[id] != documentedSeverities[id])
            .OrderBy(id => id, StringComparer.Ordinal)
            .Select(id => $"{id}: expected {expectedSeverities[id]}, found {documentedSeverities[id]}")
            .ToArray();

        Assert.True(
            missing.Length == 0 && unexpected.Length == 0 && mismatched.Length == 0,
            $"{referencePath} is out of sync with compiler diagnostics:\n" +
            $"Missing from {referencePath}: {string.Join(", ", missing)}\n" +
            $"Unexpected in {referencePath}: {string.Join(", ", unexpected)}\n" +
            $"Severity mismatches in {referencePath}:\n{string.Join("\n", mismatched)}");

        return documentedSeverityGroups.ToDictionary(
            group => group.Key,
            group => NormalizeDocumentedRow(group.Single()),
            StringComparer.Ordinal);
    }

    private static string NormalizeDocumentedRow(Match match)
    {
        var remainingColumns = Regex.Split(match.Groups[3].Value.Trim(), @"\s*\|\s*")
            .Select(column => column.Trim())
            .ToList();
        while (remainingColumns.Count > 0 && remainingColumns[^1].Length == 0)
        {
            remainingColumns.RemoveAt(remainingColumns.Count - 1);
        }

        return string.Join(
            " | ",
            new[] { match.Groups[2].Value.Trim() }.Concat(remainingColumns));
    }

    private static string NormalizeDocumentedSeverity(Match match)
    {
        var severity = match.Groups[2].Value.Trim().TrimStart('*', '_');
        var severityMatch = Regex.Match(
            severity,
            @"^(Error|Warning|Info|Retired|Reserved)\b");
        return severityMatch.Success
            ? severityMatch.Groups[1].Value
            : severity.Trim('*', '_');
    }

    private static void RecordLiteralCallSite(
        ArgumentListSyntax argumentList,
        SyntaxNode callNode,
        string file,
        string repoRoot,
        string text,
        Dictionary<string, Dictionary<string, string>> idToShapes)
    {
        var idLiteral = argumentList.Arguments
            .Select(argument => argument.Expression)
            .OfType<LiteralExpressionSyntax>()
            .FirstOrDefault(literal =>
                literal.IsKind(SyntaxKind.StringLiteralExpression) &&
                IsGsId(literal.Token.ValueText));
        if (idLiteral == null)
        {
            return;
        }

        var line = text[..callNode.SpanStart].Count(character => character == '\n') + 1;
        RecordShape(
            idLiteral.Token.ValueText,
            GetEnclosingMemberName(callNode),
            $"{Path.GetRelativePath(repoRoot, file)}:{line}",
            idToShapes);
    }

    private static void RecordShape(
        string id,
        string shape,
        string site,
        Dictionary<string, Dictionary<string, string>> idToShapes)
    {
        if (!idToShapes.TryGetValue(id, out var shapes))
        {
            shapes = new Dictionary<string, string>();
            idToShapes[id] = shapes;
        }

        if (!shapes.ContainsKey(shape))
        {
            shapes[shape] = site;
        }
    }

    private static bool IsGsId(string value) =>
        value.Length == 6 &&
        value.StartsWith("GS", StringComparison.Ordinal) &&
        value[2..].All(char.IsDigit);

    private static string GetSimpleName(SyntaxNode expression) => expression switch
    {
        MemberAccessExpressionSyntax member => member.Name.Identifier.ValueText,
        IdentifierNameSyntax identifier => identifier.Identifier.ValueText,
        GenericNameSyntax generic => generic.Identifier.ValueText,
        _ => string.Empty,
    };

    private static string GetEnclosingMemberName(SyntaxNode node)
    {
        for (var current = node.Parent; current != null; current = current.Parent)
        {
            switch (current)
            {
                case MethodDeclarationSyntax method:
                    return method.Identifier.ValueText;
                case LocalFunctionStatementSyntax localFunction:
                    return localFunction.Identifier.ValueText;
                case ConstructorDeclarationSyntax constructor:
                    return constructor.Identifier.ValueText;
                case AccessorDeclarationSyntax accessor:
                    return $"{(accessor.Parent?.Parent as PropertyDeclarationSyntax)?.Identifier.ValueText}.{accessor.Keyword.ValueText}";
            }
        }

        return "<top-level>";
    }

    private static string FindRepoRoot()
    {
        var directory = Path.GetDirectoryName(typeof(DiagnosticIdUniquenessTests).Assembly.Location);
        while (!string.IsNullOrEmpty(directory))
        {
            if (File.Exists(Path.Combine(directory, ".config", "dotnet-tools.json")))
            {
                return directory;
            }

            directory = Path.GetDirectoryName(directory);
        }

        return Environment.CurrentDirectory;
    }
}
