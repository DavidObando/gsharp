// <copyright file="Issue3394MultiAssignmentLookaheadPerfParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Diagnostics;
using System.Text;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #3394: multi-assignment speculation must not recursively parse every
/// block-lambda body in an ordinary expression statement.
/// </summary>
public class Issue3394MultiAssignmentLookaheadPerfParserTests
{
    [Fact]
    public void DeeplyNestedBlockLambdaCalls_ParseQuickly()
    {
        const int nestingDepth = 22;
        var body = new StringBuilder("Use()");
        for (var i = 0; i < nestingDepth; i++)
        {
            body.Insert(0, "Sink(() -> {\n");
            body.Append("\n})");
        }

        var source = "package p\nfunc F() {\n" + body + "\n}\n";

        SyntaxTree.Parse("package p\nfunc Warmup() { Use() }");
        var stopwatch = Stopwatch.StartNew();
        var tree = SyntaxTree.Parse(source);
        stopwatch.Stop();

        Assert.Empty(tree.Diagnostics);
        Assert.True(
            stopwatch.Elapsed < TimeSpan.FromSeconds(5),
            $"Parsing {nestingDepth} nested block-lambda calls took " +
            $"{stopwatch.ElapsedMilliseconds}ms, expected < 5000ms.");
    }
}
