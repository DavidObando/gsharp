// <copyright file="Issue3684MigratedCoreTestsTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for the cs2gs root-cause families issue #3684 tracked in
/// migrated <c>test/Core.Tests</c>.
/// </summary>
public class Issue3684MigratedCoreTestsTranslationTests
{
    /// <summary>
    /// Family F12: an exception filter that introduces a PATTERN DESIGNATION.
    /// ADR-0177's filter-binding follow-up scopes the designation into the
    /// handler, so the C# clause translates directly to one native G# filter:
    /// no spill, in-handler test, or <c>rethrow</c> fallback.
    /// </summary>
    [Fact]
    public void CatchFilterWithPatternDesignation_UsesANativeFilter()
    {
        string printed = TranslateUnit(@"
using System;

namespace Demo
{
    public static class Runner
    {
        public static string Run(Action body)
        {
            try
            {
                body();
            }
            catch (InvalidOperationException ex) when (ex.InnerException is ArgumentException arg)
            {
                return arg.ParamName;
            }

            return string.Empty;
        }
    }
}
");

        Assert.Contains(
            "} catch (ex InvalidOperationException) when ex.InnerException is ArgumentException arg {",
            printed,
            StringComparison.Ordinal);
        Assert.Contains("return arg.ParamName", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("rethrow", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Family F15: C# 7.1 infers tuple element names from the element
    /// expressions (<c>(statement, index)</c>), and ADR-0172 deliberately does
    /// NOT adopt that inference — so the translated literal prints unlabeled,
    /// its type is the unnamed shape, and a later <c>pair.index</c> read failed
    /// GS0158. Such a read normalizes to the positional element instead. An
    /// element whose name is DECLARED in a tuple type still keeps it.
    /// </summary>
    [Fact]
    public void InferredTupleElementRead_NormalizesToThePositionalElement()
    {
        string printed = TranslateUnit(@"
using System.Collections.Generic;
using System.Linq;

namespace Demo
{
    public static class Indexer
    {
        public static int FirstEmpty(IReadOnlyList<string> values)
        {
            return values
                .Select((value, index) => (value, index))
                .First(pair => pair.value.Length == 0)
                .index;
        }

        public static int DeclaredNamesSurvive((int Line, int Column) at)
        {
            return at.Line;
        }
    }
}
");

        Assert.Contains(".Item2", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(".index", printed, StringComparison.Ordinal);
        Assert.Contains("at.Line", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// Family F16: a <c>[CollectionBuilder]</c> target that is a STRUCT
    /// (<c>ImmutableArray&lt;T&gt;</c>) never took the collection-initializer
    /// path — which only fires for a constructible class — and the slice
    /// literal it fell through to has no conversion to it (GS0155). C# lowers
    /// such a collection expression to the declared builder factory, so cs2gs
    /// emits that call.
    /// </summary>
    [Fact]
    public void CollectionExpressionAtCollectionBuilderStructTarget_CallsTheBuilderFactory()
    {
        string printed = TranslateUnit(
            @"
using System.Collections.Immutable;

namespace Demo
{
    public static class Names
    {
        public static readonly ImmutableArray<string> All = [""a"", ""b""];
    }
}
",
            roundTripOnlyReason: "gsc binds the printed factory call only against a reference set carrying System.Collections.Immutable.");

        Assert.Contains(
            @"ImmutableArray.Create[string]([]string{""a"", ""b""})",
            printed,
            StringComparison.Ordinal);
    }

    private static string TranslateUnit(string source, string roundTripOnlyReason = null)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = roundTripOnlyReason is null
            ? TranslationTestValidation.AssertBinds(printed)
            : TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
