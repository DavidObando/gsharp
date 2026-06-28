// <copyright file="Issue1323GenericStaticReceiverParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1323: a generic static member-access receiver
/// <c>Type[TypeArg].StaticMember(...)</c> must parse even when the single type
/// argument is unambiguously type-shaped — nullable (<c>T?</c>), array/slice
/// (<c>[]T</c>), or a nested generic (<c>List[T]</c>). The #942 trailing-`.`
/// rule formerly treated a single bracketed argument followed by <c>.</c> as an
/// indexer-then-member access, which only worked for a simple-name argument and
/// surfaced GS0005 for the type-shaped forms. The fix commits to a generic call
/// site for these (emitting a <see cref="GenericNameExpressionSyntax"/>
/// receiver) while a single SIMPLE-name bracketed argument still parses as an
/// indexer-then-member access so genuine indexers are not regressed.
/// </summary>
public class Issue1323GenericStaticReceiverParserTests
{
    [Fact]
    public void NullableTypeArg_StaticCall_ParsesWithoutDiagnostics()
    {
        const string source = @"
package p
struct Box[T] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Box[int32?].Make(5) } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        Assert.IsType<GenericNameExpressionSyntax>(GetReturnedAccessorReceiver(tree));
    }

    [Fact]
    public void ArrayTypeArg_StaticCall_ParsesWithoutDiagnostics()
    {
        const string source = @"
package p
struct Box[T] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Box[[]int32].Make(5) } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        Assert.IsType<GenericNameExpressionSyntax>(GetReturnedAccessorReceiver(tree));
    }

    [Fact]
    public void NestedGenericTypeArg_StaticCall_ParsesWithoutDiagnostics()
    {
        const string source = @"
package p
import System.Collections.Generic
struct Box[T] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Box[List[int32]].Make(5) } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var receiver = Assert.IsType<GenericNameExpressionSyntax>(GetReturnedAccessorReceiver(tree));
        Assert.Equal("Box", receiver.Identifier.Text);
        Assert.Single(receiver.TypeArgumentList.Arguments);
    }

    [Fact]
    public void MultiTypeArg_StaticCall_ParsesAsGenericName()
    {
        // A multi-type-argument list followed by `.` commits to a generic call
        // site (an indexer can never hold a comma-separated list).
        const string source = @"
package p
struct Pair[T, U] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Pair[int32, string].Make(5) } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var receiver = Assert.IsType<GenericNameExpressionSyntax>(GetReturnedAccessorReceiver(tree));
        Assert.Equal(2, receiver.TypeArgumentList.Arguments.Count);
    }

    [Fact]
    public void SimpleTypeArg_StaticCall_StillParsesAsIndexerThenMember()
    {
        // Regression guard: a single SIMPLE-name bracketed argument followed by
        // `.` keeps the indexer-then-member parse path so genuine indexers
        // (`dict[key].Prop`) are not absorbed into a generic call site.
        const string source = @"
package p
struct Box[T] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Box[int32].Make(5) } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);
        Assert.IsType<IndexExpressionSyntax>(GetReturnedAccessorReceiver(tree));
    }

    [Fact]
    public void Indexer_Then_Member_On_SingleIdentifierIndex_StillParsesAsIndexer()
    {
        // `dict[key].Prop`-style indexer-then-member access must remain an
        // IndexExpression receiver, not a generic name.
        const string source = @"
package p
import System.Collections.Generic
class C { func F(d Dictionary[string, int32], key string) int32 { return d[key].ToString().Length } }
";
        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var all = Descendants(tree.Root).ToList();
        Assert.Contains(all, n => n is IndexExpressionSyntax);
        Assert.DoesNotContain(all, n => n is GenericNameExpressionSyntax);
    }

    private static ExpressionSyntax GetReturnedAccessorReceiver(SyntaxTree tree)
    {
        // The constructed-generic receiver lives in `class C`'s `func F`, which
        // is declared after the generic struct (whose own `return x` body would
        // otherwise be selected first by a pre-order walk).
        var returnStmt = Descendants(tree.Root)
            .OfType<ReturnStatementSyntax>()
            .Last();
        var accessor = Assert.IsType<AccessorExpressionSyntax>(returnStmt.Expression);
        return accessor.LeftPart;
    }

    private static System.Collections.Generic.IEnumerable<SyntaxNode> Descendants(SyntaxNode node)
    {
        foreach (var child in node.GetChildren())
        {
            yield return child;
            foreach (var d in Descendants(child))
            {
                yield return d;
            }
        }
    }
}
