// <copyright file="Issue1046JaggedArrayParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #1046: the array/slice type clause `[]T` previously required the
/// element `T` to be a bare (qualified, possibly generic) identifier, so
/// jagged arrays `[][]T`, arrays of pointers `[]*T` and arrays of
/// maps `[]map[K]V` failed to parse with GS0005. The element is now a full
/// nested (cref:TypeClauseSyntax) (mirroring the pointer/chan/map element
/// recursion). These tests cover the parser layer; binding/runtime behaviour is
/// covered by emit tests in test/Compiler.Tests/Emit/.
open class Issue1046JaggedArrayParserTests {
    @Fact
    func JaggedSlice_InVarDeclaration_Parses_AsNestedSliceElement() {
        // The exact repro from the issue body: `var x [][]uint8 = default(...)`.
        let type TypeClauseSyntax? = LocalVarType("[][]uint8")
        Assert.True(type!!.IsArray)
        Assert.True(type!!.IsSlice)
        Assert.True(type!!.HasNestedArrayElement)
        let inner TypeClauseSyntax? = type!!.ArrayElementType
        Assert.NotNull(inner)
        Assert.True(inner!!.IsSlice)
        Assert.False(inner!!.HasNestedArrayElement)
        Assert.Equal("uint8", inner!!.Identifier!!.Text)
    }

    @Fact
    func TripleNestedSlice_Parses_TwoLevelsDeep() {
        let type TypeClauseSyntax? = LocalVarType("[][][]int32")
        Assert.True(type!!.IsSlice)
        Assert.True(type!!.HasNestedArrayElement)
        let lvl2 TypeClauseSyntax? = type!!.ArrayElementType
        Assert.True(lvl2!!.IsSlice)
        Assert.True(lvl2!!.HasNestedArrayElement)
        let lvl3 TypeClauseSyntax? = lvl2!!.ArrayElementType
        Assert.True(lvl3!!.IsSlice)
        Assert.False(lvl3!!.HasNestedArrayElement)
        Assert.Equal("int32", lvl3!!.Identifier!!.Text)
    }

    @Fact
    func SizedJaggedArray_Parses_WithLengthAndNestedSliceElement() {
        let type TypeClauseSyntax? = LocalVarType("[3][]uint8")
        Assert.True(type!!.IsArray)
        Assert.False(type!!.IsSlice)
        Assert.NotNull(type!!.LengthToken)
        Assert.True(type!!.HasNestedArrayElement)
        Assert.True(type!!.ArrayElementType!!.IsSlice)
    }

    @Fact
    func ArrayOfMap_Parses_WithNestedMapElement() {
        let type TypeClauseSyntax? = LocalVarType("[]map[string,int32]")
        Assert.True(type!!.IsSlice)
        Assert.True(type!!.HasNestedArrayElement)
        Assert.True(type!!.ArrayElementType!!.IsMap)
    }

    @Fact
    func ArrayOfChannel_Parses_WithNestedChannelElement() {
        let type TypeClauseSyntax? = LocalVarType("[]chan[int32]")
        Assert.True(type!!.IsSlice)
        Assert.True(type!!.HasNestedArrayElement)
        Assert.True(type!!.ArrayElementType!!.IsChannel)
    }

    @Fact
    func ArrayOfPointer_Parses_WithNestedPointerElement() {
        let type TypeClauseSyntax? = LocalVarType("[]*int32")
        Assert.True(type!!.IsSlice)
        Assert.True(type!!.HasNestedArrayElement)
        Assert.True(type!!.ArrayElementType!!.IsPointer)
    }

    @Fact
    func JaggedSlice_InParameterPosition_Parses() {
        const source = `
package P
func Use(grid [][]uint8) {
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let param = fn.Parameters.Single()
        Assert.True(param.Type!!.IsSlice)
        Assert.True(param.Type!!.HasNestedArrayElement)
        Assert.True(param.Type!!.ArrayElementType!!.IsSlice)
    }

    @Fact
    func JaggedSlice_InReturnPosition_Parses() {
        const source = `
package P
func Make() [][]uint8 {
    return default([][]uint8)
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let fn = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.True(fn.Type!!.IsSlice)
        Assert.True(fn.Type!!.HasNestedArrayElement)
        Assert.True(fn.Type!!.ArrayElementType!!.IsSlice)
    }

    @Fact
    func JaggedSlice_InFieldPosition_Parses() {
        const source = `
package P
class Grid {
    var Cells [][]uint8
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func JaggedSlice_InIsPattern_Parses() {
        const source = `
package P
func Use(o object) bool {
    return o is [][]uint8
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    // ---- Regression: existing element forms must still parse the flat path. ----
    @Fact
    func SingleSlice_OfIdentifier_StillParses_Flat() {
        let type TypeClauseSyntax? = LocalVarType("[]uint8")
        Assert.True(type!!.IsSlice)
        Assert.False(type!!.HasNestedArrayElement)
        Assert.Equal("uint8", type!!.Identifier!!.Text)
    }

    @Fact
    func Slice_OfQualifiedName_StillParses_Flat() {
        let type TypeClauseSyntax? = LocalVarType("[]Outer.Inner")
        Assert.True(type!!.IsSlice)
        Assert.False(type!!.HasNestedArrayElement)
        Assert.Equal("Outer", type!!.Identifier!!.Text)
        Assert.Equal("Outer.Inner", type!!.DottedName)
    }

    @Fact
    func Slice_OfGenericName_StillParses_Flat() {
        let type TypeClauseSyntax? = LocalVarType("[]List[int32]")
        Assert.True(type!!.IsSlice)
        Assert.False(type!!.HasNestedArrayElement)
        Assert.Equal("List", type!!.Identifier!!.Text)
        Assert.True(type!!.HasTypeArguments)
    }

    @Fact
    func Pointer_OfIdentifier_StillParses() {
        let type TypeClauseSyntax? = LocalVarType("*int32")
        Assert.True(type!!.IsPointer)
        Assert.False(type!!.IsArray)
        Assert.NotNull(type!!.PointerPointeeType)
    }

    @Fact
    func Map_StillParses() {
        let type TypeClauseSyntax? = LocalVarType("map[string,int32]")
        Assert.True(type!!.IsMap)
        Assert.False(type!!.IsArray)
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
