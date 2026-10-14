// <copyright file="CompletionHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Linq
import System.Threading
import Xunit

open class CompletionHandlerTests {
    @Fact
    func ComputeCompletions_HonorsCancellation() {
        // Issue #1662: ComputeCompletions accepted a CancellationToken but never observed it,
        // so a superseded completion request (fast typing) ran the whole global-scope walk to
        // completion. An already-cancelled token must now short-circuit instead of returning a
        // result.
        const source = `func add(a int32, b int32) int32 { return a + b }
var x = 1
`
        let content = LanguageServerTestHelpers.Content(source)
        using let cts = CancellationTokenSource()
        cts.Cancel()
        Assert.Throws[OperationCanceledException](
            func () object? {
                return CompletionComputer.ComputeCompletions(content, Position(2, 0), cts.Token)
            }
        )
    }

    @Fact
    func ComputeCompletions_IncludesKeywords() {
        const source = "let x = 42\n"
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, Position(0, 0))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "let" && i.Kind == CompletionItemKind.Keyword)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "func" && i.Kind == CompletionItemKind.Keyword)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "if" && i.Kind == CompletionItemKind.Keyword)
    }

    @Fact
    func ComputeCompletions_IncludesGlobalVariables() {
        const source = "let answer = 42\n"
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, Position(0, 0))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "answer" && i.Kind == CompletionItemKind.Variable)
    }

    @Fact
    func ComputeCompletions_IncludesFunctions() {
        const source = "func greet() { }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, Position(0, 0))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "greet" && i.Kind == CompletionItemKind.Function)
    }

    @Fact
    func ComputeCompletions_IncludesPrimitiveTypes() {
        const source = "let x = 1\n"
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, Position(0, 0))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "int32")
        Assert.Contains(items, (i CompletionItem) -> i.Label == "string")
        Assert.Contains(items, (i CompletionItem) -> i.Label == "bool")
    }

    @Fact
    func ComputeCompletions_IncludesParametersInsideFunction() {
        const source = "func add(a int32, b int32) int32 { return a + b }\n"
        let content = LanguageServerTestHelpers.Content(source)
        // Position inside the function body
        let items = CompletionComputer.ComputeCompletions(
            content,
            LanguageServerTestHelpers.PositionOf(source, "return")
        )
        Assert.Contains(items, (i CompletionItem) -> i.Label == "a" && i.Kind == CompletionItemKind.Variable)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "b" && i.Kind == CompletionItemKind.Variable)
    }

    @Fact
    func ComputeCompletions_IncludesStructTypes() {
        const source = `struct Point {
var X int32
var Y int32
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, Position(0, 0))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Point" && i.Kind == CompletionItemKind.Struct)
    }

    @Fact
    func ComputeCompletions_AfterDotOnInt32_OffersClrInstanceMembers() {
        const source = `var x int32 = 42
x.
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, After(source, "x."))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "ToString" && i.Kind == CompletionItemKind.Method)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "CompareTo" && i.Kind == CompletionItemKind.Method)
        // Member context must suppress the keyword / global soup.
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Kind == CompletionItemKind.Keyword)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Label == "int32")
    }

    @Fact
    func ComputeCompletions_AfterDotOnNamedTuple_OffersElementNamesAndItemN() {
        // ADR-0172: a named-tuple receiver offers its declared element names
        // plus the positional ItemN spellings, and suppresses the global soup.
        const source = `let pos (line int32, column int32) = (3, 5)
pos.
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, After(source, "pos."))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "line" && i.Kind == CompletionItemKind.Field)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "column" && i.Kind == CompletionItemKind.Field)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Item1" && i.Kind == CompletionItemKind.Field)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Item2" && i.Kind == CompletionItemKind.Field)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Kind == CompletionItemKind.Keyword)
    }

    @Fact
    func ComputeCompletions_AfterDotOnUnnamedTuple_OffersItemN() {
        const source = `let pair = (1, "x")
pair.
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, After(source, "pair."))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Item1" && i.Kind == CompletionItemKind.Field)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Item2" && i.Kind == CompletionItemKind.Field)
    }

    @Fact
    func ComputeCompletions_AfterDotOnConsole_OffersStaticMembers() {
        const source = `import System
func main() {
Console.
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, After(source, "Console."))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "WriteLine" && i.Kind == CompletionItemKind.Method)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "ReadLine" && i.Kind == CompletionItemKind.Method)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Kind == CompletionItemKind.Keyword)
    }

    @Fact
    func ComputeCompletions_AfterDotOnStructValue_OffersInstanceFields() {
        const source = `struct Point {
var X int32
var Y int32
}
func use(p Point) {
p.
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, After(source, "p."))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "X" && i.Kind == CompletionItemKind.Field)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Y" && i.Kind == CompletionItemKind.Field)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Kind == CompletionItemKind.Keyword)
    }

    @Fact
    func ComputeCompletions_AfterDotOnImplicitThisProperty_OffersMemberTypeMembers() {
        // `Item.` where Item is a property of the enclosing class (implicit-this access).
        // Previously the receiver switch had no PropertySymbol case, so this returned nothing.
        const source = `class Inner {
    prop Value int32
}
class Outer {
    prop Item Inner
    func F() {
        Item.
    }
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, After(source, "Item."))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Value")
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Kind == CompletionItemKind.Keyword)
    }

    @Fact
    func ComputeCompletions_AfterDotOnImplicitThisField_OffersMemberTypeMembers() {
        // `item.` where item is a field of the enclosing class (implicit-this access).
        const source = `class Inner {
    prop Value int32
}
class Outer {
    var item Inner
    func F() {
        item.
    }
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, After(source, "item."))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Value")
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Kind == CompletionItemKind.Keyword)
    }

    @Fact
    func ComputeCompletions_AfterDotOnImplicitThisPropertyOfPrimitiveType_OffersClrMembers() {
        // Matches the reported case: a property of a primitive type accessed via implicit this.
        const source = `class Rect {
    prop Width int32
    func Area() {
        Width.
    }
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, After(source, "Width."))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "ToString" && i.Kind == CompletionItemKind.Method)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Kind == CompletionItemKind.Keyword)
    }

    @Fact
    func ComputeCompletions_AfterDotOnEnumType_OffersEnumMembers() {
        const source = `enum Color { Red, Green, Blue }
func use() {
Color.
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, After(source, "Color."))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Red" && i.Kind == CompletionItemKind.EnumMember)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Green" && i.Kind == CompletionItemKind.EnumMember)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Blue" && i.Kind == CompletionItemKind.EnumMember)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Kind == CompletionItemKind.Keyword)
    }

    @Fact
    func ComputeCompletions_AfterDotOnParenthesizedExpression_OffersInstanceMembers() {
        const source = `var a int32 = 3
var b int32 = 4
(a + b).
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, After(source, "(a + b)."))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "ToString" && i.Kind == CompletionItemKind.Method)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "CompareTo" && i.Kind == CompletionItemKind.Method)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Kind == CompletionItemKind.Keyword)
    }

    @Fact
    func ComputeCompletions_AfterDotOnUserInterfaceExtendingImportedInterface_OffersInheritedClrMembers() {
        // Issue #1181: a user interface extending a BCL interface must surface
        // the imported base interface's members (and the user-declared members)
        // on an interface-typed receiver — consistent with the binder.
        const source = `package p
import System
interface IBox : IDisposable { prop N int32 }
func use(b IBox) {
b.
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, After(source, "b."))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "Dispose" && i.Kind == CompletionItemKind.Method)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "N" && i.Kind == CompletionItemKind.Property)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Kind == CompletionItemKind.Keyword)
    }

    @Fact
    func ComputeCompletions_AfterDotOnParenthesizedExpression_InsideFunction_UsesParameters() {
        const source = `func add(a int32, b int32) {
(a + b).
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, After(source, "(a + b)."))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "ToString" && i.Kind == CompletionItemKind.Method)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Kind == CompletionItemKind.Keyword)
    }

    @Fact
    func ComputeCompletions_AfterDotOnCallExpression_OffersReturnTypeMembers() {
        const source = `func foo() int32 { return 1 }
func use() {
foo().
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, After(source, "foo()."))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "ToString" && i.Kind == CompletionItemKind.Method)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Kind == CompletionItemKind.Keyword)
    }

    @Fact
    func ComputeCompletions_AfterDotOnIndexExpression_OffersElementMembers() {
        const source = `var arr [3]int32 = [3]int32{1, 2, 3}
arr[0].
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, After(source, "arr[0]."))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "ToString" && i.Kind == CompletionItemKind.Method)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Kind == CompletionItemKind.Keyword)
    }

    @Fact
    func ComputeCompletions_AfterChainedMemberAccess_OffersMembers() {
        const source = `struct Point {
var X int32
var Y int32
}
func use(p Point) {
p.X.
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, After(source, "p.X."))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "ToString" && i.Kind == CompletionItemKind.Method)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Kind == CompletionItemKind.Keyword)
    }

    @Fact
    func ComputeCompletions_AfterDotOnUnresolvableReceiver_ReturnsNoMembersAndNoKeywords() {
        const source = `func use() {
(nope + 1).
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, After(source, "(nope + 1)."))
        // Inference fails for the undefined receiver, but the member-access context
        // must still suppress the keyword/global list.
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Kind == CompletionItemKind.Keyword)
        Assert.Empty(items)
    }

    @Fact
    func ComputeCompletions_WhileTypingBareIdentifier_OffersGlobalCandidates() {
        // Issue #917: completion-as-you-type. The caret sits in a partial identifier
        // (`ans`) with no leading dot; the global list must still be offered so the
        // editor can filter it down to the matching symbol.
        const source = `let answer = 42
ans
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, After(source, "ans"))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "answer" && i.Kind == CompletionItemKind.Variable)
        Assert.Contains(items, (i CompletionItem) -> i.Label == "let" && i.Kind == CompletionItemKind.Keyword)
    }

    @Fact
    func ComputeCompletions_WhileTypingBareIdentifier_SetsReplacementRangeOverPrefix() {
        // Issue #917: each plain candidate must carry an explicit replacement range
        // spanning the typed prefix so the editor replaces `ans` rather than inserting
        // alongside it.
        const source = `let answer = 42
ans
`
        let content = LanguageServerTestHelpers.Content(source)
        let caret = After(source, "ans")
        let items = CompletionComputer.ComputeCompletions(content, caret)
        let answer = Assert.Single(items, (i CompletionItem) -> i.Label == "answer")
        Assert.NotNull(answer.TextEdit)
        Assert.Equal("answer", answer.TextEdit.NewText)
        // The prefix `ans` starts at column 0 on line 1 and ends at the caret.
        let prefixStart = LanguageServerTestHelpers.PositionOf(source, "ans")
        Assert.Equal(prefixStart.Line, answer.TextEdit.Range.Start.Line)
        Assert.Equal(prefixStart.Character, answer.TextEdit.Range.Start.Character)
        Assert.Equal(caret.Line, answer.TextEdit.Range.End.Line)
        Assert.Equal(caret.Character, answer.TextEdit.Range.End.Character)
    }

    @Fact
    func ComputeCompletions_AtTokenStartWithoutPrefix_LeavesItemsRangeless() {
        // With no identifier prefix at the caret (a fresh position), the server leaves
        // the replacement range unset so the editor applies its own word-range heuristics.
        const source = "let answer = 42\n"
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, Position(0, 0))
        let keyword = Assert.Single(items, (i CompletionItem) -> i.Label == "let")
        Assert.Null(keyword.TextEdit)
    }

    @Fact
    func ComputeCompletions_WhileTypingPartialMemberAfterDot_OffersMembersAndRange() {
        // Issue #917: `x.To<caret>` — partial member name after a dot. Member completion
        // must still resolve the receiver's members (no keyword soup) and anchor the
        // replacement range to the partial member text being typed.
        const source = `var x int32 = 42
x.To
`
        let content = LanguageServerTestHelpers.Content(source)
        let caret = After(source, "x.To")
        let items = CompletionComputer.ComputeCompletions(content, caret)
        let toString = Assert.Single(items, (i CompletionItem) -> i.Label == "ToString")
        Assert.Equal(CompletionItemKind.Method, toString.Kind)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Kind == CompletionItemKind.Keyword)
        Assert.NotNull(toString.TextEdit)
        let prefixStart = LanguageServerTestHelpers.PositionOf(source, "To", 0)
        Assert.Equal(prefixStart.Line, toString.TextEdit.Range.Start.Line)
        Assert.Equal(prefixStart.Character, toString.TextEdit.Range.Start.Character)
        Assert.Equal(caret.Character, toString.TextEdit.Range.End.Character)
    }

    @Fact
    func ComputeCompletions_KeywordNamedMember_OffersEscapedSpelling() {
        // ADR-0170 / issue #3610: a member whose CLR name is a G# reserved
        // spelling completes as `$name` so the inserted text parses.
        const source = `class Bag {
func $defer() int32 {
return 1
}
}
var b = Bag{}
b.
`
        let content = LanguageServerTestHelpers.Content(source)
        let items = CompletionComputer.ComputeCompletions(content, After(source, "b."))
        Assert.Contains(items, (i CompletionItem) -> i.Label == "$$defer" && i.Kind == CompletionItemKind.Method)
        Assert.DoesNotContain(items, (i CompletionItem) -> i.Label == "defer")
    }

    shared {
        private func After(source string, marker string) Position {
            let start = LanguageServerTestHelpers.PositionOf(source, marker)
            return Position(start.Line, start.Character + marker.Length)
        }
    }
}
