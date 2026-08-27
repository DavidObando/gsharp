// <copyright file="Issue1278ArrowExpressionMemberParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1278 / ADR-0131: parser coverage for expression-bodied members using
/// the G# lambda arrow <c>-&gt;</c> (never the C# fat arrow <c>=&gt;</c>). The
/// arrow form is accepted in member-declaration position for functions/methods,
/// read-only properties, indexers, property accessors, operators, and
/// conversion operators, and desugars to a synthesized block body so it reuses
/// the existing binding/emit paths. The fat arrow <c>=&gt;</c> remains a GS0005
/// syntax error.
/// </summary>
public class Issue1278ArrowExpressionMemberParserTests
{
    [Fact]
    public void FreeFunctionArrowBody_ParsesCleanly()
    {
        const string source = "package P\nfunc Square(x int32) int32 -> x * x\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var func = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.NotNull(func.Body);
    }

    [Fact]
    public void VoidFunctionArrowBody_ParsesCleanly()
    {
        const string source = "package P\nimport System\nfunc Shout(s string) -> Console.WriteLine(s)\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void MethodArrowBody_ParsesCleanly()
    {
        const string source = "package P\nclass C {\n  func Twice(x int32) int32 -> x + x\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void OperatorArrowBody_ParsesCleanly()
    {
        const string source = "package P\nstruct V {\n  var x int32\n}\nfunc (a V) operator +(b V) V -> V{x: a.x + b.x}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ConversionOperatorArrowBody_ParsesCleanly()
    {
        const string source = "package P\nstruct C {\n  var d int32\n}\nfunc operator implicit (c C) int32 -> c.d\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void Issue3375_TupleReturningArrowBody_ParsesAsTupleReturn()
    {
        const string source =
            "package P\n" +
            "class C {\n" +
            "  shared {\n" +
            "    private func Pair() (int32, int32) -> (1, 2)\n" +
            "  }\n" +
            "}\n";
        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var func = Walk(tree.Root).OfType<FunctionDeclarationSyntax>().Single();
        Assert.True(func.Type.IsTuple);
        Assert.Equal(2, func.Type.TupleElements.Count);
        var statement = Assert.Single(func.Body.Statements);
        var returnStatement = Assert.IsType<ReturnStatementSyntax>(statement);
        var tuple = Assert.IsType<TupleLiteralExpressionSyntax>(returnStatement.Expression);
        Assert.Equal(2, tuple.Elements.Count);
    }

    [Fact]
    public void Issue3375_TupleReturningArrowCallBody_ParsesAsTupleReturn()
    {
        const string source =
            "package P\n" +
            "func MakePair() (int32, int32) { return (1, 2) }\n" +
            "func Pair() (int32, int32) -> MakePair()\n";
        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var pair = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Last();
        Assert.True(pair.Type.IsTuple);
        Assert.IsType<CallExpressionSyntax>(
            Assert.IsType<ReturnStatementSyntax>(Assert.Single(pair.Body.Statements)).Expression);
    }

    [Fact]
    public void Issue3375_ArrowFunctionReturnWithArrowBody_RemainsFunctionType()
    {
        const string source =
            "package P\n" +
            "func Compare() (int32, int32) -> int32 -> (left int32, right int32) -> left - right\n";
        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var func = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.True(func.Type.IsArrowFunction);
        Assert.IsType<LambdaExpressionSyntax>(
            Assert.IsType<ReturnStatementSyntax>(Assert.Single(func.Body.Statements)).Expression);
    }

    [Fact]
    public void Issue3587_SliceOfTuplePropertyArrowBody_ParsesAsPropertyBody()
    {
        const string source =
            "package P\n" +
            "class C {\n" +
            "  prop Rows [](string, string) -> [](string, string){(\"a\", \"b\")}\n" +
            "}\n";
        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var property = tree.Root.Members.OfType<StructDeclarationSyntax>().Single().Properties.Single();
        Assert.True(property.Type.IsSlice);
        Assert.True(property.Type.ArrayElementType.IsTuple);
        Assert.False(property.Type.ArrayElementType.IsArrowFunction);
        Assert.Single(property.Accessors);
    }

    [Fact]
    public void Issue3587_TuplePropertyArrowBody_ParsesAsPropertyBody()
    {
        const string source =
            "package P\n" +
            "class C {\n" +
            "  prop Pair (int32, int32) -> (1, 2)\n" +
            "}\n";
        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var property = tree.Root.Members.OfType<StructDeclarationSyntax>().Single().Properties.Single();
        Assert.True(property.Type.IsTuple);
        Assert.Single(property.Accessors);
    }

    [Fact]
    public void Issue3587_SliceOfTupleFunctionArrowBody_ParsesAsFunctionBody()
    {
        const string source =
            "package P\n" +
            "func Rows() [](string, string) -> makeRows()\n";
        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var function = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.True(function.Type.IsSlice);
        Assert.True(function.Type.ArrayElementType.IsTuple);
        Assert.NotNull(function.Body);
    }

    [Fact]
    public void Issue3587_MissingPropertyArrowExpression_ReportsDiagnostic()
    {
        const string source =
            "package P\n" +
            "class C {\n" +
            "  prop Rows [](string, string) ->\n" +
            "}\n";
        var tree = SyntaxTree.Parse(source);

        Assert.Contains(tree.Diagnostics, diagnostic => diagnostic.Id == "GS0005");
    }

    [Fact]
    public void Issue3587_SliceOfFunctionPropertyWithAccessors_RemainsFunctionType()
    {
        const string source =
            "package P\n" +
            "class C {\n" +
            "  prop Handlers [](string, string) -> int32 { get }\n" +
            "}\n";
        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var property = tree.Root.Members.OfType<StructDeclarationSyntax>().Single().Properties.Single();
        Assert.True(property.Type.IsSlice);
        Assert.True(property.Type.ArrayElementType.IsArrowFunction);
        Assert.Single(property.Accessors);
    }

    [Theory]
    [InlineData("")]
    [InlineData("\n  prop Other int32")]
    public void Issue3587_BareFunctionTypedProperty_RemainsFunctionType(string followingMember)
    {
        var source =
            "package P\n" +
            "class C {\n" +
            "  prop Handler (int32, int32) -> int32" + followingMember + "\n" +
            "}\n";
        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var property = tree.Root.Members.OfType<StructDeclarationSyntax>().Single().Properties.First();
        Assert.True(property.Type.IsArrowFunction);
        Assert.Empty(property.Accessors);
    }

    [Fact]
    public void Issue3587_FunctionTypedPropertyWithAccessibleAccessor_RemainsFunctionType()
    {
        const string source =
            "package P\n" +
            "class C {\n" +
            "  prop Handler (int32, int32) -> int32 { private set; get; }\n" +
            "}\n";
        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var property = tree.Root.Members.OfType<StructDeclarationSyntax>().Single().Properties.Single();
        Assert.True(property.Type.IsArrowFunction);
        Assert.Equal(2, property.Accessors.Length);
    }

    [Fact]
    public void Issue3587_NullableNestedSliceTuplePropertyArrow_ParsesAsPropertyBody()
    {
        const string source =
            "package P\n" +
            "class C {\n" +
            "  prop Rows []?[](string, string) -> makeRows()\n" +
            "}\n";
        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var property = tree.Root.Members.OfType<StructDeclarationSyntax>().Single().Properties.Single();
        Assert.True(property.Type.IsArrayNullable);
        Assert.True(property.Type.ArrayElementType.IsSlice);
        Assert.True(property.Type.ArrayElementType.ArrayElementType.IsTuple);
        Assert.Single(property.Accessors);
    }

    [Fact]
    public void Issue3587_NullableNestedSliceTupleFunctionArrow_ParsesAsFunctionBody()
    {
        const string source =
            "package P\n" +
            "func Rows() []?[](string, string) -> makeRows()\n";
        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var function = tree.Root.Members.OfType<FunctionDeclarationSyntax>().Single();
        Assert.True(function.Type.IsArrayNullable);
        Assert.True(function.Type.ArrayElementType.IsSlice);
        Assert.True(function.Type.ArrayElementType.ArrayElementType.IsTuple);
        Assert.NotNull(function.Body);
    }

    [Fact]
    public void FunctionFatArrowBody_ReportsDiagnostic()
    {
        // Issue #1278: the C# fat arrow `=>` is not a G# member body form.
        const string source = "package P\nfunc Square(x int32) int32 => x * x\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Contains(tree.Diagnostics, d => d.Id == "GS0005");
    }

    [Fact]
    public void LambdaArrow_StillParsesInExpressionPosition()
    {
        // Issue #1278: the member-declaration arrow must not break arrow lambdas
        // in expression position.
        const string source = "package P\nfunc Main() {\n  var add = (x int32) -> x + 1\n}\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void ArrowCallBody_FollowedByReceiverFunc_ParsesCleanly()
    {
        // Issue #1294 regression: an expression-bodied arrow member whose body
        // is a call (`-> Q(b)`, ending in `)`) immediately followed by a
        // declaration that begins with a receiver clause (`func (b B) N()...`)
        // must terminate the arrow body before the next `func`. Previously the
        // trailing-lambda heuristic misread the following `func (b B)` receiver
        // clause as a `func(...)` literal attaching to the call, gobbling the
        // declaration and reporting GS0005.
        const string source =
            "package P\n" +
            "struct B { }\n" +
            "func Q(b B) int32 { return 1 }\n" +
            "func (b B) M() int32 -> Q(b)\n" +
            "func (b B) N() int32 { return 2 }\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var funcs = tree.Root.Members.OfType<FunctionDeclarationSyntax>().ToArray();
        Assert.Equal(3, funcs.Length);
        Assert.All(funcs, f => Assert.NotNull(f.Body));
    }

    [Fact]
    public void ArrowGenericCallBody_FollowedByReceiverGenericFunc_ParsesCleanly()
    {
        // Issue #1294: the real-world Oahu.Decrypt shape — an arrow body that is
        // a call returning a generic type, on a receiver method, followed by
        // another receiver method with a generic return type. The arrow body
        // must still terminate before the next `func (recv Type)`.
        const string source =
            "package P\n" +
            "struct ChunkEntry { }\n" +
            "struct TrakBox { }\n" +
            "func ChunkEntryList(t TrakBox) List[ChunkEntry] { return nil }\n" +
            "func (track TrakBox) ChunkEntries() List[ChunkEntry] -> ChunkEntryList(track)\n" +
            "func (track TrakBox) Other() List[ChunkEntry] -> ChunkEntryList(track)\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var funcs = tree.Root.Members.OfType<FunctionDeclarationSyntax>().ToArray();
        Assert.Equal(3, funcs.Length);
        Assert.All(funcs, f => Assert.NotNull(f.Body));
    }

    [Fact]
    public void ArrowCallBody_FollowedByGenericReceiverFunc_ParsesCleanly()
    {
        // Issue #1294 follow-up: when the declaration following an arrow call
        // body is a *generic* receiver method, its name is followed by a
        // type-parameter list (`Name[...]`) rather than a value-parameter list
        // (`Name(...)`). The trailing-lambda guard must recognise both shapes,
        // otherwise the following `func (recv) Name[...]` is gobbled as a
        // trailing lambda and reports GS0005. This is the exact Oahu.Decrypt
        // InterleavedIterator shape (an arrow receiver method directly before a
        // generic extension method with a constrained type parameter).
        const string source =
            "package P\n" +
            "struct B { }\n" +
            "func Q(b B) int32 { return 1 }\n" +
            "func (b B) M() int32 -> Q(b)\n" +
            "func (s B) N[T IComparable[T]](x T) int32 { return 2 }\n";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        var funcs = tree.Root.Members.OfType<FunctionDeclarationSyntax>().ToArray();
        Assert.Equal(3, funcs.Length);
        Assert.All(funcs, f => Assert.NotNull(f.Body));
    }

    [Fact]
    public void ArrowCallOperatorBody_FollowedByReceiverOperator_ParsesCleanly()
    {
        const string source =
            "package P\n" +
            "struct B { func Equals(other B) bool { return true } }\n" +
            "func (left B) operator ==(right B) bool -> left.Equals(right)\n" +
            "func (left B) operator !=(right B) bool -> !left.Equals(right)\n";

        var tree = SyntaxTree.Parse(source);

        Assert.Empty(tree.Diagnostics);
        var funcs = tree.Root.Members.OfType<FunctionDeclarationSyntax>().ToArray();
        Assert.Equal(2, funcs.Length);
        Assert.All(funcs, function => Assert.NotNull(function.Body));
    }

    private static IEnumerable<SyntaxNode> Walk(SyntaxNode node)
    {
        yield return node;
        foreach (var child in node.GetChildren())
        {
            if (child is not SyntaxNode syntaxNode)
            {
                continue;
            }

            foreach (var descendant in Walk(syntaxNode))
            {
                yield return descendant;
            }
        }
    }
}
