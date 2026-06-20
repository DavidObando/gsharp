// <copyright file="DocumentSymbolHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.LanguageServer.Protocol;
using Xunit;
using LspSymbolKind = GSharp.LanguageServer.Protocol.SymbolKind;

namespace GSharp.LanguageServer.Tests;

public class DocumentSymbolHandlerTests
{
    [Fact]
    public void ComputeDocumentSymbols_ReturnsFunctions()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\nfunc sub(a int32, b int32) int32 { return a - b }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var symbols = DocumentSymbolComputer.ComputeDocumentSymbols(content);

        Assert.Equal(2, symbols.Count);
        var first = symbols[0].DocumentSymbol;
        Assert.Equal("add", first.Name);
        Assert.Equal(LspSymbolKind.Function, first.Kind);
    }

    [Fact]
    public void ComputeDocumentSymbols_ReturnsStructWithFields()
    {
        const string source = "struct Point {\nvar X int32\nvar Y int32\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var symbols = DocumentSymbolComputer.ComputeDocumentSymbols(content);

        Assert.Single(symbols);
        var structSymbol = symbols[0].DocumentSymbol;
        Assert.Equal("Point", structSymbol.Name);
        Assert.Equal(LspSymbolKind.Struct, structSymbol.Kind);
        Assert.Equal(2, structSymbol.Children.Count());
    }

    [Fact]
    public void ComputeDocumentSymbols_ReturnsEnumWithMembers()
    {
        const string source = "enum Color { Red, Green, Blue }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var symbols = DocumentSymbolComputer.ComputeDocumentSymbols(content);

        Assert.Single(symbols);
        var enumSymbol = symbols[0].DocumentSymbol;
        Assert.Equal("Color", enumSymbol.Name);
        Assert.Equal(LspSymbolKind.Enum, enumSymbol.Kind);
        Assert.Equal(3, enumSymbol.Children.Count());
    }

    [Fact]
    public void ComputeDocumentSymbols_ReturnsGlobalVariables()
    {
        const string source = "let answer = 42\nlet greeting = \"hi\"\n";
        var content = LanguageServerTestHelpers.Content(source);

        var symbols = DocumentSymbolComputer.ComputeDocumentSymbols(content);

        Assert.Equal(2, symbols.Count);
        Assert.All(symbols, s => Assert.Equal(LspSymbolKind.Variable, s.DocumentSymbol.Kind));
    }

    // Regression tests for issue #890: the language server must never emit a
    // DocumentSymbol with a null/empty name. Incomplete or error declarations
    // produce missing identifier tokens (Text == null), which previously leaked
    // into the documentSymbol response and caused the vscode-languageclient
    // converter to throw "name must not be falsy".
    [Theory]
    [InlineData("func () int32 { return 0 }\n")]
    [InlineData("struct {\nvar X int32\n}\n")]
    [InlineData("enum { Red, Green }\n")]
    [InlineData("let = 42\n")]
    [InlineData("func\n")]
    [InlineData("struct\n")]
    [InlineData("enum\n")]
    public void ComputeDocumentSymbols_NeverEmitsEmptyName(string source)
    {
        var content = LanguageServerTestHelpers.Content(source);

        var symbols = DocumentSymbolComputer.ComputeDocumentSymbols(content);

        AssertNoEmptyNames(symbols.Select(s => s.DocumentSymbol));
    }

    [Fact]
    public void ComputeDocumentSymbols_AnonymousStructMembersHaveNames()
    {
        // A struct with a missing name still surfaces its (named) fields; none of
        // those child symbols may have an empty name either.
        const string source = "struct {\nvar X int32\nvar Y int32\n}\n";
        var content = LanguageServerTestHelpers.Content(source);

        var symbols = DocumentSymbolComputer.ComputeDocumentSymbols(content);

        AssertNoEmptyNames(symbols.Select(s => s.DocumentSymbol));
    }

    [Fact]
    public void ComputeDocumentSymbols_ValidSymbolsStillPresentAlongsideErrors()
    {
        // A valid function next to an incomplete one: the valid symbol must keep
        // its real name and the incomplete one must not produce an empty name.
        const string source = "func valid() int32 { return 1 }\nfunc () int32 { return 0 }\n";
        var content = LanguageServerTestHelpers.Content(source);

        var symbols = DocumentSymbolComputer.ComputeDocumentSymbols(content);

        AssertNoEmptyNames(symbols.Select(s => s.DocumentSymbol));
        Assert.Contains(symbols, s => s.DocumentSymbol.Name == "valid");
    }

    private static void AssertNoEmptyNames(System.Collections.Generic.IEnumerable<DocumentSymbol> symbols)
    {
        foreach (var symbol in symbols)
        {
            Assert.False(string.IsNullOrEmpty(symbol.Name), "DocumentSymbol.Name must not be null or empty.");
            if (symbol.Children != null)
            {
                AssertNoEmptyNames(symbol.Children);
            }
        }
    }
}
