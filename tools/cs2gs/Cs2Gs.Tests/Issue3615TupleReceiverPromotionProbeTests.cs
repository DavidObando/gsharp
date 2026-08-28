// <copyright file="Issue3615TupleReceiverPromotionProbeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression coverage for the 2026-08-28 nightly's Cs2Gs.Translator wall
/// (issue #3615): a defensive <c>reference.SyntaxTree?.FilePath</c> at ONE
/// site seeds used-as-nullable taint on the IMPORTED
/// <c>SyntaxReference.SyntaxTree</c> property, and #3604's
/// generic-receiver tuple flow (<c>staticHelpers.Contains((reference.SyntaxTree,
/// ...))</c>) then propagated that heuristic taint into a source field's
/// declared tuple element — widening
/// <c>HashSet[(SyntaxTree, int32, int32)]</c> to <c>(SyntaxTree?, ...)</c>
/// while its initializer and deconstructing readers stayed non-nullable
/// (GS0158 "Cannot find member FilePath" / GS0159). Imported members'
/// declared annotations are the contract for values flowing into a tuple
/// element; only source-declared symbols may propagate element taint.
/// </summary>
public class Issue3615TupleReceiverPromotionProbeTests
{
    [Fact]
    public void ImportedMemberDefensiveUse_DoesNotPromoteTheTupleElement()
    {
        const string source = @"
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

public sealed class Registry
{
    private readonly HashSet<(SyntaxTree Tree, int Start, int Length)> staticHelpers = new();

    public void AddStaticHelper(MethodDeclarationSyntax method)
    {
        this.staticHelpers.Add((method.SyntaxTree, method.SpanStart, method.Span.Length));
    }

    public bool IsStaticHelper(IMethodSymbol symbol)
    {
        return symbol.DeclaringSyntaxReferences.Any(
            reference => this.staticHelpers.Contains(
                (reference.SyntaxTree, reference.Span.Start, reference.Span.Length)));
    }

    // The defensive `?.` here is the taint seed: it marks the IMPORTED
    // SyntaxReference.SyntaxTree property used-as-nullable, which must NOT
    // rewrite the staticHelpers element type above.
    public static string FirstPath(ISymbol symbol)
    {
        foreach (SyntaxReference reference in symbol.DeclaringSyntaxReferences)
        {
            string path = reference.SyntaxTree?.FilePath;
            if (!string.IsNullOrEmpty(path))
            {
                return path;
            }
        }

        return null;
    }

    public Registry Filter(HashSet<string> retainedFilePaths)
    {
        var filtered = new Registry();
        foreach ((SyntaxTree tree, int start, int length) in this.staticHelpers)
        {
            if (retainedFilePaths.Contains(tree.FilePath))
            {
                filtered.staticHelpers.Add((tree, start, length));
            }
        }

        return filtered;
    }
}
";
        string printed = Render(source);
        Assert.DoesNotContain("(SyntaxTree?", printed, StringComparison.Ordinal);
        Assert.Contains("HashSet[(SyntaxTree, int32, int32)]", printed, StringComparison.Ordinal);
        AssertRoundTripParses(printed);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = TranslationTestValidation.AssertBinds(rendered);

        Assert.True(
            result.Success,
            "Translated G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity != TranslationSeverity.Info);
        return GSharpPrinter.Print(unit);
    }
}
