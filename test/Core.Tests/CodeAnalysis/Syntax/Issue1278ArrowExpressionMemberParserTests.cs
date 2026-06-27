// <copyright file="Issue1278ArrowExpressionMemberParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
}
