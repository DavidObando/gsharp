// <copyright file="Issue4718IteratorTupleElementPromotionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue4718IteratorTupleElementPromotionTests
{
    [Theory]
    [InlineData("IEnumerable", "", "sequence")]
    [InlineData("IEnumerator", "", "IEnumerator")]
    [InlineData("IAsyncEnumerable", "async ", "IAsyncEnumerable")]
    [InlineData("IAsyncEnumerator", "async ", "IAsyncEnumerator")]
    public void ConditionalTupleYield_PromotesOnlyNullBearingElement(
        string envelope,
        string modifier,
        string mappedEnvelope)
    {
        string printed = Translate($$"""
            using System.Collections.Generic;
            public static class Obj {
                public static {{modifier}}{{envelope}}<(string Text, int Code)> TupleRows(bool choose) {
                    string text = null;
                    yield return choose ? (text, 1) : ("x", 2);
                }
            }
            """);

        Assert.Contains($"func TupleRows(choose bool) {mappedEnvelope}[(Text string?, Code int32)]", printed);
        Assert.Contains("let text string? = nil", printed);
        Assert.DoesNotContain("text!!", printed);
    }

    [Fact]
    public void NestedSwitchTupleYield_UsesTheSameElementPathsAsForwardedCollection()
    {
        string printed = Translate("""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<((string Text, string Keep) Names, int Code)> NestedRows(bool choose) {
                    string text = null;
                    yield return choose switch {
                        true => ((text, "keep"), 1),
                        false => (("x", "keep"), 2)
                    };
                }

                public static IEnumerable<((string Text, string Keep) Names, int Code)> Forward(bool choose) {
                    return NestedRows(choose);
                }
            }
            """);

        Assert.Contains(
            "func NestedRows(choose bool) sequence[(Names (Text string?, Keep string), Code int32)]",
            printed);
        Assert.Contains(
            "func Forward(choose bool) IEnumerable[(Names (Text string?, Keep string), Code int32)]",
            printed);
        Assert.DoesNotContain("Keep string?", printed);
        Assert.DoesNotContain("text!!", printed);
    }

    [Fact]
    public void NestedIteratorAndYieldBreak_DoNotTaintOuterIterator()
    {
        string printed = Translate("""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
                    IEnumerable<(string Text, int Code)> Missing() {
                        string text = null;
                        yield return choose ? (text, 1) : ("x", 2);
                    }
                    if (choose) { yield break; }
                    yield return ("keep", 2);
                }
            }
            """);

        Assert.Contains("func Rows(choose bool) sequence[(Text string, Code int32)]", printed);
        Assert.Contains("let Missing = func () IEnumerable[(Text string?, Code int32)]", printed);
    }

    [Theory]
    [InlineData("(text, 1)", "string")]
    [InlineData("choose ? (text, 1) : (\"x\", 2)", "string")]
    [InlineData("choose switch { true => (text, 1), false => (\"x\", 2) }", "string")]
    [InlineData("(choose ? text : \"x\", 1)", "string")]
    [InlineData("(choose switch { true => text, false => \"x\" }, 1)", "string?")]
    public void GuardedTupleYield_DoesNotPromoteItsProvenNonNullLeaf(string yielded, string declaredType)
    {
        string printed = Translate($$"""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
                    {{declaredType}} text = choose ? null : "x";
                    if (text != null) {
                        yield return {{yielded}};
                    }
                }

                public static int Lengths(bool choose) {
                    int total = 0;
                    foreach (var row in Rows(choose)) {
                        total += row.Text.Length;
                    }
                    return total;
                }
            }
            """);

        Assert.Contains("func Rows(choose bool) sequence[(Text string, Code int32)]", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void GuardedNestedConditionalTupleYield_StillPromotesTheUnguardedSibling()
    {
        string printed = Translate("""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<((string Text, string Missing) Names, int Code)> Rows(bool choose) {
                    string text = choose ? null : "x";
                    string missing = null;
                    if (text != null) {
                        yield return choose ? ((text, missing), 1) : (("x", "keep"), 2);
                    }
                }
            }
            """);

        Assert.Contains(
            "func Rows(choose bool) sequence[(Names (Text string, Missing string?), Code int32)]",
            printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void ConditionalTupleYield_PreservesNullAndNonNullRuntimeValues()
    {
        string printed = Translate("""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> TupleRows(bool choose) {
                    string text = null;
                    yield return choose ? (text, 1) : ("x", 2);
                }

                public static int Run() {
                    int result = 0;
                    foreach (var row in TupleRows(true)) {
                        if (row.Text != null || row.Code != 1) { return -1; }
                        result += 1;
                    }
                    foreach (var row in TupleRows(false)) {
                        if (row.Text != "x" || row.Code != 2) { return -2; }
                        result += 2;
                    }
                    return result;
                }
            }
            """);

        Assert.Contains("func TupleRows(choose bool) sequence[(Text string?, Code int32)]", printed);
        EmittedOracleResult result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()");
        Assert.False(
            result.Diagnostics.Any(diagnostic => diagnostic.IsError),
            string.Join(Environment.NewLine, result.Diagnostics) + Environment.NewLine + printed);
        Assert.Null(result.UnhandledException);
        Assert.Equal(3, result.Value);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        return GSharpPrinter.Print(unit);
    }
}
