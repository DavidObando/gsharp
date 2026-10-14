// <copyright file="Issue707WhileDoLabeledBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #707 / ADR-0070: binding-level tests for `while`, `do`-`while`,
/// labeled `break` / `continue`, and the associated diagnostics
/// (GS0120, GS0293, GS0295). Issue #1884 generalized `label:` onto non-loop
/// statements into `goto` targets (GS0469, GS0470) — see
/// Issue1884GotoLabelBindingTests.
open class Issue707WhileDoLabeledBindingTests {
    @Fact
    func While_Binds_Cleanly() {
        let source = `package P
var i = 0
while i < 3 { i = i + 1 }`
        let diags = Bind(source)
        Assert.Empty(diags)
    }

    @Fact
    func DoWhile_Binds_Cleanly() {
        let source = `package P
var i = 0
do { i = i + 1 } while i < 3`
        let diags = Bind(source)
        Assert.Empty(diags)
    }

    @Fact
    func LabeledFor_BreakLabel_BindsCleanly() {
        let source = `package P
outer: for var i = 0; i < 3; i++ {
    for var j = 0; j < 3; j++ {
        break outer
        continue outer
    }
}`
        let diags = Bind(source)
        Assert.Empty(diags)
    }

    @Fact
    func LabeledWhile_BreakLabel_BindsCleanly() {
        let source = `package P
outer: while true {
    for var j = 0; j < 1; j++ {
        break outer
    }
}`
        let diags = Bind(source)
        Assert.Empty(diags)
    }

    @Fact
    func LabeledDoWhile_BreakLabel_BindsCleanly() {
        let source = `package P
var n = 0
spin: do {
    for var j = 0; j < 1; j++ {
        break spin
    }
    n = n + 1
} while n < 1`
        let diags = Bind(source)
        Assert.Empty(diags)
    }

    @Fact
    func Break_OutsideLoop_Emits_GS0120() {
        let source = "package P\nbreak"
        let diags = Bind(source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0120")
    }

    @Fact
    func Continue_OutsideLoop_Emits_GS0120() {
        let source = "package P\ncontinue"
        let diags = Bind(source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0120")
    }

    @Fact
    func BreakWithUnknownLabel_Emits_GS0293() {
        let source = `package P
for var i = 0; i < 1; i++ {
    break notalabel
}`
        let diags = Bind(source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0293")
    }

    @Fact
    func ContinueWithUnknownLabel_Emits_GS0293() {
        let source = `package P
for var i = 0; i < 1; i++ {
    continue notalabel
}`
        let diags = Bind(source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0293")
    }

    @Fact
    func LabelOnNonLoop_IsValidGotoTarget() {
        // Issue #1884: a label on a non-loop statement no longer errors —
        // it declares a `goto` target instead of a loop label.
        let source = "package P\nbogus: if true { var x = 1 }"
        let diags = Bind(source)
        Assert.Empty(diags)
    }

    @Fact
    func NestedLabelShadow_Emits_GS0295_Warning() {
        let source = `package P
outer: for var i = 0; i < 1; i++ {
    outer: for var j = 0; j < 1; j++ {
        break outer
    }
}`
        let diags = Bind(source)
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0295")
    }

    @Fact
    func LabeledBreakFromInner_TargetsOuterBreakLabel() {
        // Sanity check: when nested loops both have break labels, the inner
        // `break outer` resolves to the *outer* loop's break target (the
        // first one allocated). The bound program printed by
        // BoundNodePrinter exposes the goto target name, so we can grep
        // for the expected target string.
        let source = `package P
outer: for {
    for {
        break outer
    }
}`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let program = Binder.BindProgram(compilation.GlobalScope, compilation.References)
        Assert.Empty(program.Diagnostics)
        let sb = StringWriter()
        BoundNodeWriter.WriteTo(program.Statement, sb)
        let text = sb.ToString()
        // Outer loop's BindLoopBody runs first → break1 / continue1.
        // Inner loop's BindLoopBody runs second → break2 / continue2.
        // The `break outer` must jump to `break1`, not `break2`.
        Assert.Contains("break1", text)
        Assert.Contains("goto break1", text)
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            return globalScope.Diagnostics.ToList()
        }
    }
}
