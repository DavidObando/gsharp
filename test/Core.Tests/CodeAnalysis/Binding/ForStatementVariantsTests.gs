// <copyright file="ForStatementVariantsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Phase 2.4: `for cond { … }` (for-as-while) and the C-style
/// `for init; cond; post { … }`.
open class ForStatementVariantsTests {
    @Fact
    func ForCondition_Parses_And_Binds() {
        Assert.Empty(Bind(`func F() {
 var x = 0
 for x < 3 {
 x = x + 1
 }
 }
`))
    }

    @Fact
    func ForClause_Full_Parses_And_Binds() {
        Assert.Empty(Bind(`func F() {
 for var i = 0; i < 3; i++ {
 }
 }
`))
    }

    @Fact
    func ForClause_EmptyInit_EmptyPost_Binds() {
        Assert.Empty(Bind(`func F() {
 var x = 0
 for ; x < 3; {
 x = x + 1
 }
 }
`))
    }

    @Fact
    func ForClause_AllEmpty_BindsAsInfinite() {
        Assert.Empty(Bind(`func F() {
 for ;; {
 break
 }
 }
`))
    }

    @Fact
    func ForClause_Continue_Reaches_Post() {
        // If `continue` skipped `i++` we'd loop forever; the test just
        // checks the bound program is well-formed.
        Assert.Empty(Bind(`func F() {
 for var i = 0; i < 3; i++ {
 if i == 1 { continue }
 }
 }
`))
    }

    @Fact
    func ForCondition_Recognizes_Break() {
        Assert.Empty(Bind(`func F() {
 var x = 0
 for true {
 break
 }
 }
`))
    }

    @Fact
    func ForInfinite_Still_Works() {
        Assert.Empty(Bind(`func F() {
 for {
 break
 }
 }
`))
    }

    @Fact
    func ForEllipsis_Still_Works() {
        Assert.Empty(Bind(`func F() {
 for i in 0 ... 3 {
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
