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
/// Issue #1273: G# has no fat-arrow <c>=&gt;</c> expression-bodied accessor (that
/// is C# syntax) and no lambda-arrow <c>-&gt;</c> accessor either — a G# property
/// accessor body is a block <c>{ }</c> or <c>;</c> only. cs2gs must therefore
/// translate a C# expression-bodied accessor (<c>public int P =&gt; 7;</c> or an
/// explicit <c>get =&gt; e</c> / <c>set =&gt; e</c>) into a G# <b>block body</b>
/// (<c>get { return e }</c>), never emitting <c>=&gt;</c> in the G# output.
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
    public void ExpressionBodiedAccessors_RenderAsBlockBodies()
    {
        string rendered = Render();

        // The expression-bodied getters become block bodies with a return.
        Assert.Contains("get {", rendered, StringComparison.Ordinal);
        Assert.Contains("return", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void TranslatedOutput_ContainsNoFatArrow()
    {
        string rendered = Render();

        // G# accessors never use the C# fat arrow.
        Assert.DoesNotContain("=>", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void ExpressionBodiedSetter_RendersAsBlockBody()
    {
        string rendered = Render();

        // The expression-bodied setter becomes a block body, not `set => e`.
        Assert.Contains("set {", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("set =>", rendered, StringComparison.Ordinal);
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
