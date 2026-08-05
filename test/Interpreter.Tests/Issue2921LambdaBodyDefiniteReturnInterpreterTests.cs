// <copyright file="Issue2921LambdaBodyDefiniteReturnInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2921: lambda bodies participate in GS0100 definite-return analysis.
/// Historically an emit-vs-interpreter diagnostic parity harness; the
/// evaluator arm retired with the tree-walking evaluator in ADR-0156 Phase 3c
/// (#3176) — the emitted assertions carry the same expectations.
/// </summary>
public class Issue2921LambdaBodyDefiniteReturnInterpreterTests
{
    [Fact]
    public void MissingReturnReportsGS0100()
    {
        const string Source = """
            func Use(f (int32) -> int32) { }
            Use((v int32) -> { if v == 0 { return 1 } })
            """;

        using var output = new MemoryStream();
        var emitResult = new Compilation(SyntaxTree.Parse(Source)).Emit(output);

        Assert.Equal(
            new[] { "GS0100" },
            emitResult.Diagnostics.Where(diagnostic => diagnostic.IsError).Select(diagnostic => diagnostic.Id));
    }

    [Fact]
    public void SequenceLambdaDoesNotRequireOrdinaryReturn()
    {
        const string Source = """
            let values = func() sequence[int32] { yield 2 }
            0
            """;

        var result = EmittedOracle.Evaluate(Source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }
}
