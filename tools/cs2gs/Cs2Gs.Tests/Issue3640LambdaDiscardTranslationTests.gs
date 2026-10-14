// <copyright file="Issue3640LambdaDiscardTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Linq
import System.Text.RegularExpressions
import Xunit

/// Issue #3640: a true-discard assignment used as an EXPRESSION — canonically an
/// expression-lambda body (`t => _ = t.Exception`, which binds to the
/// value-returning `Func` overload) — must not emit a reference to a
/// nonexistent `_` variable (GS0125). Its value is the RHS value and the
/// write is a no-op, so the RHS alone is the faithful translation. Statement-level
/// discards keep their existing `let _ = …` lowering (issue #3462).
class Issue3640LambdaDiscardTranslationTests {
    @Fact
    func ContinueWithExpressionLambdaDiscard_EmitsNoBareUnderscoreReference() {
        let rendered = Render(`using System.Threading.Tasks;

public static class Probe
{
    public static void Observe(Task task)
    {
        _ = task.ContinueWith(t => _ = t.Exception, TaskScheduler.Default);
    }
}`)
        // The outer statement-level discard keeps its native lowering; the
        // in-lambda discard reduces to the RHS read.
        Assert.Contains("let _ = task.ContinueWith(", rendered, StringComparison.Ordinal)
        Assert.Contains("t.Exception", rendered, StringComparison.Ordinal)
        AssertNoBareUnderscoreReference(rendered)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func VoidDelegateExpressionLambdaDiscard_EmitsNoBareUnderscoreReference() {
        let rendered = Render(`using System;

public static class Probe
{
    public static void Run()
    {
        Action<int> a = x => _ = x.ToString();
        a(1);
    }
}`)
        Assert.Contains("x.ToString()", rendered, StringComparison.Ordinal)
        AssertNoBareUnderscoreReference(rendered)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func ValueReturningLambdaDiscard_YieldsRhsValueAndRunsSideEffects() {
        let rendered = Render(`using System;

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
}`)
        AssertNoBareUnderscoreReference(rendered)
        TranslationTestValidation.AssertBinds(rendered)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Probe().Run()")
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Null(result.UnhandledException)
        Assert.Equal(4549, result.Value)
    }

    @Fact
    func NestedDiscardAssignment_UnwindsToInnermostRhs() {
        let rendered = Render(`using System;

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
}`)
        AssertNoBareUnderscoreReference(rendered)
        TranslationTestValidation.AssertBinds(rendered)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Probe().Run()")
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Null(result.UnhandledException)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func ShortCircuitOperandDiscard_KeepsConditionalEvaluationAndValue() {
        let rendered = Render(`public sealed class Probe
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
}`)
        AssertNoBareUnderscoreReference(rendered)
        TranslationTestValidation.AssertBinds(rendered)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "Probe().Run()")
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Null(result.UnhandledException)
        Assert.Equal(310, result.Value)
    }

    shared {
        // A bare `_` identifier is legal in G# only as a `let _ = …` discard
        // declaration's target (and as a discard parameter). Any other standalone
        // `_` token in the rendered output is a reference to a variable that does
        // not exist (GS0125).
        private func AssertNoBareUnderscoreReference(rendered string) {
            let withoutDiscardDeclarations = rendered.Replace("let _ =", "let __DISCARD__ =")
            let bareUnderscore = Regex.Match(withoutDiscardDeclarations, "(?<![\\w$$])_(?![\\w])")
            Assert.False(
                bareUnderscore.Success,
                "Rendered G# contains a bare '_' identifier reference:" + Environment.NewLine + rendered
            )
        }

        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }
    }
}
