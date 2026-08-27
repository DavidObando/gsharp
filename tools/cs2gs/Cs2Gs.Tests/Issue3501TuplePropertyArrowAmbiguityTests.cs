// <copyright file="Issue3501TuplePropertyArrowAmbiguityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3501: an expression-bodied property whose type renders with a
/// leading parenthesis (a tuple type, or a function type) cannot use the
/// ADR-0131 arrow-property spelling — <c>prop P (int64, int64) -&gt; e</c>
/// re-parses as a function-TYPE annotation (<c>(int64, int64) -&gt; E</c>)
/// and the emitted file fails the round-trip parse (the src/LanguageServer
/// SemanticLookup wall in the repo self-migration). Those properties render
/// with an arrow get accessor inside a block instead, where the type ends
/// unambiguously at the <c>{</c>.
/// </summary>
public class Issue3501TuplePropertyArrowAmbiguityTests
{
    [Fact]
    public void TupleTypedExpressionBodiedProperty_RendersAsArrowGetAccessor()
    {
        string g = Render(@"
namespace N
{
    public class C
    {
        private long hits;
        private long misses;

        public (long, long) Stats => (this.hits, this.misses);
    }
}");

        Assert.Contains("prop Stats (int64, int64) {", g, StringComparison.Ordinal);
        Assert.Contains("get -> (this.hits, this.misses)", g, StringComparison.Ordinal);
        Assert.DoesNotContain("prop Stats (int64, int64) ->", g, StringComparison.Ordinal);
    }

    [Fact]
    public void TupleTypedExpressionBodiedProperty_TranslatedGSharp_ParsesBindsAndCompiles()
    {
        string g = Render(@"
namespace N
{
    public class C
    {
        private long hits;
        private long misses;

        public (long, long) Stats => (this.hits, this.misses);
    }
}");

        var result = EmittedOracle.Evaluate(
            new[] { g },
            new EmittedOracleOptions { IsLibrary = true });
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Equal(0, result.ExitCode);
    }

    [Fact]
    public void TupleTypedExpressionBodiedIndexer_RendersAsArrowGetAccessor()
    {
        string g = Render(@"
namespace N
{
    public class C
    {
        public (int, int) this[int i] => (i, i + 1);
    }
}");

        Assert.Contains("prop this[i int32] (int32, int32) {", g, StringComparison.Ordinal);
        Assert.Contains("get -> (i, i + 1)", g, StringComparison.Ordinal);
    }

    [Fact]
    public void TupleArrayReturningExpressionBodiedMethod_RendersAsBlockBody()
    {
        // The nested slice-element type position absorbs a following arrow as a
        // function type (`(string, string) -> Expr`), unlike the TOP-LEVEL
        // tuple return, which gsc's parser explicitly disambiguates and which
        // keeps the flat arrow spelling (see Issue1278's tuple-returning test).
        string g = Render(@"
namespace N
{
    public class C
    {
        public (string, string)[] Rows(bool first) =>
            first ? new[] { (""a"", ""b"") } : new[] { (""c"", ""d"") };
    }
}");

        Assert.Contains("func Rows(first bool) [](string, string) {", g, StringComparison.Ordinal);
        Assert.DoesNotContain("[](string, string) ->", g, StringComparison.Ordinal);

        var result = EmittedOracle.Evaluate(
            new[] { g },
            new EmittedOracleOptions { IsLibrary = true });
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Equal(0, result.ExitCode);
    }

    [Fact]
    public void TupleArrayExpressionBodiedProperty_RendersAsArrowGetAccessor()
    {
        string g = Render(@"
namespace N
{
    public class C
    {
        public (string, string)[] Rows => new[] { (""a"", ""b"") };
    }
}");

        Assert.Contains("prop Rows [](string, string) {", g, StringComparison.Ordinal);
        Assert.DoesNotContain("[](string, string) ->", g, StringComparison.Ordinal);
    }

    [Fact]
    public void TupleReturningExpressionBodiedMethod_KeepsArrowForm()
    {
        // The top-level tuple return stays on the flat arrow spelling — gsc's
        // parser disambiguates exactly this shape.
        string g = Render(@"
namespace N
{
    public class C
    {
        private static (int, int) Pair() => (1, 2);
    }
}");

        Assert.Contains("private func Pair() (int32, int32) -> (1, 2)", g, StringComparison.Ordinal);
    }

    [Fact]
    public void NonTupleExpressionBodiedProperty_KeepsArrowForm()
    {
        string g = Render(@"
namespace N
{
    public class C
    {
        public string Tag => ""x"";
    }
}");

        Assert.Contains("prop Tag string -> \"x\"", g, StringComparison.Ordinal);
    }

    private static string Render(string csharp)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", csharp) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
