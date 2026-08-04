// <copyright file="Issue2921LambdaBodyDefiniteReturnInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

// Interp-vs-emit parity harness; the evaluator side retires with the
// evaluator in ADR-0156 Phase 3c (#3176).
#pragma warning disable CS0618 // Compilation.Evaluate / Evaluator are retiring (ADR-0156 Phase 3c, #3176)

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2921: compiled and interpreted lambda binding share GS0100 behavior.
/// </summary>
public class Issue2921LambdaBodyDefiniteReturnInterpreterTests
{
    [Fact]
    public void MissingReturnHasCompiledAndInterpretedDiagnosticParity()
    {
        const string Source = """
            func Use(f (int32) -> int32) { }
            Use((v int32) -> { if v == 0 { return 1 } })
            """;

        using var output = new MemoryStream();
        var emitResult = new Compilation(SyntaxTree.Parse(Source)).Emit(output);
        var evaluationResult = new Compilation(SyntaxTree.Parse(Source))
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Equal(
            new[] { "GS0100" },
            emitResult.Diagnostics.Where(diagnostic => diagnostic.IsError).Select(diagnostic => diagnostic.Id));
        Assert.Equal(
            new[] { "GS0100" },
            evaluationResult.Diagnostics.Where(diagnostic => diagnostic.IsError).Select(diagnostic => diagnostic.Id));
    }

    [Fact]
    public void SequenceLambdaDoesNotRequireOrdinaryReturn()
    {
        const string Source = """
            let values = func() sequence[int32] { yield 2 }
            0
            """;

        var result = new Compilation(SyntaxTree.Parse(Source))
            .Evaluate(new Dictionary<VariableSymbol, object>());

        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }
}
