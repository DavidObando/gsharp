// <copyright file="Issue1898AnonMethodTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1898: a C# anonymous method (<c>delegate (params) { … }</c>,
/// <c>AnonymousMethodExpressionSyntax</c>) had no canonical G# form and
/// reported the CS2GS-GAP "expression 'AnonymousMethodExpression' has no
/// canonical G# form yet" for every shape. An anonymous method is
/// semantically a block-bodied lambda (C# spec §12.19), so it is routed
/// through the same <c>TranslateLambda</c> lowering already used for
/// <c>ParenthesizedLambdaExpressionSyntax</c>/<c>SimpleLambdaExpressionSyntax</c>
/// — closures, spills, and mutability scoping all just work. The one
/// anonymous-method-specific wrinkle is the parameterless
/// <c>delegate { … }</c> form (distinct from <c>delegate () { … }</c>): C#
/// infers its parameter list from the target delegate type, so the
/// translator synthesizes G# parameters from the converted delegate type's
/// Invoke signature.
/// </summary>
public class Issue1898AnonMethodTranslationTests
{
    [Fact]
    public void SingleParameter_LowersToBlockBodiedFunctionLiteral()
    {
        string rendered = Render(@"
using System;

namespace Corpus.Issue1898
{
    public class Holder
    {
        public int Describe()
        {
            Func<int, int> inc = delegate (int x)
            {
                return x + 1;
            };
            return inc(41);
        }
    }
}
");

        Assert.Contains("(x int32) -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("return x + 1", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ParameterlessDelegateBlock_TargetingAction_InfersZeroParams()
    {
        string rendered = Render(@"
using System;

namespace Corpus.Issue1898
{
    public class Holder
    {
        public void Describe()
        {
            Action greet = delegate
            {
                Console.WriteLine(""hi"");
            };
            greet();
        }
    }
}
");

        Assert.Contains("() -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("Console.WriteLine(\"hi\")", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ParameterlessDelegateBlock_TargetingFuncWithParams_SynthesizesParamsFromDelegateSignature()
    {
        string rendered = Render(@"
using System;

namespace Corpus.Issue1898
{
    public class Holder
    {
        public int Describe()
        {
            // The block ignores both incoming args entirely; the parameter
            // list still must be inferred from Func<int, int, int>.
            Func<int, int, int> ignoreArgs = delegate
            {
                return 7;
            };
            return ignoreArgs(1, 2);
        }
    }
}
");

        Assert.Contains("return 7", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void ParameterlessDelegateBlock_SynthesizedParamNeverShadowsCapturedOuterLocal()
    {
        // Bug: synthesizing the Action<string>.Invoke param with its DECLARED
        // name ("obj") would shadow the outer captured `obj` local — the body
        // can never reference the delegate's own param (it has no source name
        // in this form), so a fresh non-source name is required.
        string rendered = Render(@"
using System;

namespace Corpus.Issue1898
{
    public class Holder
    {
        public void Describe()
        {
            int obj = 42;
            Action<string> a = delegate
            {
                Console.WriteLine(obj);
            };
            a(""ignored"");
        }
    }
}
");

        Assert.DoesNotContain("(obj string)", rendered, StringComparison.Ordinal);
        Assert.Contains("Console.WriteLine(obj)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void TwoParameters_LowersToBlockBodiedFunctionLiteral()
    {
        string rendered = Render(@"
using System;

namespace Corpus.Issue1898
{
    public class Holder
    {
        public int Describe()
        {
            Func<int, int, int> add = delegate (int a, int b)
            {
                return a + b;
            };
            return add(3, 4);
        }
    }
}
");

        Assert.Contains("(a int32, b int32) -> {", rendered, StringComparison.Ordinal);
        Assert.Contains("return a + b", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void CapturesOuterLocal_ClosureWorksViaSharedLambdaPath()
    {
        string rendered = Render(@"
using System;

namespace Corpus.Issue1898
{
    public class Holder
    {
        public int Describe()
        {
            int offset = 10;
            Func<int, int> addOffset = delegate (int x)
            {
                return x + offset;
            };
            return addOffset(5);
        }
    }
}
");

        Assert.Contains("x + offset", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
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
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
    }
}
