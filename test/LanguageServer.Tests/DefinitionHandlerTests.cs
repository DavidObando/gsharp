// <copyright file="DefinitionHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using OmniSharp.Extensions.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class DefinitionHandlerTests
{
    [Fact]
    public void ComputeDefinition_FunctionUsageGoesToDeclaration()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\nlet result = add(1, 2)\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///def.gs");

        // Position cursor on the "add" call in "add(1, 2)"
        var location = DefinitionComputer.ComputeDefinition(uri, content, LanguageServerTestHelpers.PositionOf(source, "add", 1));

        Assert.NotNull(location);
        Assert.Equal(uri, location.Uri);
        // Should point to the function declaration identifier
        Assert.Equal(0, location.Range.Start.Line);
        Assert.Equal(5, location.Range.Start.Character);
    }

    [Fact]
    public void ComputeDefinition_VariableUsageGoesToDeclaration()
    {
        const string source = "func F() int32 {\nlet x = 42\nreturn x\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///def.gs");

        // Position on the "x" in "return x"
        var location = DefinitionComputer.ComputeDefinition(uri, content, LanguageServerTestHelpers.PositionOf(source, "x", 1));

        Assert.NotNull(location);
        Assert.Equal(uri, location.Uri);
    }

    [Fact]
    public void ComputeDefinition_StructNameGoesToDeclaration()
    {
        const string source = "type Point struct {\nX int32\nY int32\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///def.gs");

        var location = DefinitionComputer.ComputeDefinition(uri, content, LanguageServerTestHelpers.PositionOf(source, "Point"));

        Assert.NotNull(location);
        Assert.Equal(uri, location.Uri);
    }

    [Fact]
    public void ComputeDefinition_ReturnsNullForUnknownToken()
    {
        const string source = "let x = 42\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///def.gs");

        // Position on "42" — a literal, not a symbol
        var location = DefinitionComputer.ComputeDefinition(uri, content, LanguageServerTestHelpers.PositionOf(source, "42"));

        Assert.Null(location);
    }
}
