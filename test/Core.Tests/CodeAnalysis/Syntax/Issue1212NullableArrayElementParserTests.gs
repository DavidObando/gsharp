// <copyright file="Issue1212NullableArrayElementParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #1212: where the nullable `?` binds in an array/slice type clause.
/// - `[]T?` — the trailing `?` binds to the ELEMENT ((cref:TypeClauseSyntax.IsNullable) on the array
/// clause; the array itself is non-nullable).
/// - `[]?T` — a `?` right after `]` marks the whole array nullable
/// ((cref:TypeClauseSyntax.IsArrayNullable)).
/// - `[]?T?` — both markers are present.
/// Covers slices, fixed-length arrays, and jagged arrays.
open class Issue1212NullableArrayElementParserTests {
    @Fact
    func ElementNullableSlice_BindsQuestionToElement() {
        let type TypeClauseSyntax? = LocalVarType("[]int32?")
        Assert.True(type!!.IsSlice)
        Assert.True(type!!.IsNullable) // trailing `?` -> element nullable
        Assert.False(type!!.IsArrayNullable) // array itself is non-nullable
        Assert.Equal("int32", type!!.Identifier!!.Text)
    }

    @Fact
    func NullableArraySlice_BindsQuestionToArray() {
        let type TypeClauseSyntax? = LocalVarType("[]?int32")
        Assert.True(type!!.IsSlice)
        Assert.False(type!!.IsNullable) // element is non-nullable
        Assert.True(type!!.IsArrayNullable) // `?` after `]` -> array nullable
        Assert.Equal("int32", type!!.Identifier!!.Text)
    }

    @Fact
    func NullableArrayOfNullableElements_HasBothMarkers() {
        let type TypeClauseSyntax? = LocalVarType("[]?int32?")
        Assert.True(type!!.IsSlice)
        Assert.True(type!!.IsNullable) // trailing `?` -> element nullable
        Assert.True(type!!.IsArrayNullable) // leading `?` -> array nullable
        Assert.Equal("int32", type!!.Identifier!!.Text)
    }

    @Fact
    func ElementNullableFixedArray_BindsQuestionToElement() {
        let type TypeClauseSyntax? = LocalVarType("[3]int32?")
        Assert.True(type!!.IsArray)
        Assert.False(type!!.IsSlice)
        Assert.True(type!!.IsNullable)
        Assert.False(type!!.IsArrayNullable)
        Assert.Equal("3", type!!.LengthToken!!.Text)
        Assert.Equal("int32", type!!.Identifier!!.Text)
    }

    @Fact
    func NullableFixedArray_BindsQuestionToArray() {
        let type TypeClauseSyntax? = LocalVarType("[3]?int32")
        Assert.True(type!!.IsArray)
        Assert.False(type!!.IsSlice)
        Assert.False(type!!.IsNullable)
        Assert.True(type!!.IsArrayNullable)
        Assert.Equal("3", type!!.LengthToken!!.Text)
        Assert.Equal("int32", type!!.Identifier!!.Text)
    }

    @Fact
    func JaggedSliceOfNullableElements_BindsInnerElementNullable() {
        // `[][]int32?` — the trailing `?` binds to the innermost element.
        let type TypeClauseSyntax? = LocalVarType("[][]int32?")
        Assert.True(type!!.IsSlice)
        Assert.False(type!!.IsNullable)
        Assert.False(type!!.IsArrayNullable)
        Assert.True(type!!.HasNestedArrayElement)
        let inner TypeClauseSyntax? = type!!.ArrayElementType
        Assert.True(inner!!.IsSlice)
        Assert.True(inner!!.IsNullable) // inner `[]int32?` element nullable
        Assert.False(inner!!.IsArrayNullable)
        Assert.Equal("int32", inner!!.Identifier!!.Text)
    }

    @Fact
    func NullableArrayOfNestedElement_BindsOuterArrayNullable() {
        // `[]?*int32` — the outer slice reference is nullable; the element is a
        // nested (pointer) type clause.
        let type TypeClauseSyntax? = LocalVarType("[]?*int32")
        Assert.True(type!!.IsSlice)
        Assert.True(type!!.IsArrayNullable)
        Assert.False(type!!.IsNullable)
        Assert.True(type!!.HasNestedArrayElement)
        let inner TypeClauseSyntax? = type!!.ArrayElementType
        Assert.True(inner!!.IsPointer)
        Assert.False(inner!!.IsArrayNullable)
        Assert.False(inner!!.IsNullable)
    }

    @Fact
    func NullableArrayOfArrayElement_BindsOuterArrayNullable() {
        // Issue #1351: `[]?[]int32` — the outer slice is nullable and its element
        // is itself a slice. The `?[` is lexed as a single null-conditional index
        // token; the parser splits it back into `?` (array-nullable) + `[` (nested
        // element array) so the faithful nullable-jagged-array form parses.
        let type TypeClauseSyntax? = LocalVarType("[]?[]int32")
        Assert.True(type!!.IsSlice)
        Assert.True(type!!.IsArrayNullable)
        Assert.False(type!!.IsNullable)
        Assert.True(type!!.HasNestedArrayElement)
        let inner TypeClauseSyntax? = type!!.ArrayElementType
        Assert.True(inner!!.IsSlice)
        Assert.False(inner!!.IsArrayNullable)
        Assert.False(inner!!.IsNullable)
        Assert.Equal("int32", inner!!.Identifier!!.Text)
    }

    shared {
        private func LocalVarType(typeText string) TypeClauseSyntax? {
            let source = (`
package P
func Use() {
    var x ` + "$typeText" + ` = default(` + "$typeText" + `)
}
`)
            let tree = SyntaxTree.Parse(source)
            Assert.Empty(tree.Diagnostics)
            let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
            let varDecl = fn.Body!!.Statements.OfType[VariableDeclarationSyntax]().Single()
            Assert.NotNull(varDecl.TypeClause)
            return varDecl.TypeClause
        }
    }
}
