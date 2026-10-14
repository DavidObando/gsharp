// <copyright file="Issue3409ConditionalDefiniteAssignmentTests.cs" company="GSharp">
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

/// Issue #3409 follow-on: definite assignment is tracked per branch edge of a
/// conditional (`&&` / `||` / `!`), so an `out` argument assigned in
/// the right operand of `&&` counts on the true edge (C# §9.4.4).
/// The native ADR-0166 pattern shape `x is T t && t.TryGet(out v)`
/// exposed the previous conservative rule (GS0238 on the true branch).
class Issue3409ConditionalDefiniteAssignmentTests {
    @Theory
    @InlineData(`if x is Foo foo && foo.TryGet(name, out value) { return true }
    value = nil
    return false`)
    @InlineData(`if x is Foo && (x as Foo)!!.TryGet(name, out value) { return true }
    value = nil
    return false`)
    @InlineData(`if !(x != nil && foo.TryGet(name, out value)) { value = nil
        return false }
    return true`)
    @InlineData(`if x == nil || !foo.TryGet(name, out value) { value = nil
        return false }
    return true`)
    func OutAssignmentInShortCircuitOperand_CountsOnTheMatchingEdge(body string) {
        let diagnostics = Bind(Prelude + (`func Try(x object?, foo Foo, name string, out value string?) bool {
    ` + "$body" + `
}`))
        Assert.Empty(diagnostics)
    }

    @Theory
    @InlineData(`if x == nil || foo.TryGet(name, out value) { return true }
    value = nil
    return false`)
    @InlineData("if x != nil && foo.TryGet(name, out value) { value = nil\n        return false } else { return true }")
    func OutAssignmentInShortCircuitOperand_DoesNotCountOnTheOtherEdge(body string) {
        let diagnostics = Bind(Prelude + (`func Try(x object?, foo Foo, name string, out value string?) bool {
    ` + "$body" + `
}`))
        let diagnostic = Assert.Single(diagnostics)
        Assert.Equal("GS0238", diagnostic.Id)
    }

    shared {
        private const Prelude string = `class Foo {
    func TryGet(name string, out value string?) bool {
        value = name
        return true
    }
}
`

        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            return Binder.BindProgram(globalScope).Diagnostics
        }
    }
}
