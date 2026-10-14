// <copyright file="Issue2027GotoLabelIsolationBinderTests.cs" company="GSharp">
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

/// Issue #2027 (follow-up to #1884 / PR #2025): the `goto`/label
/// namespace ((cref:BinderContext.UserLabels) /
/// (cref:BinderContext.DefinedUserLabels) /
/// (cref:BinderContext.UnresolvedGotoLabels)) and the loop-label
/// stack ((cref:BinderContext.LoopStack)) must be isolated per
/// function-equivalent frame — a lambda or a local function is its own
/// frame, distinct from its enclosing function, matching C#'s prohibition
/// on cross-frame `goto` flow. These tests pin: a nested-frame
/// `goto` referencing an outer-only label is undefined (GS0469) rather
/// than silently resolving cross-frame; a nested frame may declare its own
/// label reusing an outer name with no leak in either direction; and a
/// single-frame (no lambda/local-function nesting) `goto` still works
/// exactly as before.
open class Issue2027GotoLabelIsolationBinderTests {
    @Fact
    func Lambda_GotoReferencesOuterOnlyLabel_EmitsGS0469() {
        // "outerLabel" is declared only in the enclosing function; the
        // lambda's own goto/label frame never sees it.
        let source = `package P
var reached = false
outerLabel:
reached = true
let f = (x int32) -> { goto outerLabel
return x }`
        let diags = Bind(source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0469")
    }

    @Fact
    func Lambda_DeclaresOwnLabelMatchingOuterName_NoLeak() {
        // Both the enclosing function and the lambda declare a "sameLabel"
        // — separate frames, so this must bind cleanly with no duplicate-
        // label (GS0470) or undefined-label (GS0469) diagnostic, and the
        // lambda's `goto` must resolve to the lambda's OWN label.
        let source = `package P
var outerHit = false
sameLabel:
outerHit = true
let f = (x int32) -> {
    goto sameLabel
    sameLabel:
    return x
}`
        let diags = Bind(source)
        Assert.Empty(diags)
    }

    @Fact
    func LocalFunction_GotoReferencesOuterOnlyLabel_EmitsGS0469() {
        let source = `package P
outerLabel:
var reached = false
let f = func() {
    goto outerLabel
}`
        let diags = Bind(source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0469")
    }

    @Fact
    func LocalFunction_DeclaresOwnLabelMatchingOuterName_NoLeak() {
        let source = `package P
var outerHit = false
sameLabel:
outerHit = true
let f = func() {
    goto sameLabel
    sameLabel:
    var innerHit = true
}`
        let diags = Bind(source)
        Assert.Empty(diags)
    }

    @Fact
    func LabelInsideLambda_NotVisibleToEnclosingGoto_EmitsGS0469() {
        // The reverse leak direction: a label declared ONLY inside the
        // lambda must not satisfy a `goto` in the enclosing function.
        let source = `package P
var reached = false
goto innerOnly
let f = (x int32) -> {
    innerOnly:
    return x
}
reached = true`
        let diags = Bind(source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0469")
    }

    @Fact
    func SingleFrame_NoNesting_GotoStillWorks_NoRegression() {
        // Sanity: plain top-level goto/label with no lambda/local-function
        // nesting binds and evaluates exactly as before this fix.
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
