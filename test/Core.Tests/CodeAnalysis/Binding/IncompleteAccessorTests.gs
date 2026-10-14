// <copyright file="IncompleteAccessorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import Xunit

/// Regression tests for binding incomplete member-access expressions (e.g. `x.`)
/// that the language server hits while the user is mid-typing. Binding such input must
/// not throw — the parser already reports the missing identifier — otherwise the LSP
/// completion and semantic-tokens requests fail.
open class IncompleteAccessorTests {
    @Theory
    @InlineData("var x int32 = 42\nx.")
    @InlineData(`var x int32 = 42
x.
`)
    @InlineData("var s string = \"a\"\ns.")
    @InlineData("var x int32 = 42\nx.foo.")
    @InlineData(`var x int32 = 42
x.
x.
`)
    func IncompleteMemberAccess_DoesNotThrow(source string) {
        let tree = SyntaxTree.Parse(source)
        let compilation = Compilation(tree)
        let globalScope = compilation.GlobalScope
        Assert.NotNull(globalScope)
        let program = Binder.BindProgram(globalScope)
        Assert.NotNull(program)
        // The dangling accessor is reported as a syntax diagnostic, not a crash.
        Assert.NotEmpty(tree.Diagnostics)
    }
}
