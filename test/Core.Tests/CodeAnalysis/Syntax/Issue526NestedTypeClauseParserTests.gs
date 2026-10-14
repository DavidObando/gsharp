// <copyright file="Issue526NestedTypeClauseParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #526: the parser must accept dotted-qualifier names in any type-clause
/// position (variable declaration type, parameter type, return type, base-type
/// clause, etc.) so a nested CLR type such as `Outer.Inner` is reachable.
/// These tests focus on the grammar/parser layer only — type resolution
/// is covered by end-to-end emit tests in test/Compiler.Tests/Emit/.
open class Issue526NestedTypeClauseParserTests {
    @Fact
    func VarDeclaration_With_DottedQualifier_TypeClause_ParsesWithoutDiagnostics() {
        // The exact shape from the issue body: `var x Outer.INested = nil`
        // used to surface two GS0005 (unexpected `<DotToken>`) errors; after
        // the fix it parses cleanly into a single TypeClauseSyntax with one
        // qualifier segment.
        const source = `
package P
func Use() {
    var x Outer.INested = nil
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let varDecl = fn.Body!!.Statements.OfType[VariableDeclarationSyntax]().Single()
        let type TypeClauseSyntax? = varDecl.TypeClause
        Assert.NotNull(type)
        Assert.Equal("Outer", type!!.Identifier!!.Text)
        Assert.True(type!!.HasQualifier)
        Assert.Single(type!!.QualifierIdentifierTokens)
        Assert.Equal("INested", type!!.QualifierIdentifierTokens[0].Text)
        Assert.Equal("Outer.INested", type!!.DottedName)
    }

    @Fact
    func VarDeclaration_With_ThreeLevel_DottedQualifier_Parses() {
        // Three-level nesting `A.B.C` parses as one type clause carrying two
        // qualifier segments, with the dotted name reconstructable from the
        // identifier + qualifier tokens.
        const source = `
package P
func Use() {
    var x A.B.C = nil
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let varDecl = fn.Body!!.Statements.OfType[VariableDeclarationSyntax]().Single()
        let type TypeClauseSyntax? = varDecl.TypeClause
        Assert.Equal("A", type!!.Identifier!!.Text)
        Assert.Equal(2, type!!.QualifierIdentifierTokens.Length)
        Assert.Equal("B", type!!.QualifierIdentifierTokens[0].Text)
        Assert.Equal("C", type!!.QualifierIdentifierTokens[1].Text)
        Assert.Equal("C", type!!.NameIdentifier!!.Text)
        Assert.Equal("A.B.C", type!!.DottedName)
    }

    @Fact
    func BaseClause_With_DottedQualifier_Parses() {
        // `class Impl : Outer.INested { … }` used to fail in the shared
        // base-type parsing path. Base entries are now full TypeClauseSyntax
        // nodes so dotted (and generic) forms are preserved structurally.
        const source = `
package P
class Impl : Outer.INested {
    func Compute() int32 { return 42 }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let typeDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.Equal("Impl", typeDecl.Identifier.Text)
        Assert.True(typeDecl.HasBaseType)
        Assert.Single(typeDecl.BaseTypeClauses)
        Assert.Equal("Outer.INested", typeDecl.BaseTypeClauses[0].DottedName)
    }

    @Fact
    func BaseClause_With_GenericInterface_Parses() {
        const source = `
package P
import System

class Impl : IComparable[string] {
    func CompareTo(value object) int32 { return 0 }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let typeDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.True(typeDecl.HasBaseType)
        Assert.Single(typeDecl.BaseTypeClauses)
        let baseType = typeDecl.BaseTypeClauses[0]
        Assert.Equal("IComparable", baseType.DottedName)
        Assert.True(baseType.HasTypeArguments)
        Assert.Equal("IComparable", baseType.NameIdentifier!!.Text)
        Assert.Single(baseType.TypeArguments!!)
        Assert.Equal("string", baseType.TypeArguments!![0].DottedName)
    }

    @Fact
    func GenericDeclaration_BaseClause_UsesTypeParameter_Parses() {
        const source = `
package P
import System.Collections.Generic

class MyGeneric[T any] : IEnumerable[T] {
    func GetEnumerator() IEnumerator[T] { return nil }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let typeDecl = tree.Root.Members.OfType[StructDeclarationSyntax]().Single()
        Assert.NotNull(typeDecl.TypeParameterList)
        Assert.True(typeDecl.HasBaseType)
        Assert.Single(typeDecl.BaseTypeClauses)
        let baseType = typeDecl.BaseTypeClauses[0]
        Assert.Equal("IEnumerable", baseType.DottedName)
        Assert.True(baseType.HasTypeArguments)
        Assert.Single(baseType.TypeArguments!!)
        Assert.Equal("T", baseType.TypeArguments!![0].DottedName)
    }

    @Fact
    func Function_Parameter_With_DottedQualifier_Parses() {
        const source = `
package P
func Run(x Outer.INested) {
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.Single(fn.Parameters)
        let param = fn.Parameters[0]
        Assert.Equal("Outer", param.Type!!.Identifier!!.Text)
        Assert.Equal("Outer.INested", param.Type!!.DottedName)
    }

    @Fact
    func Function_ReturnType_With_DottedQualifier_Parses() {
        const source = `
package P
func Make() Outer.INested {
    return nil
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.NotNull(fn.Type)
        Assert.Equal("Outer.INested", fn.Type!!.DottedName)
    }

    @Fact
    func DottedQualifier_With_Nullable_Suffix_Parses() {
        // The trailing `?` still attaches to the deepest segment.
        const source = `
package P
func Use() {
    var x Outer.INested? = nil
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let varDecl = fn.Body!!.Statements.OfType[VariableDeclarationSyntax]().Single()
        let type TypeClauseSyntax? = varDecl.TypeClause
        Assert.True(type!!.HasQualifier)
        Assert.True(type!!.IsNullable)
        Assert.Equal("Outer.INested", type!!.DottedName)
    }

    @Fact
    func DottedQualifier_With_TypeArguments_AttachesToDeepestSegment() {
        // `Outer.Generic[int32]` — type-argument list attaches to the deepest
        // segment of the qualifier chain.
        const source = `
package P
func Use() {
    var x Outer.Generic[int32] = nil
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let varDecl = fn.Body!!.Statements.OfType[VariableDeclarationSyntax]().Single()
        let type TypeClauseSyntax? = varDecl.TypeClause
        Assert.True(type!!.HasQualifier)
        Assert.True(type!!.HasTypeArguments)
        Assert.Equal("Generic", type!!.QualifierIdentifierTokens[^1].Text)
        Assert.Single(type!!.TypeArguments!!)
    }

    @Fact
    func SimpleIdentifier_TypeClause_HasNoQualifier() {
        // Regression guard: a plain single-identifier type clause must not
        // accidentally pick up a qualifier chain (verifies the dot-lookahead
        // is gated on a following IdentifierToken so we never miscount a
        // following member access as part of the type).
        const source = `
package P
func Use() {
    var x int32 = 0
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let varDecl = fn.Body!!.Statements.OfType[VariableDeclarationSyntax]().Single()
        let type TypeClauseSyntax? = varDecl.TypeClause
        Assert.Equal("int32", type!!.Identifier!!.Text)
        Assert.False(type!!.HasQualifier)
        Assert.Empty(type!!.QualifierIdentifierTokens)
        Assert.Equal("int32", type!!.DottedName)
    }
}
