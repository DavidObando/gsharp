// <copyright file="WorkspaceSymbolHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using OmniSharp.Extensions.LanguageServer.Protocol.Models;
using Xunit;
using LspSymbolKind = OmniSharp.Extensions.LanguageServer.Protocol.Models.SymbolKind;

namespace GSharp.LanguageServer.Tests;

public class WorkspaceSymbolHandlerTests
{
    [Fact]
    public void CollectSymbols_FindsFunctions()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\n";
        var content = LanguageServerTestHelpers.Content(source);
        var results = new List<WorkspaceSymbol>();

        WorkspaceSymbolHandler.CollectSymbols(results, "file:///test.gs", content, string.Empty);

        Assert.Single(results);
        Assert.Equal("add", results[0].Name);
        Assert.Equal(LspSymbolKind.Function, results[0].Kind);
    }

    [Fact]
    public void CollectSymbols_FindsStructsAndFields()
    {
        const string source = "type Point struct {\nX int32\nY int32\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var results = new List<WorkspaceSymbol>();

        WorkspaceSymbolHandler.CollectSymbols(results, "file:///test.gs", content, string.Empty);

        Assert.Equal(3, results.Count);
        Assert.Equal("Point", results[0].Name);
        Assert.Equal(LspSymbolKind.Struct, results[0].Kind);
        Assert.Equal("X", results[1].Name);
        Assert.Equal(LspSymbolKind.Field, results[1].Kind);
    }

    [Fact]
    public void CollectSymbols_FindsEnumsAndMembers()
    {
        const string source = "type Color enum { Red, Green, Blue }\n";
        var content = LanguageServerTestHelpers.Content(source);
        var results = new List<WorkspaceSymbol>();

        WorkspaceSymbolHandler.CollectSymbols(results, "file:///test.gs", content, string.Empty);

        Assert.Equal(4, results.Count);
        Assert.Equal("Color", results[0].Name);
        Assert.Equal(LspSymbolKind.Enum, results[0].Kind);
        Assert.Contains(results, s => s.Name == "Red" && s.Kind == LspSymbolKind.EnumMember);
    }

    [Fact]
    public void CollectSymbols_FiltersWithQuery()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\nfunc sub(a int32, b int32) int32 { return a - b }\n";
        var content = LanguageServerTestHelpers.Content(source);
        var results = new List<WorkspaceSymbol>();

        WorkspaceSymbolHandler.CollectSymbols(results, "file:///test.gs", content, "add");

        Assert.Single(results);
        Assert.Equal("add", results[0].Name);
    }

    [Fact]
    public void CollectSymbols_QueryIsCaseInsensitive()
    {
        const string source = "func Add(a int32, b int32) int32 { return a + b }\n";
        var content = LanguageServerTestHelpers.Content(source);
        var results = new List<WorkspaceSymbol>();

        WorkspaceSymbolHandler.CollectSymbols(results, "file:///test.gs", content, "add");

        Assert.Single(results);
        Assert.Equal("Add", results[0].Name);
    }

    [Fact]
    public void CollectSymbols_EmptyQuery_ReturnsAll()
    {
        const string source = "func a() int32 { return 1 }\nfunc b() int32 { return 2 }\n";
        var content = LanguageServerTestHelpers.Content(source);
        var results = new List<WorkspaceSymbol>();

        WorkspaceSymbolHandler.CollectSymbols(results, "file:///test.gs", content, string.Empty);

        Assert.Equal(2, results.Count);
    }
}
