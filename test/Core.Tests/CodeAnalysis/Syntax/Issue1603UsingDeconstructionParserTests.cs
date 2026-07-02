// <copyright file="Issue1603UsingDeconstructionParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1603: <c>using let (a, b) = …</c> (tuple deconstruction) and
/// <c>using let { … } = …</c> (named deconstruction) are not a single
/// variable declaration, so <c>using</c> cannot wrap them. Parsing must
/// report <c>GS0417</c> and recover instead of throwing an
/// <see cref="System.InvalidCastException"/> from the previous unconditional
/// cast to <see cref="VariableDeclarationSyntax"/>. Same for
/// <c>await using</c>.
/// </summary>
public class Issue1603UsingDeconstructionParserTests
{
    [Fact]
    public void Using_TupleDeconstruction_Reports_GS0417_Instead_Of_Throwing()
    {
        const string source = @"
package p
class C { func F() { using let (a, b) = G() } func G() (int32, int32) { return (1, 2) } }
";
        var tree = SyntaxTree.Parse(source);

        Assert.Contains(tree.Diagnostics, d => d.Id == "GS0417");
    }

    [Fact]
    public void AwaitUsing_TupleDeconstruction_Reports_GS0417_Instead_Of_Throwing()
    {
        const string source = @"
package p
class C { async func F() { await using let (a, b) = G() } func G() (int32, int32) { return (1, 2) } }
";
        var tree = SyntaxTree.Parse(source);

        Assert.Contains(tree.Diagnostics, d => d.Id == "GS0417");
    }

    [Fact]
    public void Using_NamedDeconstruction_Reports_GS0417_Instead_Of_Throwing()
    {
        const string source = @"
package p
data struct Pt { let X int32 let Y int32 }
class C { func F(p Pt) { using let { X, Y } = p } }
";
        var tree = SyntaxTree.Parse(source);

        Assert.Contains(tree.Diagnostics, d => d.Id == "GS0417");
    }

    [Fact]
    public void Using_SingleVariableDeclaration_Still_Parses_Without_GS0417()
    {
        const string source = @"
package p
class C { func F() { using let a = G() } func G() int32 { return 1 } }
";
        var tree = SyntaxTree.Parse(source);

        Assert.DoesNotContain(tree.Diagnostics, d => d.Id == "GS0417");
    }
}
