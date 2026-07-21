// <copyright file="InlayHintHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.LanguageServer.Protocol;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class InlayHintHandlerTests
{
    [Fact]
    public void ComputeHints_ShowsParameterNames()
    {
        const string source = "func add(a int32, b int32) int32 { return a + b }\nvar x = add(1, 2)\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hints = InlayHintComputer.ComputeHints(content, includeTypes: false);

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

        var hints = InlayHintComputer.ComputeHints(content, includeTypes: false);

        Assert.Empty(hints);
    }

    [Fact]
    public void ComputeHints_NoHintsForUnknownFunction()
    {
        const string source = "var x = unknown(1, 2)\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hints = InlayHintComputer.ComputeHints(content, includeTypes: false);

        Assert.Empty(hints);
    }

    [Fact]
    public void ComputeHints_PositionsAreCorrect()
    {
        const string source = "func greet(name string) string { return name }\nvar x = greet(\"world\")\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hints = InlayHintComputer.ComputeHints(content, includeTypes: false);

        Assert.Single(hints);
        Assert.Equal("name:", hints[0].Label.String);
        // "world" starts at column 14 on line 1
        Assert.Equal(1, hints[0].Position.Line);
        Assert.Equal(14, hints[0].Position.Character);
    }

    [Fact]
    public void ComputeHints_ShowsInferredTypes()
    {
        var content = LanguageServerTestHelpers.Content("var answer = 42\n");

        var hint = Assert.Single(
            InlayHintComputer.ComputeHints(
                content,
                includeParameterNames: false,
                includeTypes: true));

        Assert.Equal(": int32", hint.Label.String);
        Assert.Equal(InlayHintKind.Type, hint.Kind);
        Assert.Equal(10, hint.Position.Character);
    }

    [Fact]
    public void ComputeHints_FormatsImportedGenericTypes()
    {
        const string source =
            "import System.Collections.Generic\n" +
            "let names = List[string]()\n";
        var content = LanguageServerTestHelpers.Content(source);

        var hint = Assert.Single(
            InlayHintComputer.ComputeHints(
                content,
                includeParameterNames: false,
                includeTypes: true));

        Assert.Equal(": System.Collections.Generic.List[string]", hint.Label.String);
    }

    [Fact]
    public void ComputeHints_SkipsExplicitTypes()
    {
        var content = LanguageServerTestHelpers.Content("var answer int32 = 42\n");

        var hints = InlayHintComputer.ComputeHints(
            content,
            includeParameterNames: false,
            includeTypes: true);

        Assert.Empty(hints);
    }
}
