// <copyright file="DocumentSymbolHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import LspSymbolKind = GSharp.LanguageServer.Protocol.SymbolKind
import System.Collections.Generic
import System.Linq
import Xunit

open class DocumentSymbolHandlerTests {
    @Fact
    func ComputeDocumentSymbols_ReturnsFunctions() {
        const source = `func add(a int32, b int32) int32 { return a + b }
func sub(a int32, b int32) int32 { return a - b }
`
        let content = LanguageServerTestHelpers.Content(source)
        let symbols = DocumentSymbolComputer.ComputeDocumentSymbols(content)
        Assert.Equal(2, symbols.Count)
        let first = symbols[0].DocumentSymbol
        Assert.Equal("add", first.Name)
        Assert.Equal(LspSymbolKind.Function, first.Kind)
    }

    @Fact
    func ComputeDocumentSymbols_ReturnsStructWithFields() {
        const source = `struct Point {
var X int32
var Y int32
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let symbols = DocumentSymbolComputer.ComputeDocumentSymbols(content)
        Assert.Single(symbols)
        let structSymbol = symbols[0].DocumentSymbol
        Assert.Equal("Point", structSymbol.Name)
        Assert.Equal(LspSymbolKind.Struct, structSymbol.Kind)
        Assert.Equal(2, structSymbol.Children!!.Count())
    }

    @Fact
    func ComputeDocumentSymbols_ReturnsEnumWithMembers() {
        const source = "enum Color { Red, Green, Blue }\n"
        let content = LanguageServerTestHelpers.Content(source)
        let symbols = DocumentSymbolComputer.ComputeDocumentSymbols(content)
        Assert.Single(symbols)
        let enumSymbol = symbols[0].DocumentSymbol
        Assert.Equal("Color", enumSymbol.Name)
        Assert.Equal(LspSymbolKind.Enum, enumSymbol.Kind)
        Assert.Equal(3, enumSymbol.Children!!.Count())
    }

    @Fact
    func ComputeDocumentSymbols_ReturnsGlobalVariables() {
        const source = `let answer = 42
let greeting = "hi"
`
        let content = LanguageServerTestHelpers.Content(source)
        let symbols = DocumentSymbolComputer.ComputeDocumentSymbols(content)
        Assert.Equal(2, symbols.Count)
        Assert.All(
            symbols,
            (s SymbolInformationOrDocumentSymbol) -> Assert.Equal(LspSymbolKind.Variable, s.DocumentSymbol.Kind)
        )
    }

    // Regression tests for issue #890: the language server must never emit a
    // DocumentSymbol with a null/empty name. Incomplete or error declarations
    // produce missing identifier tokens (Text == null), which previously leaked
    // into the documentSymbol response and caused the vscode-languageclient
    // converter to throw "name must not be falsy".
    @Theory
    @InlineData("func () int32 { return 0 }\n")
    @InlineData(`struct {
var X int32
}
`)
    @InlineData("enum { Red, Green }\n")
    @InlineData("let = 42\n")
    @InlineData("func\n")
    @InlineData("struct\n")
    @InlineData("enum\n")
    func ComputeDocumentSymbols_NeverEmitsEmptyName(source string) {
        let content = LanguageServerTestHelpers.Content(source)
        let symbols = DocumentSymbolComputer.ComputeDocumentSymbols(content)
        AssertNoEmptyNames(symbols.Select((s SymbolInformationOrDocumentSymbol) -> s.DocumentSymbol))
    }

    @Fact
    func ComputeDocumentSymbols_AnonymousStructMembersHaveNames() {
        // A struct with a missing name still surfaces its (named) fields; none of
        // those child symbols may have an empty name either.
        const source = `struct {
var X int32
var Y int32
}
`
        let content = LanguageServerTestHelpers.Content(source)
        let symbols = DocumentSymbolComputer.ComputeDocumentSymbols(content)
        AssertNoEmptyNames(symbols.Select((s SymbolInformationOrDocumentSymbol) -> s.DocumentSymbol))
    }

    @Fact
    func ComputeDocumentSymbols_ValidSymbolsStillPresentAlongsideErrors() {
        // A valid function next to an incomplete one: the valid symbol must keep
        // its real name and the incomplete one must not produce an empty name.
        const source = `func valid() int32 { return 1 }
func () int32 { return 0 }
`
        let content = LanguageServerTestHelpers.Content(source)
        let symbols = DocumentSymbolComputer.ComputeDocumentSymbols(content)
        AssertNoEmptyNames(symbols.Select((s SymbolInformationOrDocumentSymbol) -> s.DocumentSymbol))
        Assert.Contains(symbols, (s SymbolInformationOrDocumentSymbol) -> s.DocumentSymbol.Name == "valid")
    }

    shared {
        private func AssertNoEmptyNames(symbols IEnumerable[DocumentSymbol]?) {
            for symbol in symbols!! {
                Assert.False(string.IsNullOrEmpty(symbol.Name), "DocumentSymbol.Name must not be null or empty.")
                if symbol.Children != nil {
                    AssertNoEmptyNames(symbol.Children)
                }
            }
        }
    }
}
