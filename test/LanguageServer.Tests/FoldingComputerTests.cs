// <copyright file="FoldingComputerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class FoldingComputerTests
{
    [Fact]
    public void ComputeFoldings_ReturnsRange_PerFunction()
    {
        const string source =
            "package P\n" +
            "\n" +
            "func A() {\n" +
            "}\n" +
            "\n" +
            "func B() {\n" +
            "}\n";

        var tree = SyntaxTree.Parse(source);
        Assert.Empty(tree.Diagnostics);

        var lineBreaks = new List<int>();
        for (var i = 0; i < source.Length; i++)
        {
            if (source[i] == '\n')
            {
                lineBreaks.Add(i);
            }
        }

        var content = new DocumentContent(tree, lineBreaks);
        var foldings = FoldingComputer.ComputeFoldings(content).ToList();
        Assert.Equal(2, foldings.Count);
        Assert.All(foldings, f => Assert.True(f.EndLine >= f.StartLine));
    }

    [Fact]
    public void ComputeFoldings_NoFunctions_ReturnsEmpty()
    {
        var tree = SyntaxTree.Parse("package P\n");
        var content = new DocumentContent(tree, [9]);
        Assert.Empty(FoldingComputer.ComputeFoldings(content));
    }
}
