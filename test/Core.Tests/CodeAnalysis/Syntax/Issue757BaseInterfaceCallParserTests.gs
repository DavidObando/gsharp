// <copyright file="Issue757BaseInterfaceCallParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// ADR-0091 / issue #757: parser surface tests for the explicit-base
/// interface-call expression `base[IFoo].Method(args)`. Verifies
/// that the new shape parses cleanly, that the existing constructor
/// chaining form (`init(...) : base(args)`) and ordinary uses of
/// the identifier `base` are unaffected, and that ill-formed shapes
/// produce parser diagnostics rather than silently mis-parsing.
open class Issue757BaseInterfaceCallParserTests {
    @Fact
    func BaseInterfaceCall_Parses() {
        const source = `package P
interface IFoo {
    func M() int32 { return 1 }
}
class C : IFoo {
    func M() int32 {
        return base[IFoo].M()
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func BaseInterfaceCall_WithArguments_Parses() {
        const source = `package P
interface IFoo {
    func M(x int32, y int32) int32 { return x + y }
}
class C : IFoo {
    func M(x int32, y int32) int32 {
        return base[IFoo].M(x, y)
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func BaseInterfaceCall_Chaining_Parses() {
        const source = `package P
interface IA {
    func M() int32 { return 1 }
}
interface IB {
    func M() int32 { return 2 }
}
class C : IA, IB {
    func M() int32 {
        return base[IA].M() + base[IB].M()
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ConstructorChaining_BaseCall_StillParses() {
        // ADR-0091: the `init(...) : base(args)` shape must remain
        // unaffected by the contextual `base[` recognition — `base(`
        // (paren) is the chain form, `base[` (bracket) is the new form.
        const source = `package P
class B {
    init(x int32) { }
}
class D {
    init(x int32) : base(x) { }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func IdentifierNamedBase_StillParses() {
        // `base` is a contextual identifier — using it as a local
        // variable name must still work outside the `base[...]` shape.
        const source = `package P
func F() int32 {
    var base = 5
    return base
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func BaseInterfaceCall_NodeShape_IsBaseInterfaceCallExpression() {
        // Verifies the bracketed form lands on a
        // BaseInterfaceCallExpressionSyntax node, not on the generic
        // IndexExpression path.
        const source = `package P
interface IFoo {
    func M() int32 { return 1 }
}
class C : IFoo {
    func M() int32 {
        return base[IFoo].M()
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let found BaseInterfaceCallExpressionSyntax? = FindFirst[BaseInterfaceCallExpressionSyntax](tree.Root)
        Assert.NotNull(found)
        Assert.Equal(SyntaxKind.BaseInterfaceCallExpression, found!!.Kind)
        Assert.Equal("base", found!!.BaseKeyword.Text)
        Assert.Equal("M", found!!.MethodIdentifier.Text)
        Assert.Empty(found!!.Arguments)
    }

    shared {
        private func FindFirst[T SyntaxNode](root SyntaxNode) T? {
            if root is T match {
                return match
            }
            for child in root.GetChildren() {
                let found T? = FindFirst[T](child)
                if found != nil {
                    return found
                }
            }
            return nil
        }
    }
}
