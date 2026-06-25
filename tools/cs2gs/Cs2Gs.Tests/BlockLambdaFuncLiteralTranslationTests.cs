// <copyright file="BlockLambdaFuncLiteralTranslationTests.cs" company="GSharp">
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
/// Translator-fidelity tests (refs #914): a block-bodied C# lambda
/// must render as the G# function-literal form <c>func (params) RetType { … }</c>
/// (a STATEMENT block), not the arrow form <c>(params) -&gt; { … }</c> (whose body
/// is an EXPRESSION-block). The arrow body misbinds control-flow statements — a
/// non-trailing <c>if</c> without <c>else</c> is rejected by gsc as a value-position
/// if (<c>GS0276</c>). A value-returning literal also needs an EXPLICIT return type,
/// otherwise the literal is inferred void and <c>return expr</c> fails (<c>GS0122</c>);
/// a void (Action) lambda omits the return type. Expression-bodied lambdas stay arrow.
/// </summary>
public class BlockLambdaFuncLiteralTranslationTests
{
    [Fact]
    public void VoidBlockLambda_WithIfWithoutElse_RendersFuncLiteralWithoutReturnType()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System;

    public class C
    {
        public void F()
        {
            Action<int> g = d =>
            {
                if (d > 0)
                {
                    H(d);
                }

                H(d);
            };
            g(1);
        }

        private void H(int x)
        {
        }
    }
}");

        Assert.Contains("func (d int32) {", printed);
        Assert.DoesNotContain("(d int32) -> {", printed);
    }

    [Fact]
    public void ValueReturningBlockLambda_RendersFuncLiteralWithReturnType()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System;

    public class C
    {
        public int F()
        {
            Func<int, int> f = x =>
            {
                if (x > 0)
                {
                    return x + 1;
                }

                return 0;
            };
            return f(1);
        }
    }
}");

        Assert.Contains("func (x int32) int32 {", printed);
        Assert.DoesNotContain("(x int32) -> {", printed);
    }

    [Fact]
    public void ExpressionBodiedLambda_StaysArrow()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System;

    public class C
    {
        public int F()
        {
            Func<int, int> f = x => x + 1;
            return f(1);
        }
    }
}");

        Assert.Contains("(x int32) -> x + 1", printed);
        Assert.DoesNotContain("func (x int32)", printed);
    }

    private static string TranslateUnit(string source)
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
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
