// <copyright file="CountWordsSampleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.LanguageConformance;

/// <summary>
/// Phase 4 exit / ADR-0001: cross-feature integration test for the
/// <c>samples/aspirational/CountWords.gs</c> sample. Exercises CLR
/// constructor calls (#63), CLR member access + indexers (#64), and
/// <c>for k, v := range coll</c> (#65) end-to-end against an actual
/// <c>Dictionary[string, int]</c>. The sample lives under
/// <c>samples/aspirational/</c> because the emit backend does not yet
/// support these CLR-interop features; this interpreter-side test is
/// the executable spec until emit catches up.
/// </summary>
public class CountWordsSampleTests
{
    [Fact]
    public void CountWordsSample_RunsOnInterpreter_MatchesGolden()
    {
        var samplesDir = LocateSamplesDirectory();
        Assert.NotNull(samplesDir);

        var samplePath = Path.Combine(samplesDir!, "aspirational", "CountWords.gs");
        var goldenPath = Path.Combine(samplesDir!, "aspirational", "CountWords.golden");
        Assert.True(File.Exists(samplePath), $"missing sample at {samplePath}");
        Assert.True(File.Exists(goldenPath), $"missing golden at {goldenPath}");

        var source = File.ReadAllText(samplePath);
        var expected = File.ReadAllText(goldenPath).Replace("\r\n", "\n");

        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);

        var prevOut = Console.Out;
        var captured = new StringWriter();
        Console.SetOut(captured);
        EvaluationResult result;
        try
        {
            result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        Assert.Empty(result.Diagnostics);
        var actual = captured.ToString().Replace("\r\n", "\n");
        Assert.Equal(expected, actual);
    }

    private static string LocateSamplesDirectory()
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(typeof(CountWordsSampleTests).Assembly.Location) !);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "samples");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                return candidate;
            }

            dir = dir.Parent;
        }

        return null;
    }
}
