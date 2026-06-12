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
}
