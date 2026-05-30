// <copyright file="InlayHintHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using OmniSharp.Extensions.LanguageServer.Protocol.Models;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class InlayHintHandlerTests
{
    [Fact]
    public void ComputeHints_ShowsParameterNames()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\nvar x = add(1, 2)\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hints = InlayHintComputer.ComputeHints(content);

        Assert.Equal(2, hints.Count);
        Assert.Equal("a:", hints[0].Label.String);
        Assert.Equal(InlayHintKind.Parameter, hints[0].Kind);
        Assert.Equal("b:", hints[1].Label.String);
    }

    [Fact]
    public void ComputeHints_SkipsWhenArgMatchesParamName()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\nvar a = 1\nvar b = 2\nvar x = add(a, b)\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hints = InlayHintComputer.ComputeHints(content);

        Assert.Empty(hints);
    }

    [Fact]
    public void ComputeHints_NoHintsForUnknownFunction()
    {
        const string source = "var x = unknown(1, 2)\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hints = InlayHintComputer.ComputeHints(content);

        Assert.Empty(hints);
    }

    [Fact]
    public void ComputeHints_PositionsAreCorrect()
    {
        const string source = "func greet(name string) string { return name }\nvar x = greet(\"world\")\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hints = InlayHintComputer.ComputeHints(content);

        Assert.Single(hints);
        Assert.Equal("name:", hints[0].Label.String);
        // "world" starts at column 14 on line 1
        Assert.Equal(1, hints[0].Position.Line);
        Assert.Equal(14, hints[0].Position.Character);
    }
}
