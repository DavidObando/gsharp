// <copyright file="Issue1273ExpressionBodiedAccessorTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1273 / #1278 (ADR-0131): G# now has a first-class expression-bodied
/// member form using the lambda arrow <c>-&gt;</c> (never the C# fat arrow
/// <c>=&gt;</c>). cs2gs therefore translates a C# expression-bodied member
/// (<c>public int Expr =&gt; 7;</c> or an explicit <c>get =&gt; e</c> /
/// <c>set =&gt; e</c>) into the idiomatic G# arrow form
/// (<c>prop Expr int32 -&gt; 7</c>, <c>get -&gt; e</c>, <c>set -&gt; e</c>),
/// never emitting a fat arrow <c>=&gt;</c> in the output.
/// </summary>
public class Issue1273ExpressionBodiedAccessorTranslationTests
{
    private const string Source = @"
namespace Corpus.Issue1273
{
    public class Widget
    {
        private int n;

        public int Expr => 7;

        public int Pair
        {
            get => this.n;
            set => this.n = value;
        }
    }
}
";

    [Fact]
    public void ExpressionBodiedProperty_RendersAsPropertyLevelArrow()
    {
        string rendered = Render();

        // The expression-bodied read-only property becomes `prop Expr int32 -> 7`.
        Assert.Contains("prop Expr int32 -> 7", rendered, StringComparison.Ordinal);

        // It should NOT fall back to a get-block body for this simple case.
        Assert.DoesNotContain("get { return 7", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void TranslatedOutput_ContainsNoFatArrow()
    {
        string rendered = Render();

        // G# never uses the C# fat arrow; the arrow form is `->`.
        Assert.DoesNotContain("=>", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void ExpressionBodiedGetter_RendersAsArrowAccessor()
    {
        string rendered = Render();

        // `get => this.n` becomes `get -> this.n`, not a block body.
        Assert.Contains("get -> this.n", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void ExpressionBodiedSetter_RendersAsArrowAccessor()
    {
        string rendered = Render();

        // `set => this.n = value` becomes `set -> this.n = value`, not `set { }`.
        Assert.Contains("set -> this.n = value", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("set { this.n", rendered, StringComparison.Ordinal);
    }

    private static string Render()
    {
        (CompilationUnit unit, _) = Translate();
        return GSharpPrinter.Print(unit);
    }

    private static (CompilationUnit Unit, TranslationContext Context) Translate()
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Widget.cs", Source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (unit, context);
    }
}
