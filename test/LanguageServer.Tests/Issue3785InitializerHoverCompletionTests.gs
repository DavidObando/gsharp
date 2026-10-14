// <copyright file="Issue3785InitializerHoverCompletionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import Xunit

class Issue3785InitializerHoverCompletionTests {
    @Theory
    @InlineData("List[int32](4)", "import System.Collections.Generic\n")
    @InlineData("System.Collections.Generic.List[int32](4)", "")
    func Hover_ExplicitClrMember_UsesConstructedReceiver(target string, imports string) {
        let source = imports + "func Main() {\nlet xs = " + target + "{ 1, .Capacity: 8 }\n}"
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Capacity"))
        Assert.NotNull(hover)
        Assert.Contains("Capacity", hover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.Contains("List", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Hover_ExplicitSourceMember_UsesConstructedReceiver() {
        const source = `class Box {
    prop Width int32
    init(value int32) { Width = value }
}
let box = Box(1){ .Width: 2 }`
        let hover Hover? = HoverComputer.ComputeHover(
            LanguageServerTestHelpers.Content(source),
            LanguageServerTestHelpers.PositionOf(source, "Width", occurrence: 2)
        )
        Assert.NotNull(hover)
        Assert.Contains("Width", hover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.Contains("int32", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Theory
    @InlineData(".")
    @InlineData(".Cap")
    @InlineData(".Capacity")
    func Completion_IncompleteExplicitMember_OffersReceiverMembers(entry string) {
        let source = "func Main() {\nlet xs = System.Collections.Generic.List[int32](4){ 1, " + entry + " }\n}"
        let prefix = "{ 1, " + entry
        let start = LanguageServerTestHelpers.PositionOf(source, prefix)
        let caret = Position(start.Line, start.Character + prefix.Length)
        let items = CompletionComputer.ComputeCompletions(LanguageServerTestHelpers.Content(source), caret)
        Assert.Contains(
            items,
            (item CompletionItem) -> item.Label == "Capacity" && item.Kind == CompletionItemKind.Property
        )
        Assert.DoesNotContain(
            items,
            (item CompletionItem) -> item.Label == "let" && item.Kind == CompletionItemKind.Keyword
        )
    }

    @Fact
    func Completion_SourceMember_OffersProperties() {
        const source = "class Box { prop Width int32 }\nlet box = Box(){ .Wi }"
        let start = LanguageServerTestHelpers.PositionOf(source, ".Wi")
        let items = CompletionComputer.ComputeCompletions(
            LanguageServerTestHelpers.Content(source),
            Position(start.Line, start.Character + 3)
        )
        Assert.Contains(
            items,
            (item CompletionItem) -> item.Label == "Width" && item.Kind == CompletionItemKind.Property
        )
    }

    @Fact
    func Completion_ExplicitMemberValue_KeepsExpressionContext() {
        const source = "import System.Collections.Generic\nlet xs = List[int32](){ .Capacity:  }"
        let start = LanguageServerTestHelpers.PositionOf(source, ".Capacity: ")
        let items = CompletionComputer.ComputeCompletions(
            LanguageServerTestHelpers.Content(source),
            Position(start.Line, start.Character + ".Capacity: ".Length)
        )
        Assert.Contains(items, (item CompletionItem) -> item.Label == "true" && item.Kind == CompletionItemKind.Keyword)
        Assert.DoesNotContain(
            items,
            (item CompletionItem) -> item.Label == "Capacity" && item.Kind == CompletionItemKind.Property
        )
    }

    @Fact
    func Hover_UnmarkedKey_IsAVariableNotAReceiverMember() {
        const source = `import System.Collections.Generic
let Capacity = "key"
let xs = SortedList[string, int32](){ ...[]KeyValuePair[string, int32]{}, Capacity: 2 }`
        let hover Hover? = HoverComputer.ComputeHover(
            LanguageServerTestHelpers.Content(source),
            LanguageServerTestHelpers.PositionOf(source, "Capacity", occurrence: 1)
        )
        Assert.NotNull(hover)
        Assert.Contains("string", hover!!.Contents.ToString(), StringComparison.Ordinal)
        Assert.DoesNotContain("SortedList", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Completion_NestedMemberCollection_UsesMemberType() {
        const source = `import System.Collections.Generic
class Owner { public let Children List[int32] = List[int32]() }
let owner = Owner(){ .Children: { .Cap } }`
        let start = LanguageServerTestHelpers.PositionOf(source, ".Cap")
        let items = CompletionComputer.ComputeCompletions(
            LanguageServerTestHelpers.Content(source),
            Position(start.Line, start.Character + 4)
        )
        Assert.Contains(
            items,
            (item CompletionItem) -> item.Label == "Capacity" && item.Kind == CompletionItemKind.Property
        )
    }

    @Fact
    func Hover_GenericSourceMember_UsesClosedType() {
        const source = `class Box[T any] {
    public var Value T
    init(value T) { Value = value }
}
let box = Box[int32](1){ .Value: 2 }`
        let start = LanguageServerTestHelpers.PositionOf(source, ".Value")
        let hover Hover? = HoverComputer.ComputeHover(
            LanguageServerTestHelpers.Content(source),
            Position(start.Line, start.Character + 1)
        )
        Assert.NotNull(hover)
        Assert.Contains("int32", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }
}
