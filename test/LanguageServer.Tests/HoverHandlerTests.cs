// <copyright file="HoverHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

namespace GSharp.LanguageServer.Tests;

public class HoverHandlerTests
{
    [Theory]
    [InlineData("let answer = 42\n", "answer", "let answer: int32")]
    [InlineData("func add(a int32, b int32) int32 { return a + b }\n", "add", "func add(a int32, b int32) int32")]
    [InlineData("type Point struct {\nX int32\nY int32\n}\n", "Point", "struct Point { X int32; Y int32 }")]
    [InlineData("type Color enum { Red, Green }\n", "Color", "enum Color { Red, Green }")]
    public void ComputeHover_ReturnsMarkdownSignature(string source, string token, string expected)
    {
        var content = LanguageServerTestHelpers.Content(source);
        var hover = HoverComputer.ComputeHover(content, LanguageServerTestHelpers.PositionOf(source, token));

        Assert.NotNull(hover);
        Assert.Contains(expected, hover.Contents.ToString(), System.StringComparison.Ordinal);
    }
}
