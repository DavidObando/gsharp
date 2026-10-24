// <copyright file="NativeSliceCompletionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System.Linq
import Xunit

class NativeSliceCompletionTests {
    @Fact
    func NativeTypeSnippetsRetainDistinctRepresentations() {
        const source = "func use(value ) { }\n"
        let items = CompletionComputer.ComputeCompletions(LanguageServerTestHelpers.Content(source), Position(0, 15))
        for label in[]string{
            "slice[T]",
            "readonly slice[T]",
            "array[T]",
            "managed[T]",
            "readonly managed[T]",
            "span[T]",
            "readonly span[T]"
        } {
            let item = Assert.Single(items, (item CompletionItem) -> item.Label == label)
            Assert.Contains("$${1:T}", item.InsertText)
        }
        Assert.DoesNotContain(items, (item CompletionItem) -> item.Label == "readonlySlice[T]")
        Assert.DoesNotContain(items, (item CompletionItem) -> item.Label == "readonlyManaged[T]")
    }

    @Fact
    func ManagedReferenceHoverUsesTheTwoTokenSpelling() {
        const source = "func Read(value readonly managed[string?]?) { }\n"
        let hover Hover? = HoverComputer.ComputeHover(
            LanguageServerTestHelpers.Content(source),
            LanguageServerTestHelpers.PositionOf(source, "Read")
        )
        Assert.NotNull(hover)
        Assert.Contains("readonly managed[string?]?", hover!!.Contents.ToString())
        Assert.DoesNotContain("readonlyManaged", hover!!.Contents.ToString())
    }
}
