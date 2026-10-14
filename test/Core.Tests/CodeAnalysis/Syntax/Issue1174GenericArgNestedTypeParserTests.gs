// <copyright file="Issue1174GenericArgNestedTypeParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #1174: a dotted nested-type name (`Container.Nested`, `A.B.C`,
/// `Outer.Generic[T]`) must scan as a single type clause inside a
/// generic-argument position so a generic call / composite literal such as
/// `List[C.E](...)` or `List[C.E]{...}` is recognised by the
/// generic-call-site lookahead rather than being mis-parsed as an indexer (which
/// previously surfaced GS0005). The indexer-then-member disambiguation from
/// issue #942 (a trailing `.` AFTER the `]`) must be preserved.
open class Issue1174GenericArgNestedTypeParserTests {
    @Fact
    func GenericCall_WithDottedTypeArgument_ParsesWithoutDiagnostics() {
        const source = `
package p
import System.Collections.Generic
class C { data struct E(X uint32) { } }
func F() {
    let xs = List[C.E]()
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func GenericCompositeLiteral_WithDottedTypeArgument_ParsesWithoutDiagnostics() {
        const source = `
package p
import System.Collections.Generic
class C { data struct E(X uint32) { } }
func F() {
    let xs = List[C.E]{}
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func GenericReturnType_WithDottedTypeArgument_ParsesWithoutDiagnostics() {
        const source = `
package p
import System.Collections.Generic
class C { data struct E(X uint32) { } }
func F() List[C.E] { return List[C.E]() }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func GenericCall_WithDeepDottedTypeArgument_Parses() {
        const source = `
package p
import System.Collections.Generic
class A { class B { data struct C(Z uint32) { } } }
func F() {
    let xs = List[A.B.C]()
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func GenericCall_WithNestedGenericTypeArgument_Parses() {
        const source = `
package p
import System.Collections.Generic
class Outer { data struct Box[T](V T) { } }
func F() {
    let xs = List[Outer.Box[int32]]()
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func IndexerThenMember_NotRegressed_ByDottedTailSupport() {
        // Issue #942 guard: `arr[i].ToString()` is an indexer-then-member access,
        // not a generic call, and must still parse without diagnostics.
        const source = `
package p
import System
import System.Collections.Generic
func F() {
    let arr = List[int32]()
    let s = arr[0].ToString()
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }
}
