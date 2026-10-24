// <copyright file="Issue5191NamedTupleSliceArrowBodyParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #5191 / ADR-0172: a parenthesized type list whose element reads `name Type`
/// is a named tuple type, never the parameter list of an arrow function type. A
/// slice of such a tuple that is followed by the expression-body arrow must parse as
/// a tuple return type, whatever the number of literal elements in the body.
open class Issue5191NamedTupleSliceArrowBodyParserTests {
    @Fact
    func NamedTupleSliceReturn_TwoElementLiteralArrowBody_ParsesAsTupleSliceReturn() {
        const typeText = "[](A int64, B object?)"
        const source = "package P\n" +
            "func M1() " +
            typeText +
            " -> [](A int64, B object?){(A: 1, B: nil), (A: 2, B: \"x\")}\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let function = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        let type = function.Type!!
        Assert.True(type.IsSlice)
        Assert.False(type.IsArrowFunction)
        Assert.Equal(source.IndexOf(typeText, System.StringComparison.Ordinal), type.Span.Start)
        Assert.Equal(typeText.Length, type.Span.Length)
        let element = type.ArrayElementType!!
        Assert.True(element.IsTuple)
        Assert.False(element.IsArrowFunction)
        let tupleElements = element.TupleElements!!
        Assert.Equal(2, tupleElements.Count)
        Assert.Equal("A", tupleElements[0].TupleElementNameToken!!.Text)
        Assert.Equal("B", tupleElements[1].TupleElementNameToken!!.Text)
        let returnStatement = Assert.IsType[ReturnStatementSyntax](Assert.Single(function.Body!!.Statements))
        let literal = Assert.IsType[ArrayCreationExpressionSyntax](returnStatement.Expression)
        Assert.Equal(2, literal.Elements!!.Count)
        Assert.All(literal.Elements!!, (e ExpressionSyntax) -> Assert.IsType[TupleLiteralExpressionSyntax](e))
    }

    @Theory
    @InlineData("[](A int64, B string) -> [](A int64, B string){(A: 1, B: \"q\")}", 1)
    @InlineData("[](A int64, B string) -> [](A int64, B string){(A: 1, B: \"q\"), (A: 2, B: \"x\"),}", 2)
    @InlineData("[](A int64, B string) -> [](A int64, B string){(1, \"q\"), (2, \"x\")}", 2)
    @InlineData("[](A int64, B string) -> [](A int64, B string){}", 0)
    @InlineData("[](A int64, B string) -> [](A int64, B string){(A: 1, B: \"q\"),\n (A: 2, B: \"x\")}", 2)
    @InlineData("[](A int64, B string, C bool) -> [](A int64, B string, C bool){(A: 1, B: \"q\", C: true)}", 1)
    func NamedTupleSliceReturn_ArrowBodyVariants_ParseAsTupleSliceReturn(returnAndBody string, literalCount int32) {
        let source = "package P\nfunc M1() " + returnAndBody + "\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let function = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.True(function.Type!!.IsSlice)
        Assert.True(function.Type!!.ArrayElementType!!.IsTuple)
        let returnStatement = Assert.IsType[ReturnStatementSyntax](Assert.Single(function.Body!!.Statements))
        let literal = Assert.IsType[ArrayCreationExpressionSyntax](returnStatement.Expression)
        Assert.Equal(literalCount, literal.Elements!!.Count)
    }

    @Fact
    func NamedTupleJaggedSliceReturn_ArrowBody_ParsesAsTupleSliceReturn() {
        const source = "package P\n" +
            "func M1() [][](A int64, B string) -> [][](A int64, B string){[](A int64, B string){(A: 1, B: \"q\")}}\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let function = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.True(function.Type!!.IsSlice)
        Assert.True(function.Type!!.ArrayElementType!!.IsSlice)
        Assert.True(function.Type!!.ArrayElementType!!.ArrayElementType!!.IsTuple)
        Assert.Equal(2, function.Type!!.ArrayElementType!!.ArrayElementType!!.TupleElements!!.Count)
    }

    @Fact
    func NamedTupleSliceProperty_ArrowBody_ParsesAsPropertyBody() {
        const source = "package P\n" +
            "class C {\n" +
            "  prop Rows [](A int64, B string) -> [](A int64, B string){(A: 1, B: \"q\"), (A: 2, B: \"x\")}\n" +
            "}\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let property = tree.Root.Members.OfType[StructDeclarationSyntax]().Single().Properties.Single()
        Assert.True(property.Type!!.IsSlice)
        Assert.True(property.Type!!.ArrayElementType!!.IsTuple)
        Assert.False(property.Type!!.ArrayElementType!!.IsArrowFunction)
        Assert.Single(property.Accessors)
    }

    @Fact
    func NamedTupleSliceReturn_BlockBody_StillParses() {
        const source = "package P\n" +
            "func M1() [](A int64, B string) {\n" +
            "    return [](A int64, B string){(A: 1, B: \"q\"), (A: 2, B: \"x\")}\n" +
            "}\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let function = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.True(function.Type!!.ArrayElementType!!.IsTuple)
    }

    @Fact
    func NamedTupleSliceReturn_MissingArrowExpression_ReportsOnlyTheMissingExpression() {
        const source = "package P\nfunc M1() [](A int64, B string) ->\n"
        let tree = SyntaxTree.Parse(source)
        let diagnostic = Assert.Single(tree.Diagnostics)
        Assert.Equal("GS0005", diagnostic.Id)
        let function = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.True(function.Type!!.ArrayElementType!!.IsTuple)
    }

    @Fact
    func UnnamedTupleSliceReturn_BlockBodyAfterArrow_RemainsFunctionTypeSlice() {
        // Without element names the shape stays ambiguous and keeps its existing
        // meaning: a slice of function types followed by a block body.
        const source = "package P\nfunc M1() [](int64, string) -> int32 {\n    return nil\n}\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let function = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.True(function.Type!!.IsSlice)
        Assert.True(function.Type!!.ArrayElementType!!.IsArrowFunction)
    }

    @Theory
    @InlineData("(ref int32, in int32) -> int32")
    @InlineData("(out int32) -> void")
    @InlineData("((A int32, B int32), int32) -> int32")
    @InlineData("(...[]int32) -> int32")
    @InlineData("(chan[int32], in chan[int32]) -> int32")
    func ArrowFunctionTypeParameter_ModifiersAndNestedNamedTuples_RemainFunctionTypes(functionType string) {
        let source = "package P\nfunc Take(f " + functionType + ") {\n}\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let function = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.True(function.Parameters[0].Type!!.IsArrowFunction)
    }
}
