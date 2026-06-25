// <copyright file="BlockLambdaArrowTranslationTests.cs" company="GSharp">
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
/// Translator-fidelity tests (ADR-0128 / issue #1172, follow-up to #1160): now that
/// a block-bodied arrow lambda is a STATEMENT block with an optional trailing value
/// expression (full parity with func literals), a block-bodied C# lambda renders as
/// the idiomatic G# arrow form <c>(params) -&gt; { … }</c> rather than the
/// function-literal form <c>func (params) RetType { … }</c> that #1160 emitted as a
/// workaround. The arrow lambda infers its return type, so no explicit return type
/// is emitted. C# local functions (not arrow lambdas) keep the func-literal form.
/// </summary>
public class BlockLambdaArrowTranslationTests
{
    [Fact]
    public void VoidBlockLambda_WithIfWithoutElse_RendersArrowBlock()
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

        Assert.Contains("(d int32) -> {", printed);
        Assert.DoesNotContain("func (d int32)", printed);
    }

    [Fact]
    public void ValueReturningBlockLambda_RendersArrowBlock_NoReturnType()
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

        Assert.Contains("(x int32) -> {", printed);
        Assert.DoesNotContain("func (x int32)", printed);
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

    [Fact]
    public void AsyncBlockLambda_RendersAsyncArrowBlock()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System;
    using System.Threading.Tasks;

    public class C
    {
        public void F()
        {
            Func<int, Task<int>> f = async x =>
            {
                if (x > 0)
                {
                    return x + 1;
                }

                return 0;
            };
        }
    }
}");

        Assert.Contains("async (x int32) -> {", printed);
        Assert.DoesNotContain("func (x int32)", printed);
    }

    [Fact]
    public void LocalFunction_StaysFuncLiteral()
    {
        // A C# local function is NOT an arrow lambda: it keeps the
        // function-literal form with an explicit return type (supports recursion).
        string printed = TranslateUnit(@"
namespace Demo
{
    using System;

    public class C
    {
        public int F()
        {
            int Fact(int n)
            {
                if (n <= 1)
                {
                    return 1;
                }

                return n * Fact(n - 1);
            }

            return Fact(5);
        }
    }
}");

        Assert.Contains("let Fact = func (n int32) int32 {", printed);
        Assert.DoesNotContain("(n int32) -> {", printed);
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
