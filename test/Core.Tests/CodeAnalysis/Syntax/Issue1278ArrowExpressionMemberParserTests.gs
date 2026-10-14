// <copyright file="Issue1278ArrowExpressionMemberParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #1278 / ADR-0131: parser coverage for expression-bodied members using
/// the G# lambda arrow `->` (never the C# fat arrow `=>`). The
/// arrow form is accepted in member-declaration position for functions/methods,
/// read-only properties, indexers, property accessors, operators, and
/// conversion operators, and desugars to a synthesized block body so it reuses
/// the existing binding/emit paths. The fat arrow `=>` remains a GS0005
/// syntax error.
open class Issue1278ArrowExpressionMemberParserTests {
    @Fact
    func FreeFunctionArrowBody_ParsesCleanly() {
        const source = `package P
func Square(x int32) int32 -> x * x
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let func_ = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.NotNull(func_.Body)
    }

    @Fact
    func VoidFunctionArrowBody_ParsesCleanly() {
        const source = `package P
import System
func Shout(s string) -> Console.WriteLine(s)
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func MethodArrowBody_ParsesCleanly() {
        const source = `package P
class C {
  func Twice(x int32) int32 -> x + x
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func OperatorArrowBody_ParsesCleanly() {
        const source = `package P
struct V {
  var x int32
}
func (a V) operator +(b V) V -> V{x: a.x + b.x}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ConversionOperatorArrowBody_ParsesCleanly() {
        const source = `package P
struct C {
  var d int32
}
func operator implicit (c C) int32 -> c.d
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func Issue3375_TupleReturningArrowBody_ParsesAsTupleReturn() {
        const source = "package P\n" +
            "class C {\n" +
            "  shared {\n" +
            "    private func Pair() (int32, int32) -> (1, 2)\n" +
            "  }\n" +
            "}\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let func_ = Walk(tree.Root).OfType[FunctionDeclarationSyntax]().Single()
        Assert.True(func_.Type!!.IsTuple)
        Assert.Equal(2, func_.Type!!.TupleElements!!.Count)
        let statement = Assert.Single(func_.Body!!.Statements)
        let returnStatement = Assert.IsType[ReturnStatementSyntax](statement)
        let tuple = Assert.IsType[TupleLiteralExpressionSyntax](returnStatement.Expression)
        Assert.Equal(2, tuple.Elements.Count)
    }

    @Fact
    func Issue3375_TupleReturningArrowCallBody_ParsesAsTupleReturn() {
        const source = "package P\n" +
            "func MakePair() (int32, int32) { return (1, 2) }\n" +
            "func Pair() (int32, int32) -> MakePair()\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let pair = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Last()
        Assert.True(pair.Type!!.IsTuple)
        Assert.IsType[CallExpressionSyntax](
            Assert.IsType[ReturnStatementSyntax](Assert.Single(pair.Body!!.Statements)).Expression
        )
    }

    @Fact
    func Issue3375_ArrowFunctionReturnWithArrowBody_RemainsFunctionType() {
        const source = "package P\n" +
            "func Compare() (int32, int32) -> int32 -> (left int32, right int32) -> left - right\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let func_ = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.True(func_.Type!!.IsArrowFunction)
        Assert.IsType[LambdaExpressionSyntax](
            Assert.IsType[ReturnStatementSyntax](Assert.Single(func_.Body!!.Statements)).Expression
        )
    }

    @Fact
    func Issue3587_SliceOfTuplePropertyArrowBody_ParsesAsPropertyBody() {
        const source = "package P\n" +
            "class C {\n" +
            "  prop Rows [](string, string) -> [](string, string){(\"a\", \"b\")}\n" +
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
    func Issue3587_TuplePropertyArrowBody_ParsesAsPropertyBody() {
        const source = "package P\n" + "class C {\n" + "  prop Pair (int32, int32) -> (1, 2)\n" + "}\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let property = tree.Root.Members.OfType[StructDeclarationSyntax]().Single().Properties.Single()
        Assert.True(property.Type!!.IsTuple)
        Assert.Single(property.Accessors)
    }

    @Fact
    func Issue3587_SliceOfTupleFunctionArrowBody_ParsesAsFunctionBody() {
        const source = "package P\n" + "func Rows() [](string, string) -> makeRows()\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let function = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.True(function.Type!!.IsSlice)
        Assert.True(function.Type!!.ArrayElementType!!.IsTuple)
        Assert.NotNull(function.Body)
    }

    @Fact
    func Issue3587_MissingPropertyArrowExpression_ReportsDiagnostic() {
        const source = "package P\n" + "class C {\n" + "  prop Rows [](string, string) ->\n" + "}\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Contains(tree.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0005")
    }

    @Fact
    func Issue3587_SliceOfFunctionPropertyWithAccessors_RemainsFunctionType() {
        const source = "package P\n" + "class C {\n" + "  prop Handlers [](string, string) -> int32 { get }\n" + "}\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let property = tree.Root.Members.OfType[StructDeclarationSyntax]().Single().Properties.Single()
        Assert.True(property.Type!!.IsSlice)
        Assert.True(property.Type!!.ArrayElementType!!.IsArrowFunction)
        Assert.Single(property.Accessors)
    }

    @Theory
    @InlineData("")
    @InlineData("\n  prop Other int32")
    func Issue3587_BareFunctionTypedProperty_RemainsFunctionType(followingMember string) {
        let source = "package P\n" +
            "class C {\n" +
            "  prop Handler (int32, int32) -> int32" +
            followingMember +
            "\n" +
            "}\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let property = tree.Root.Members.OfType[StructDeclarationSyntax]().Single().Properties.First()
        Assert.True(property.Type!!.IsArrowFunction)
        Assert.Empty(property.Accessors)
    }

    @Theory
    @InlineData("class Nested { }")
    @InlineData("struct Nested { }")
    @InlineData("interface Nested { }")
    @InlineData("enum Nested { A }")
    func Issue3587_FunctionTypedPropertyBeforeNestedAggregate_RemainsFunctionType(nestedType string) {
        let source = "package P\n" +
            "class C {\n" +
            "  prop Handler (int32, int32) -> int32\n" +
            "  " +
            nestedType +
            "\n" +
            "}\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let property = tree.Root.Members.OfType[StructDeclarationSyntax]().Single().Properties.Single()
        Assert.True(property.Type!!.IsArrowFunction)
        Assert.Empty(property.Accessors)
    }

    @Theory
    @InlineData("deinit { }")
    @InlineData("unsafe func M() { }")
    @InlineData("fixed data [8]int32")
    func Issue3587_FunctionTypedPropertyBeforeContextualMember_RemainsFunctionType(followingMember string) {
        let source = "package P\n" +
            "class C {\n" +
            "  prop Handler (int32, int32) -> int32\n" +
            "  " +
            followingMember +
            "\n" +
            "}\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let property = tree.Root.Members.OfType[StructDeclarationSyntax]().Single().Properties.Single()
        Assert.True(property.Type!!.IsArrowFunction)
        Assert.Empty(property.Accessors)
    }

    @Fact
    func Issue3587_FunctionTypedPropertyWithAccessibleAccessor_RemainsFunctionType() {
        const source = "package P\n" +
            "class C {\n" +
            "  prop Handler (int32, int32) -> int32 { private set; get; }\n" +
            "}\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let property = tree.Root.Members.OfType[StructDeclarationSyntax]().Single().Properties.Single()
        Assert.True(property.Type!!.IsArrowFunction)
        Assert.Equal(2, property.Accessors.Length)
    }

    @Fact
    func Issue3587_NullableNestedSliceTuplePropertyArrow_ParsesAsPropertyBody() {
        const source = "package P\n" + "class C {\n" + "  prop Rows []?[](string, string) -> makeRows()\n" + "}\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let property = tree.Root.Members.OfType[StructDeclarationSyntax]().Single().Properties.Single()
        Assert.True(property.Type!!.IsArrayNullable)
        Assert.True(property.Type!!.ArrayElementType!!.IsSlice)
        Assert.True(property.Type!!.ArrayElementType!!.ArrayElementType!!.IsTuple)
        Assert.Single(property.Accessors)
    }

    @Fact
    func Issue3587_NullableNestedSliceTupleFunctionArrow_ParsesAsFunctionBody() {
        const source = "package P\n" + "func Rows() []?[](string, string) -> makeRows()\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let function = tree.Root.Members.OfType[FunctionDeclarationSyntax]().Single()
        Assert.True(function.Type!!.IsArrayNullable)
        Assert.True(function.Type!!.ArrayElementType!!.IsSlice)
        Assert.True(function.Type!!.ArrayElementType!!.ArrayElementType!!.IsTuple)
        Assert.NotNull(function.Body)
    }

    @Fact
    func FunctionFatArrowBody_ReportsDiagnostic() {
        // Issue #1278: the C# fat arrow `=>` is not a G# member body form.
        const source = `package P
func Square(x int32) int32 => x * x
`
        let tree = SyntaxTree.Parse(source)
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0005")
    }

    @Fact
    func LambdaArrow_StillParsesInExpressionPosition() {
        // Issue #1278: the member-declaration arrow must not break arrow lambdas
        // in expression position.
        const source = `package P
func Main() {
  var add = (x int32) -> x + 1
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func ArrowCallBody_FollowedByReceiverFunc_ParsesCleanly() {
        // Issue #1294 regression: an expression-bodied arrow member whose body
        // is a call (`-> Q(b)`, ending in `)`) immediately followed by a
        // declaration that begins with a receiver clause (`func (b B) N()...`)
        // must terminate the arrow body before the next `func`. Previously the
        // trailing-lambda heuristic misread the following `func (b B)` receiver
        // clause as a `func(...)` literal attaching to the call, gobbling the
        // declaration and reporting GS0005.
        const source = "package P\n" +
            "struct B { }\n" +
            "func Q(b B) int32 { return 1 }\n" +
            "func (b B) M() int32 -> Q(b)\n" +
            "func (b B) N() int32 { return 2 }\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let funcs = tree.Root.Members.OfType[FunctionDeclarationSyntax]().ToArray()
        Assert.Equal(3, funcs.Length)
        Assert.All(funcs, (f FunctionDeclarationSyntax) -> Assert.NotNull(f.Body))
    }

    @Fact
    func ArrowGenericCallBody_FollowedByReceiverGenericFunc_ParsesCleanly() {
        // Issue #1294: the real-world Oahu.Decrypt shape — an arrow body that is
        // a call returning a generic type, on a receiver method, followed by
        // another receiver method with a generic return type. The arrow body
        // must still terminate before the next `func (recv Type)`.
        const source = "package P\n" +
            "struct ChunkEntry { }\n" +
            "struct TrakBox { }\n" +
            "func ChunkEntryList(t TrakBox) List[ChunkEntry] { return nil }\n" +
            "func (track TrakBox) ChunkEntries() List[ChunkEntry] -> ChunkEntryList(track)\n" +
            "func (track TrakBox) Other() List[ChunkEntry] -> ChunkEntryList(track)\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let funcs = tree.Root.Members.OfType[FunctionDeclarationSyntax]().ToArray()
        Assert.Equal(3, funcs.Length)
        Assert.All(funcs, (f FunctionDeclarationSyntax) -> Assert.NotNull(f.Body))
    }

    @Fact
    func ArrowCallBody_FollowedByGenericReceiverFunc_ParsesCleanly() {
        // Issue #1294 follow-up: when the declaration following an arrow call
        // body is a *generic* receiver method, its name is followed by a
        // type-parameter list (`Name[...]`) rather than a value-parameter list
        // (`Name(...)`). The trailing-lambda guard must recognise both shapes,
        // otherwise the following `func (recv) Name[...]` is gobbled as a
        // trailing lambda and reports GS0005. This is the exact Oahu.Decrypt
        // InterleavedIterator shape (an arrow receiver method directly before a
        // generic extension method with a constrained type parameter).
        const source = "package P\n" +
            "struct B { }\n" +
            "func Q(b B) int32 { return 1 }\n" +
            "func (b B) M() int32 -> Q(b)\n" +
            "func (s B) N[T IComparable[T]](x T) int32 { return 2 }\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let funcs = tree.Root.Members.OfType[FunctionDeclarationSyntax]().ToArray()
        Assert.Equal(3, funcs.Length)
        Assert.All(funcs, (f FunctionDeclarationSyntax) -> Assert.NotNull(f.Body))
    }

    @Fact
    func ArrowCallOperatorBody_FollowedByReceiverOperator_ParsesCleanly() {
        const source = "package P\n" +
            "struct B { func Equals(other B) bool { return true } }\n" +
            "func (left B) operator ==(right B) bool -> left.Equals(right)\n" +
            "func (left B) operator !=(right B) bool -> !left.Equals(right)\n"
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let funcs = tree.Root.Members.OfType[FunctionDeclarationSyntax]().ToArray()
        Assert.Equal(2, funcs.Length)
        Assert.All(funcs, (function FunctionDeclarationSyntax) -> Assert.NotNull(function.Body))
    }

    shared {
        private func Walk(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for child in node.GetChildren() {
                if child is not SyntaxNode syntaxNode {
                    continue
                }
                for descendant in Walk(syntaxNode) {
                    yield descendant
                }
            }
        }
    }
}
