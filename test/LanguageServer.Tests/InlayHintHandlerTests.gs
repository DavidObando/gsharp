// <copyright file="InlayHintHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System.Linq
import Xunit

open class InlayHintHandlerTests {
    @Fact
    func ComputeHints_DisplaysConstructedSourceGenericType() {
        const source = `class Box[T] {}
let box = Box[int32]()
`
        let content = LanguageServerTestHelpers.Content(source)
        let hint = Assert.Single(
            InlayHintComputer.ComputeHints(content, includeParameterNames: false, includeTypes: true)
        )
        Assert.Equal(": Box[int32]", hint.Label.String)
    }

    @Fact
    func ComputeHints_ShowsParameterNames() {
        const source = `func add(a int32, b int32) int32 { return a + b }
var x = add(1, 2)
`
        let content = LanguageServerTestHelpers.Content(source)
        let hints = InlayHintComputer.ComputeHints(content, includeTypes: false)
        Assert.Equal(2, hints.Count)
        Assert.Equal("a:", hints[0].Label.String)
        Assert.Equal(InlayHintKind.Parameter, hints[0].Kind)
        Assert.Equal("b:", hints[1].Label.String)
    }

    @Fact
    func ComputeHints_SkipsWhenArgMatchesParamName() {
        const source = `func add(a int32, b int32) int32 { return a + b }
var a = 1
var b = 2
var x = add(a, b)
`
        let content = LanguageServerTestHelpers.Content(source)
        let hints = InlayHintComputer.ComputeHints(content, includeTypes: false)
        Assert.Empty(hints)
    }

    @Fact
    func ComputeHints_NoHintsForUnknownFunction() {
        const source = "var x = unknown(1, 2)\n"
        let content = LanguageServerTestHelpers.Content(source)
        let hints = InlayHintComputer.ComputeHints(content, includeTypes: false)
        Assert.Empty(hints)
    }

    @Fact
    func ComputeHints_PositionsAreCorrect() {
        const source = `func greet(name string) string { return name }
var x = greet("world")
`
        let content = LanguageServerTestHelpers.Content(source)
        let hints = InlayHintComputer.ComputeHints(content, includeTypes: false)
        Assert.Single(hints)
        Assert.Equal("name:", hints[0].Label.String)
        // "world" starts at column 14 on line 1
        Assert.Equal(1, hints[0].Position.Line)
        Assert.Equal(14, hints[0].Position.Character)
    }

    @Fact
    func ComputeHints_ShowsInferredTypes() {
        let content = LanguageServerTestHelpers.Content("var answer = 42\n")
        let hint = Assert.Single(
            InlayHintComputer.ComputeHints(content, includeParameterNames: false, includeTypes: true)
        )
        Assert.Equal(": int32", hint.Label.String)
        Assert.Equal(InlayHintKind.Type, hint.Kind)
        Assert.Equal(10, hint.Position.Character)
    }

    @Fact
    func ComputeHints_FormatsImportedGenericTypes() {
        const source = "import System.Collections.Generic\n" + "let names = List[string]()\n"
        let content = LanguageServerTestHelpers.Content(source)
        let hint = Assert.Single(
            InlayHintComputer.ComputeHints(content, includeParameterNames: false, includeTypes: true)
        )
        Assert.Equal(": System.Collections.Generic.List[string]", hint.Label.String)
    }

    @Fact
    func ComputeHints_SkipsExplicitTypes() {
        let content = LanguageServerTestHelpers.Content("var answer int32 = 42\n")
        let hints = InlayHintComputer.ComputeHints(content, includeParameterNames: false, includeTypes: true)
        Assert.Empty(hints)
    }
}
