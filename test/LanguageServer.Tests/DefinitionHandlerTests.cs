// <copyright file="DefinitionHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.LanguageServer.Protocol;
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
        const string source = "struct Point {\nvar X int32\nvar Y int32\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///def.gs");

        var location = DefinitionComputer.ComputeDefinition(uri, content, LanguageServerTestHelpers.PositionOf(source, "Point"));

        Assert.NotNull(location);
        Assert.Equal(uri, location.Uri);
    }

    [Fact]
    public void ComputeDefinitions_PartialType_ReturnsAllPartLocations()
    {
        // ADR-0144: go-to-definition on a partial type returns every part's
        // location. Two `partial class Point` parts on lines 0 and 3.
        const string source =
            "partial class Point {\n    var x int32 = 0\n}\npartial class Point {\n    func Get() int32 { return x }\n}\nlet p = Point()\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///def.gs");

        // Cursor on the `Point` type name in the `Point()` construction.
        var locations = DefinitionComputer.ComputeDefinitions(uri, content, LanguageServerTestHelpers.PositionOf(source, "Point", 2));

        Assert.Equal(2, locations.Count);
        Assert.Contains(locations, l => l.Range.Start.Line == 0);
        Assert.Contains(locations, l => l.Range.Start.Line == 3);

        // The single-Location convenience overload returns the first part.
        var single = DefinitionComputer.ComputeDefinition(uri, content, LanguageServerTestHelpers.PositionOf(source, "Point", 2));
        Assert.NotNull(single);
        Assert.Equal(0, single.Range.Start.Line);
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

    [Fact]
    public void ComputeDefinition_PropertyUsageGoesToDeclaration()
    {
        // Implicit-this property usage (`Width` inside a method) must navigate to the
        // property declaration. Previously FindDeclarationToken had no PropertySymbol case.
        const string source = "class Rect {\n    prop Width int32\n    func Double() int32 { return Width + Width }\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///def.gs");

        var location = DefinitionComputer.ComputeDefinition(uri, content, LanguageServerTestHelpers.PositionOf(source, "Width", 1));

        Assert.NotNull(location);
        Assert.Equal(uri, location.Uri);
        // Declaration identifier "Width" is on line 1 (0-based).
        Assert.Equal(1, location.Range.Start.Line);
    }

    [Fact]
    public void ComputeDefinition_ExplicitPropertyAccessGoesToDeclaration()
    {
        // `this.Width` member access must navigate to the property declaration.
        const string source = "class Rect {\n    prop Width int32\n    func Get() int32 { return this.Width }\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///def.gs");

        var location = DefinitionComputer.ComputeDefinition(uri, content, LanguageServerTestHelpers.PositionOf(source, "Width", 1));

        Assert.NotNull(location);
        Assert.Equal(1, location.Range.Start.Line);
    }

    [Fact]
    public void ComputeDefinition_MethodUsageGoesToDeclaration()
    {
        const string source = "class Calc {\n    func Add(a int32, b int32) int32 { return a + b }\n    func Run() int32 { return Add(1, 2) }\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var uri = DocumentUri.From("file:///def.gs");

        var location = DefinitionComputer.ComputeDefinition(uri, content, LanguageServerTestHelpers.PositionOf(source, "Add", 1));

        Assert.NotNull(location);
        Assert.Equal(1, location.Range.Start.Line);
    }
}
