// <copyright file="LetKeywordTests.cs" company="GSharp">
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

/// Phase 1.6: `let` introduces an immutable runtime binding. At the
/// binder level it produces a (cref:VariableSymbol) with
/// `IsReadOnly == true`, indistinguishable from `const` in
/// every check that gates assignment.
open class LetKeywordTests {
    @Fact
    func Let_Binding_Is_ReadOnly() {
        let diagnostics = Bind(`func F() { let x = 1
 }
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Assignment_To_Let_Binding_Reports_CannotAssign() {
        let diagnostics = Bind(`func F() {
 let x = 1
 x = 2
 }
`)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("read-only", StringComparison.OrdinalIgnoreCase)
        )
    }

    @Fact
    func Let_Without_Initializer_Reports_Error() {
        let tree = SyntaxTree.Parse(SourceText.From(`func F() {
 let x
 }
`))
        Assert.NotEmpty(tree.Diagnostics)
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
