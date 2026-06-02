// <copyright file="HoverHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

namespace GSharp.LanguageServer.Tests;

public class HoverHandlerTests
{
    [Theory]
    [InlineData("let answer = 42\n", "answer", "let answer int32")]
    [InlineData("var count = 0\n", "count", "var count int32")]
    [InlineData("func add(a int32, b int32) int32 { return a + b }\n", "add", "func add(a int32, b int32) int32")]
    [InlineData("func greet(name string) { }\n", "name", "name string")]
    [InlineData("type Point struct {\nX int32\nY int32\n}\n", "Point", "struct Point { X int32; Y int32 }")]
    [InlineData("type Color enum { Red, Green }\n", "Color", "enum Color { Red, Green }")]
    [InlineData("import System\nfunc main() {\nConsole.WriteLine(\"hi\")\n}\n", "Console", "class System.Console")]
    public void ComputeHover_ReturnsMarkdownSignature(string source, string token, string expected)
    {
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, token));

        Assert.NotNull(hover);
        Assert.Contains(expected, hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("package P\ntype Person class {\n    prop Name string\n}\n", "Name")]
    [InlineData("package P\nimport sys = System\n", "sys")]
    [InlineData("package Outer.Inner\n", "Outer")]
    [InlineData("package Outer.Inner\n", "Inner")]
    [InlineData("package P\nimport System\ntype Foo class {\n  event Click func(Object, EventArgs)\n}\n", "Click")]
    public void ComputeHover_ResolvesPropertyImportPackageAndEventSymbols(string source, string token)
    {
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, token));

        Assert.NotNull(hover);
        Assert.Contains(token, hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("func greet(name string) { }\n", "name", "(parameter) name string")]
    [InlineData("func f() {\nvar x = 5\nx = x + 1\n}\n", "x", "(local variable) x int32")]
    [InlineData("type Color enum { Red, Green }\n", "Red", "Color.Red = 0")]
    [InlineData("type Color enum { Red, Green }\n", "Green", "Color.Green = 1")]
    [InlineData("package P\nimport sys = System\n", "sys", "import sys = System")]
    [InlineData("package Outer.Inner\n", "Inner", "package Outer.Inner")]
    public void ComputeHover_RendersEnrichedDescriptors(string source, string token, string expected)
    {
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, token));

        Assert.NotNull(hover);
        Assert.Contains(expected, hover.Contents.ToString(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_RendersPropertyAccessors()
    {
        const string source = "package P\ntype Person class {\n    prop Name string\n}\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "Name"));

        Assert.NotNull(hover);
        var value = hover.Contents.ToString();
        Assert.Contains("Name string {", value, System.StringComparison.Ordinal);
        Assert.Contains("get;", value, System.StringComparison.Ordinal);
    }

    [Fact]
    public void ComputeHover_DoesNotAnnotateOverloadsForSingleFunction()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\n";
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, "add"));

        Assert.NotNull(hover);
        Assert.DoesNotContain("overload", hover.Contents.ToString(), System.StringComparison.Ordinal);
    }
}
