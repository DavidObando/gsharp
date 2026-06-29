// <copyright file="AnalysisBridgeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Repl;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Tests that the REPL's <see cref="AnalysisBridge"/> wires LanguageServer-powered
/// completions and hover through the in-process eval buffer.
/// </summary>
public class AnalysisBridgeTests
{
    [Fact]
    public void GetCompletions_OffersKeywords()
    {
        var bridge = new AnalysisBridge();
        var items = bridge.GetCompletions("let x = 42\n", 0, 0);
        Assert.Contains(items, i => i.Label == "let" && i.Kind == "kw");
        Assert.Contains(items, i => i.Label == "func");
    }

    [Fact]
    public void GetCompletions_OffersGlobalVariables()
    {
        var bridge = new AnalysisBridge();
        var items = bridge.GetCompletions("let answer = 42\n", 0, 0);
        Assert.Contains(items, i => i.Label == "answer" && i.Kind == "var");
    }

    [Fact]
    public void GetHover_ReturnsSignatureForVariable()
    {
        var bridge = new AnalysisBridge();
        var hover = bridge.GetHover("let answer = 42\n", 0, 4);
        Assert.NotNull(hover);
        Assert.Contains("answer", hover);
    }

    [Fact]
    public void GetCompletions_OnInvalidBuffer_DoesNotThrow()
    {
        var bridge = new AnalysisBridge();
        var items = bridge.GetCompletions("@@@ invalid", 0, 3);
        Assert.NotNull(items);
    }
}
