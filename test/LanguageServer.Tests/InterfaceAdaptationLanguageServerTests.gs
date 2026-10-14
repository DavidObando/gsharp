// <copyright file="InterfaceAdaptationLanguageServerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import Xunit

class InterfaceAdaptationLanguageServerTests {
    @Fact
    func AdaptHoverAndCompletionUseTheTargetInterface() {
        const source = `interface Reader { func Read() int32; }
class Source { func Read() int32 -> 42 }
func main() {
    let adapted = adapt[Reader](Source())
    adapted.
}`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "adapted"))
        Assert.NotNull(hover)
        Assert.Contains("Reader", hover!!.Contents.ToString(), StringComparison.Ordinal)
        let dot = LanguageServerTestHelpers.PositionOf(source, "adapted.", occurrence: 0)
        let items = CompletionComputer.ComputeCompletions(
            content,
            Position(dot.Line, dot.Character + "adapted.".Length)
        )
        Assert.Contains(items, (item CompletionItem) -> item.Label == "Read" && item.Kind == CompletionItemKind.Method)
    }

    @Fact
    func InferredRichFieldAppearsAsItsExactType() {
        const source = `interface Reader { func Read() int32; }
func main() {
    let value = 42
    let rich = object : Reader {
        let Snapshot = value
        func Read() int32 -> value
    }
    let observed = rich.Snapshot
}`
        let content = LanguageServerTestHelpers.Content(source)
        let hover Hover? = HoverComputer.ComputeHover(
            content,
            LanguageServerTestHelpers.PositionOf(source, "Snapshot", occurrence: 1)
        )
        Assert.NotNull(hover)
        Assert.Contains("int32", hover!!.Contents.ToString(), StringComparison.Ordinal)
    }
}
