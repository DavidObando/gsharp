// <copyright file="AnalysisBridgeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

public class AnalysisBridgeTests
{
    [Fact]
    public void Completions_AfterFunctionDecl_IncludesUserSymbol()
    {
        var text = "func Greet() string { return \"hi\" }\n";
        var items = AnalysisBridge.Completions(text, 1, 0);
        Assert.Contains(items, i => i.Label == "Greet");
    }

    [Fact]
    public void Hover_OnFunctionName_ReturnsText()
    {
        var text = "func Greet() string { return \"hi\" }";
        var h = AnalysisBridge.Hover(text, 0, 5);
        Assert.False(string.IsNullOrEmpty(h));
    }
}
