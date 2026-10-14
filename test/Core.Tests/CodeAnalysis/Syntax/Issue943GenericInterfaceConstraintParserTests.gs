// <copyright file="Issue943GenericInterfaceConstraintParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import Xunit

/// Issue #943: a type-parameter constraint that names a constructed generic
/// interface — e.g. `[T IComparable[T]]` — must parse without GS0005. The
/// regression was in `LooksLikeTypeParameterList`, whose lookahead failed
/// to skip the constraint's own generic-argument bracket segment and so
/// mis-classified the type-parameter list as an indexer. These tests assert the
/// shape round-trips and exposes the constraint identifier plus its type
/// arguments.
open class Issue943GenericInterfaceConstraintParserTests {
    @Fact
    func SelfReferentialGenericInterfaceConstraint_Parses_WithoutDiagnostics() {
        const source = `package P
import System
func Max[T IComparable[T]](a T, b T) T {
    if a.CompareTo(b) > 0 { return a }
    return b
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tp TypeParameterSyntax? = FindFirstTypeParameter(tree)
        Assert.Equal("T", tp!!.Identifier.Text)
        Assert.Equal("IComparable", tp!!.Constraint!!.Text)
        Assert.Equal(1, tp!!.ConstraintTypeArguments!!.Count)
    }

    @Fact
    func GenericInterfaceConstraint_WithClosedTypeArgument_Parses() {
        const source = `package P
import System
func F[T IComparable[int32]](x T) T { return x }`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tp TypeParameterSyntax? = FindFirstTypeParameter(tree)
        Assert.Equal("IComparable", tp!!.Constraint!!.Text)
        Assert.Equal(1, tp!!.ConstraintTypeArguments!!.Count)
    }

    @Fact
    func NonGenericInterfaceConstraint_StillParses() {
        const source = `package P
import System
func F[T IDisposable](x T) T { return x }`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tp TypeParameterSyntax? = FindFirstTypeParameter(tree)
        Assert.Equal("IDisposable", tp!!.Constraint!!.Text)
        Assert.True(tp!!.ConstraintTypeArguments == nil || tp!!.ConstraintTypeArguments!!.Count == 0)
    }

    shared {
        private func FindFirstTypeParameter(tree SyntaxTree) TypeParameterSyntax? {
            var found TypeParameterSyntax? = nil
            let Walk = func (node SyntaxNode) {
                if found != nil {
                    return
                }
                if node is TypeParameterSyntax tp {
                    found = tp
                    return
                }
                for c in node.GetChildren() {
                    Walk(c)
                }
            }
            Walk(tree.Root)
            return found
        }
    }
}
