// <copyright file="Issue3640LambdaDiscardTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Text.RegularExpressions;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3640: a true-discard assignment used as an EXPRESSION — canonically an
/// expression-lambda body (`t => _ = t.Exception`, which binds to the
/// value-returning <c>Func</c> overload) — must not emit a reference to a
/// nonexistent <c>_</c> variable (GS0125). Its value is the RHS value and the
/// write is a no-op, so the RHS alone is the faithful translation. Statement-level
/// discards keep their existing <c>let _ = …</c> lowering (issue #3462).
/// </summary>
public sealed class Issue3640LambdaDiscardTranslationTests
{
    [Fact]
    public void ContinueWithExpressionLambdaDiscard_EmitsNoBareUnderscoreReference()
    {
        string rendered = Render("""
            using System.Threading.Tasks;

            public static class Probe
            {
                public static void Observe(Task task)
                {
                    _ = task.ContinueWith(t => _ = t.Exception, TaskScheduler.Default);
                }
            }
            """);

        // The outer statement-level discard keeps its native lowering; the
        // in-lambda discard reduces to the RHS read.
        Assert.Contains("let _ = task.ContinueWith(", rendered, StringComparison.Ordinal);
        Assert.Contains("t.Exception", rendered, StringComparison.Ordinal);
        AssertNoBareUnderscoreReference(rendered);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void VoidDelegateExpressionLambdaDiscard_EmitsNoBareUnderscoreReference()
    {
        string rendered = Render("""
            using System;

            public static class Probe
            {
                public static void Run()
                {
                    Action<int> a = x => _ = x.ToString();
                    a(1);
                }
            }
            """);

        Assert.Contains("x.ToString()", rendered, StringComparison.Ordinal);
        AssertNoBareUnderscoreReference(rendered);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void ValueReturningLambdaDiscard_YieldsRhsValueAndRunsSideEffects()
    {
        string rendered = Render("""
            using System;

            public sealed class Probe
            {
                private int state;

                private int Touch(int value)
                {
                    state = (state * 10) + value;
                    return state;
                }

                public int Run()
                {
                    Func<int, int> f = x => _ = Touch(x);
                    int first = f(4);
                    int second = f(5);
                    return (state * 100) + first + second;
                }
            }
            """);

        AssertNoBareUnderscoreReference(rendered);
        TranslationTestValidation.AssertBinds(rendered);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe().Run()");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Null(result.UnhandledException);
        Assert.Equal(4549, result.Value);
    }

    [Fact]
    public void NestedDiscardAssignment_UnwindsToInnermostRhs()
    {
        string rendered = Render("""
            using System;

            public sealed class Probe
            {
                private int state;

                private int Touch(int value)
                {
                    state = (state * 10) + value;
                    return state;
                }

                public int Run()
                {
                    Func<int, int> f = x => _ = (_ = Touch(x));
                    return f(7);
                }
            }
            """);

        AssertNoBareUnderscoreReference(rendered);
        TranslationTestValidation.AssertBinds(rendered);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe().Run()");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Null(result.UnhandledException);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void ShortCircuitOperandDiscard_KeepsConditionalEvaluationAndValue()
    {
        string rendered = Render("""
            public sealed class Probe
            {
                private int state;

                private int Touch(int value)
                {
                    state = (state * 10) + value;
                    return state;
                }

                public int Run()
                {
                    bool taken = true && (_ = Touch(3)) > 0;
                    bool skipped = false && (_ = Touch(9)) > 0;
                    return (state * 100) + (taken ? 10 : 0) + (skipped ? 1 : 0);
                }
            }
            """);

        AssertNoBareUnderscoreReference(rendered);
        TranslationTestValidation.AssertBinds(rendered);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            rendered + Environment.NewLine + "Probe().Run()");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Null(result.UnhandledException);
        Assert.Equal(310, result.Value);
    }

    // A bare `_` identifier is legal in G# only as a `let _ = …` discard
    // declaration's target (and as a discard parameter). Any other standalone
    // `_` token in the rendered output is a reference to a variable that does
    // not exist (GS0125).
    private static void AssertNoBareUnderscoreReference(string rendered)
    {
        string withoutDiscardDeclarations = rendered.Replace("let _ =", "let __DISCARD__ =");
        Match bareUnderscore = Regex.Match(withoutDiscardDeclarations, @"(?<![\w$])_(?![\w])");
        Assert.False(
            bareUnderscore.Success,
            "Rendered G# contains a bare '_' identifier reference:" + Environment.NewLine + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
