// <copyright file="DiagnosticIdUniquenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #1655: a <c>GS####</c> diagnostic ID is a stable public contract —
/// it appears in <c>/nowarn</c> and <c>/warnaserror</c> flags, IDE quick-info,
/// and documentation. Two unrelated diagnostics sharing one ID silently break
/// that contract (suppressing one silently suppresses the other). This test
/// parses every file under <c>src/</c> with Roslyn and finds every
/// <c>Report(..., "GS####", ...)</c> / <c>new Diagnostic(..., "GS####", ...)</c>
/// call site, regardless of whether the message argument is a string literal,
/// an interpolated string, or a local variable/expression. The "shape" for a
/// given ID is the name of its enclosing method — this repo's convention is
/// one <c>ReportXxx</c> wrapper method per diagnostic ID — so an ID used from
/// two distinct methods (a real collision) is caught even when the message
/// argument text itself gives no clue (the variable-message form regex alone
/// would miss).
/// </summary>
public class DiagnosticIdUniquenessTests
{
    [Fact]
    public void Every_DiagnosticId_Maps_To_Exactly_One_Message_Shape()
    {
        var repoRoot = FindRepoRoot();
        var srcRoot = Path.Combine(repoRoot, "src");
        Assert.True(Directory.Exists(srcRoot), $"src directory not found: {srcRoot}");

        // id -> set of (enclosing-method shape -> example "file:line" site)
        var idToShapes = new Dictionary<string, Dictionary<string, string>>();

        foreach (var file in Directory.EnumerateFiles(srcRoot, "*.cs", SearchOption.AllDirectories))
        {
            var text = File.ReadAllText(file);
            var tree = CSharpSyntaxTree.ParseText(text, path: file);
            var root = tree.GetCompilationUnitRoot();

            foreach (var invocation in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (GetSimpleName(invocation.Expression) != "Report")
                {
                    continue;
                }

                RecordCallSite(invocation.ArgumentList, invocation, file, repoRoot, text, idToShapes);
            }

            foreach (var creation in root.DescendantNodes().OfType<ObjectCreationExpressionSyntax>())
            {
                if (GetSimpleName(creation.Type) != "Diagnostic" || creation.ArgumentList == null)
                {
                    continue;
                }

                RecordCallSite(creation.ArgumentList, creation, file, repoRoot, text, idToShapes);
            }
        }

        Assert.NotEmpty(idToShapes);

        var collisions = idToShapes
            .Where(kv => kv.Value.Count > 1)
            .OrderBy(kv => kv.Key, StringComparer.Ordinal)
            .Select(kv => $"{kv.Key} is used from {kv.Value.Count} distinct enclosing methods:\n" +
                          string.Join("\n", kv.Value.Select(t => $"    {t.Value}: {t.Key}")))
            .ToArray();

        Assert.True(
            collisions.Length == 0,
            "Duplicate diagnostic IDs found (each GS#### must map to exactly one message shape):\n\n" +
            string.Join("\n\n", collisions));
    }

    private static void RecordCallSite(
        ArgumentListSyntax argumentList,
        SyntaxNode callNode,
        string file,
        string repoRoot,
        string text,
        Dictionary<string, Dictionary<string, string>> idToShapes)
    {
        // Find the "GSxxxx" string literal argument, wherever it falls in the
        // argument list (Report and Diagnostic's ctor put it in different
        // positions).
        var idLiteral = argumentList.Arguments
            .Select(a => a.Expression)
            .OfType<LiteralExpressionSyntax>()
            .FirstOrDefault(l => l.IsKind(SyntaxKind.StringLiteralExpression) && IsGsId(l.Token.ValueText));

        if (idLiteral == null)
        {
            return;
        }

        var id = idLiteral.Token.ValueText;
        var shape = GetEnclosingMemberName(callNode);
        var line = text[..callNode.SpanStart].Count(c => c == '\n') + 1;
        var site = $"{Path.GetRelativePath(repoRoot, file)}:{line}";

        if (!idToShapes.TryGetValue(id, out var shapes))
        {
            shapes = new Dictionary<string, string>();
            idToShapes[id] = shapes;
        }

        // Keep the first site seen for each distinct shape so the failure
        // message can point at both call sites of a collision.
        if (!shapes.ContainsKey(shape))
        {
            shapes[shape] = site;
        }
    }

    private static bool IsGsId(string value) =>
        value.Length == 6 && value.StartsWith("GS", StringComparison.Ordinal) && value[2..].All(char.IsDigit);

    // Resolves the simple name of a possibly-qualified expression
    // (e.g. `this.Report`, `Diagnostics.Report` -> "Report").
    private static string GetSimpleName(SyntaxNode expression) => expression switch
    {
        MemberAccessExpressionSyntax member => member.Name.Identifier.ValueText,
        IdentifierNameSyntax identifier => identifier.Identifier.ValueText,
        GenericNameSyntax generic => generic.Identifier.ValueText,
        _ => string.Empty,
    };

    // The "shape" for a diagnostic ID: the name of its nearest enclosing
    // method/local-function/constructor/property accessor. This is what
    // actually distinguishes two unrelated diagnostics sharing an ID, since
    // this repo's convention is one ReportXxx wrapper method per ID -
    // regardless of whether the message is a literal, interpolated string,
    // or a local variable.
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
                case ConstructorDeclarationSyntax ctor:
                    return ctor.Identifier.ValueText;
                case AccessorDeclarationSyntax accessor:
                    return $"{(accessor.Parent?.Parent as PropertyDeclarationSyntax)?.Identifier.ValueText}.{accessor.Keyword.ValueText}";
            }
        }

        return "<top-level>";
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
