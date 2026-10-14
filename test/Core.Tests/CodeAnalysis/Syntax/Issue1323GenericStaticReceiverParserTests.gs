// <copyright file="Issue1323GenericStaticReceiverParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #1323: a generic static member-access receiver
/// `Type[TypeArg].StaticMember(...)` must parse even when the single type
/// argument is unambiguously type-shaped — nullable (`T?`), array/slice
/// (`[]T`), or a nested generic (`List[T]`). The #942 trailing-`.`
/// rule formerly treated a single bracketed argument followed by `.` as an
/// indexer-then-member access, which only worked for a simple-name argument and
/// surfaced GS0005 for the type-shaped forms. The fix commits to a generic call
/// site for these (emitting a (cref:GenericNameExpressionSyntax)
/// receiver) while a single SIMPLE-name bracketed argument still parses as an
/// indexer-then-member access so genuine indexers are not regressed.
open class Issue1323GenericStaticReceiverParserTests {
    @Fact
    func NullableTypeArg_StaticCall_ParsesWithoutDiagnostics() {
        const source = `
package p
struct Box[T] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Box[int32?].Make(5) } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.IsType[GenericNameExpressionSyntax](GetReturnedAccessorReceiver(tree))
    }

    @Fact
    func ArrayTypeArg_StaticCall_ParsesWithoutDiagnostics() {
        const source = `
package p
struct Box[T] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Box[[]int32].Make(5) } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.IsType[GenericNameExpressionSyntax](GetReturnedAccessorReceiver(tree))
    }

    @Fact
    func NestedGenericTypeArg_StaticCall_ParsesWithoutDiagnostics() {
        const source = `
package p
import System.Collections.Generic
struct Box[T] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Box[List[int32]].Make(5) } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let receiver = Assert.IsType[GenericNameExpressionSyntax](GetReturnedAccessorReceiver(tree))
        Assert.Equal("Box", receiver.Identifier.Text)
        Assert.Single(receiver.TypeArgumentList.Arguments)
    }

    @Fact
    func ChannelEnclosingTypeArg_GenericConstruction_ParsesAtSourceSpan() {
        const source = `package p
class Box[T] {}
class Owner[T] { class Payload[U] {} }
func Reify[T]() {
    var value = Box[Owner[chan[T]].Payload[string]]()
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let channel = Descendants(tree.Root).OfType[TypeClauseSyntax]().Single(
            (type TypeClauseSyntax) -> type.IsChannel
        )
        Assert.Equal(4, channel.Location.StartLine)
        Assert.Equal(26, channel.Location.StartCharacter)
        Assert.Equal(4, channel.Location.EndLine)
        Assert.Equal(33, channel.Location.EndCharacter)
    }

    @Fact
    func ChannelTypeArg_StaticCall_ParsesAsGenericName() {
        const source = `package p
struct Box[T] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Box[chan[int32]].Make(5) } }`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.IsType[GenericNameExpressionSyntax](GetReturnedAccessorReceiver(tree))
        let channel = Descendants(tree.Root).OfType[TypeClauseSyntax]().Single(
            (type TypeClauseSyntax) -> type.IsChannel
        )
        Assert.Equal(2, channel.Location.StartLine)
        Assert.Equal(38, channel.Location.StartCharacter)
        Assert.Equal(2, channel.Location.EndLine)
        Assert.Equal(49, channel.Location.EndCharacter)
    }

    @Fact
    func MultiTypeArg_StaticCall_ParsesAsGenericName() {
        // A multi-type-argument list followed by `.` commits to a generic call
        // site (an indexer can never hold a comma-separated list).
        const source = `
package p
struct Pair[T, U] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Pair[int32, string].Make(5) } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let receiver = Assert.IsType[GenericNameExpressionSyntax](GetReturnedAccessorReceiver(tree))
        Assert.Equal(2, receiver.TypeArgumentList.Arguments.Count)
    }

    @Fact
    func TupleTypeArg_WithNullableArrayElement_ParsesAsGenericConstruction() {
        const source = `package p
import System.Collections.Generic
func F() {
    let values = List[(int32, []string, []?int32, bool)]()
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let call = Descendants(tree.Root).OfType[CallExpressionSyntax]().Single()
        let tuple = Assert.IsType[TypeClauseSyntax](Assert.Single(call.TypeArgumentList!!.Arguments))
        Assert.True(tuple.IsTuple)
        Assert.Equal(4, tuple.TupleElements!!.Count)
        Assert.True(tuple.TupleElements!![2].IsArrayNullable)
    }

    @Fact
    func SimpleTypeArg_StaticCall_StillParsesAsIndexerThenMember() {
        // Regression guard: a single SIMPLE-name bracketed argument followed by
        // `.` keeps the indexer-then-member parse path so genuine indexers
        // (`dict[key].Prop`) are not absorbed into a generic call site.
        const source = `
package p
struct Box[T] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Box[int32].Make(5) } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        Assert.IsType[IndexExpressionSyntax](GetReturnedAccessorReceiver(tree))
    }

    @Fact
    func Indexer_Then_Member_On_SingleIdentifierIndex_StillParsesAsIndexer() {
        // `dict[key].Prop`-style indexer-then-member access must remain an
        // IndexExpression receiver, not a generic name.
        const source = `
package p
import System.Collections.Generic
class C { func F(d Dictionary[string, int32], key string) int32 { return d[key].ToString().Length } }
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let all = Descendants(tree.Root).ToList()
        Assert.Contains(all, (n SyntaxNode) -> n is IndexExpressionSyntax)
        Assert.DoesNotContain(all, (n SyntaxNode) -> n is GenericNameExpressionSyntax)
    }

    shared {
        private func GetReturnedAccessorReceiver(tree SyntaxTree) ExpressionSyntax {
            // The constructed-generic receiver lives in `class C`'s `func F`, which
            // is declared after the generic struct (whose own `return x` body would
            // otherwise be selected first by a pre-order walk).
            let returnStmt = Descendants(tree.Root).OfType[ReturnStatementSyntax]().Last()
            let accessor = Assert.IsType[AccessorExpressionSyntax](returnStmt.Expression)
            return accessor.LeftPart
        }

        private func Descendants(node SyntaxNode) sequence[SyntaxNode] {
            for child in node.GetChildren() {
                yield child
                for d in Descendants(child) {
                    yield d
                }
            }
        }
    }
}
