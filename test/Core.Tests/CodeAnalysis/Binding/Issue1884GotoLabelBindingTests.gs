// <copyright file="Issue1884GotoLabelBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1884 / ADR-0139: binding and evaluation tests for general
/// `goto`/`label:` statements (a label on any non-loop statement is a `goto`
/// target) and their diagnostics (GS0469, GS0470).
open class Issue1884GotoLabelBindingTests {
    @Fact
    func BackwardGoto_LoopsBody_ProducesExpectedValue() {
        let source = `package P
var a = 0
retry:
a = a + 1
if a < 3 {
    goto retry
}`
        let (eval, vars) = EvaluateWithVariables(source)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(3, vars["a"])
    }

    @Fact
    func ForwardGoto_SkipsInterveningStatement() {
        let source = `package P
var hit = false
goto after
hit = true
after:
var done = true`
        let (eval, vars) = EvaluateWithVariables(source)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(false, vars["hit"])
        Assert.Equal(true, vars["done"])
    }

    @Fact
    func Goto_EscapesNestedIfBlock_ToOuterLabel() {
        let source = `package P
var x = 2
var branch = 0
if x == 2 {
    branch = 1
    goto after
}
branch = 2
after:
var finished = true`
        let (eval, vars) = EvaluateWithVariables(source)
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(1, vars["branch"])
        Assert.Equal(true, vars["finished"])
    }

    @Fact
    func LabelOnNonLoop_Binds_NoDiagnostics() {
        let source = "package P\nbogus: var x = 1"
        let diags = Bind(source)
        Assert.Empty(diags)
    }

    @Fact
    func Goto_UndefinedLabel_Emits_GS0469() {
        let source = "package P\ngoto nowhere"
        let diags = Bind(source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0469")
    }

    @Fact
    func DuplicateLabel_Emits_GS0470() {
        let source = `package P
lbl:
var a = 1
lbl:
var b = 2`
        let diags = Bind(source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0470")
    }

    @Fact
    func Goto_CanForwardReference_LabelDeclaredLater() {
        // The label is declared after the `goto` that targets it — this
        // must resolve without an undefined-label diagnostic (forward
        // reference), matching C#'s `goto` scoping.
        let source = `package P
var reached = false
goto after
after:
reached = true`
        let diags = Bind(source)
        Assert.Empty(diags)
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            return globalScope.Diagnostics.ToList()
        }

        private func EvaluateWithVariables(source string)(
            Result EmittedOracleResult,
            Variables IReadOnlyDictionary[string, object?]
        ) {
            // Post-run globals read back through the oracle (issue #3176 Phase
            // 3b.2): the emitted equivalent of the evaluator's variables
            // dictionary.
            let result = EmittedOracle.Evaluate(source)
            return (result, result.ReadGlobals())
        }
    }
}
