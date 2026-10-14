// <copyright file="WorkspaceSymbolHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import LspSymbolKind = GSharp.LanguageServer.Protocol.SymbolKind
import System.Collections.Generic
import System.Linq
import Xunit

open class WorkspaceSymbolHandlerTests {
    @Fact
    func CollectSymbols_FindsFunctions() {
        const source = "func add(a int32, b int32) int32 { return a + b }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let results = List[WorkspaceSymbol]()
        WorkspaceSymbolHandler.CollectSymbols(results, "file:///test.gs", content, string.Empty)
        Assert.Single(results)
        Assert.Equal("add", results[0].Name)
        Assert.Equal(LspSymbolKind.Function, results[0].Kind)
    }

    @Fact
    func CollectSymbols_FindsStructsAndFields() {
        const source = `struct Point {
var X int32
var Y int32
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let results = List[WorkspaceSymbol]()
        WorkspaceSymbolHandler.CollectSymbols(results, "file:///test.gs", content, string.Empty)
        Assert.Equal(3, results.Count)
        Assert.Equal("Point", results[0].Name)
        Assert.Equal(LspSymbolKind.Struct, results[0].Kind)
        Assert.Equal("X", results[1].Name)
        Assert.Equal(LspSymbolKind.Field, results[1].Kind)
    }

    @Fact
    func CollectSymbols_FindsEnumsAndMembers() {
        const source = "enum Color { Red, Green, Blue }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let results = List[WorkspaceSymbol]()
        WorkspaceSymbolHandler.CollectSymbols(results, "file:///test.gs", content, string.Empty)
        Assert.Equal(4, results.Count)
        Assert.Equal("Color", results[0].Name)
        Assert.Equal(LspSymbolKind.Enum, results[0].Kind)
        Assert.Contains(results, (s WorkspaceSymbol) -> s.Name == "Red" && s.Kind == LspSymbolKind.EnumMember)
    }

    @Fact
    func CollectSymbols_FiltersWithQuery() {
        const source = `func add(a int32, b int32) int32 { return a + b }
func sub(a int32, b int32) int32 { return a - b }
`
        let content = LanguageServerTestHelpers.Content(source)
        let results = List[WorkspaceSymbol]()
        WorkspaceSymbolHandler.CollectSymbols(results, "file:///test.gs", content, "add")
        Assert.Single(results)
        Assert.Equal("add", results[0].Name)
    }

    @Fact
    func CollectSymbols_QueryIsCaseInsensitive() {
        const source = "func Add(a int32, b int32) int32 { return a + b }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let results = List[WorkspaceSymbol]()
        WorkspaceSymbolHandler.CollectSymbols(results, "file:///test.gs", content, "add")
        Assert.Single(results)
        Assert.Equal("Add", results[0].Name)
    }

    @Fact
    func CollectSymbols_EmptyQuery_ReturnsAll() {
        const source = `func a() int32 { return 1 }
func b() int32 { return 2 }
`
        let content = LanguageServerTestHelpers.Content(source)
        let results = List[WorkspaceSymbol]()
        WorkspaceSymbolHandler.CollectSymbols(results, "file:///test.gs", content, string.Empty)
        Assert.Equal(2, results.Count)
    }
}
