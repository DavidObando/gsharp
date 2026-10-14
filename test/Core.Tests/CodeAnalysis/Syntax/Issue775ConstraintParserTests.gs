// <copyright file="Issue775ConstraintParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0097 / issue #775: parser-side acceptance tests for the new
/// `class` / `struct` / `init()` type-parameter
/// constraint spellings (the default-constructor constraint was renamed
/// from `new()` to `init()` by issue #997). The parser must
/// round-trip each spelling (including all legal combinations) without
/// diagnostics, must reach the (cref:TypeParameterSyntax) node and
/// expose the correct boolean flags, and must not regress on the legacy
/// spellings (`any`, `comparable`, sealed-interface name, generic-bound
/// shape `[T IAdd[T]]`).
open class Issue775ConstraintParserTests {
    @Fact
    func ClassConstraint_Parses_AndExposesFlag() {
        const source = "func F[T class](x T) T { return x }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tp = FindFirstTypeParameter(tree)
        Assert.True(tp.HasClassConstraint)
        Assert.False(tp.HasStructConstraint)
        Assert.False(tp.HasInitConstraint)
        Assert.Null(tp.Constraint)
    }

    @Fact
    func StructConstraint_Parses_AndExposesFlag() {
        const source = "func F[T struct](x T) T { return x }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tp = FindFirstTypeParameter(tree)
        Assert.False(tp.HasClassConstraint)
        Assert.True(tp.HasStructConstraint)
        Assert.False(tp.HasInitConstraint)
    }

    @Fact
    func InitConstraint_Parses_AndExposesFlag() {
        const source = "func F[T init()](x T) T { return x }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tp = FindFirstTypeParameter(tree)
        Assert.False(tp.HasClassConstraint)
        Assert.False(tp.HasStructConstraint)
        Assert.True(tp.HasInitConstraint)
        Assert.NotNull(tp.InitConstraintOpenParenToken)
        Assert.NotNull(tp.InitConstraintCloseParenToken)
    }

    @Fact
    func ClassAndInitConstraint_Combined_Parses() {
        const source = "func F[T class init()](x T) T { return x }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tp = FindFirstTypeParameter(tree)
        Assert.True(tp.HasClassConstraint)
        Assert.True(tp.HasInitConstraint)
    }

    @Fact
    func InterfaceAndClassConstraint_Combined_Parses() {
        const source = `package P
sealed interface IFoo { func M(); }
func F[T IFoo class](x T) T { return x }`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tp = FindFirstTypeParameter(tree)
        Assert.NotNull(tp.Constraint)
        Assert.Equal("IFoo", tp.Constraint!!.Text)
        Assert.True(tp.HasClassConstraint)
    }

    @Fact
    func TwoTypeParameters_DifferentConstraints_Parse() {
        const source = "func F[T class, U struct](x T, y U) T { return x }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let typeParams = FindAllTypeParameters(tree)
        Assert.Equal(2, typeParams.Count)
        Assert.True(typeParams[0].HasClassConstraint)
        Assert.False(typeParams[0].HasStructConstraint)
        Assert.False(typeParams[1].HasClassConstraint)
        Assert.True(typeParams[1].HasStructConstraint)
    }

    @Fact
    func LegacyAnyConstraint_StillParses() {
        const source = "func F[T any](x T) T { return x }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tp = FindFirstTypeParameter(tree)
        Assert.NotNull(tp.Constraint)
        Assert.Equal("any", tp.Constraint!!.Text)
        Assert.False(tp.HasClassConstraint)
        Assert.False(tp.HasStructConstraint)
        Assert.False(tp.HasInitConstraint)
    }

    @Fact
    func LegacyComparableConstraint_StillParses() {
        const source = "func F[T comparable](a T, b T) bool { return a == b }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tp = FindFirstTypeParameter(tree)
        Assert.Equal("comparable", tp.Constraint!!.Text)
    }

    @Fact
    func ClassConstraint_OnClassDeclaration_Parses() {
        const source = `package P
class Box[T class] {
    var v T
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func StructConstraint_OnDataStruct_Parses() {
        const source = "package P\ndata struct Holder[T struct] { var v T }"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func InitConstraint_OnClassDeclaration_Parses() {
        const source = `package P
class Box[T init()] {
    var v T
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tp = FindFirstTypeParameter(tree)
        Assert.True(tp.HasInitConstraint)
    }

    @Fact
    func InitCtorDeclaration_StillParses_NoRegressionFromInitConstraint() {
        // Issue #997 guard: adding `init()` as a contextual constraint keyword
        // (only inside a generic parameter list) must NOT break the existing
        // `init(...)` constructor declaration syntax in a class body.
        const source = `package P
class Rect {
    var Width int32
    var Height int32
    init(w int32, h int32) {
        Width = w
        Height = h
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func InitOnlyProperty_StillParses_NoRegressionFromInitConstraint() {
        // Issue #997 guard: the `init` accessor of an init-only property must
        // still parse correctly after `init()` becomes a constraint keyword.
        const source = `package P
class Box {
    prop X int32 { get; init; }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func InitConstraint_WithInitCtor_BothParseTogether() {
        // Issue #997: a generic class can carry an `init()` constraint on its
        // type parameter AND declare an `init(...)` constructor in its body.
        const source = `package P
class Box[T init()] {
    var v T
    init(value T) {
        v = value
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let tp = FindFirstTypeParameter(tree)
        Assert.True(tp.HasInitConstraint)
    }

    shared {
        private func FindFirstTypeParameter(tree SyntaxTree) TypeParameterSyntax {
            return FindAllTypeParameters(tree).First()
        }

        private func FindAllTypeParameters(tree SyntaxTree) List[TypeParameterSyntax] {
            let results = List[TypeParameterSyntax]()
            let Walk = func (node SyntaxNode) {
                if node is TypeParameterSyntax tp {
                    results.Add(tp)
                }
                for c in node.GetChildren() {
                    Walk(c)
                }
            }
            Walk(tree.Root)
            return results
        }
    }
}
