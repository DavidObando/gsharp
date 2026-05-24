// <copyright file="HoverHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

namespace GSharp.LanguageServer.Tests;

public class HoverHandlerTests
{
    [Theory]
    [InlineData("let answer = 42\n", "answer", "let answer: int")]
    [InlineData("func add(a int, b int) int { return a + b }\n", "add", "func add(a int, b int) int")]
    [InlineData("type Point struct {\nX int\nY int\n}\n", "Point", "struct Point { X int; Y int }")]
    [InlineData("type Color enum { Red, Green }\n", "Color", "enum Color { Red, Green }")]
    public void ComputeHover_ReturnsMarkdownSignature(string source, string token, string expected)
    {
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, token));

        Assert.NotNull(hover);
        Assert.Contains(expected, hover.Contents.ToString(), System.StringComparison.Ordinal);
    }
}
