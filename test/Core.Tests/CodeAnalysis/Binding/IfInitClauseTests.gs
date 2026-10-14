// <copyright file="IfInitClauseTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Phase 2.5: `if init; cond { … }`. The initializer is a simple
/// statement (short-var decl, assignment, increment/decrement, or call)
/// whose scope spans both the then and else arms.
open class IfInitClauseTests {
    @Fact
    func IfInit_Binding_Is_Scoped_To_Arm() {
        Assert.Empty(Bind(`func F() {
 if var x = 1; x > 0 {
 var y = x
 }
 }
`))
    }

    @Fact
    func IfInit_Initializer_Not_Visible_After_Block() {
        let diagnostics = Bind(`func F() {
 if var x = 1; x > 0 {
 }
 var y = x
 }
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("doesn't exist", StringComparison.OrdinalIgnoreCase) ||
                d
                .Message
                .Contains("undefined", StringComparison.OrdinalIgnoreCase)
        )
    }

    @Fact
    func IfInit_With_Else_Sees_Initializer_In_Else_Arm() {
        Assert.Empty(Bind(`func F() {
 if var x = 1; x > 0 {
 var a = x
 } else {
 var b = x
 }
 }
`))
    }

    @Fact
    func IfWithoutInit_Still_Works() {
        Assert.Empty(Bind(`func F() {
 var x = 1
 if x > 0 {
 }
 }
`))
    }

    @Fact
    func IfInit_Allows_Assignment_As_Init() {
        Assert.Empty(Bind(`func F() {
 var x = 0
 if x = 1; x > 0 {
 }
 }
`))
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
