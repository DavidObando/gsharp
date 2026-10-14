// <copyright file="Issue2921LambdaBodyDefiniteReturnInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.IO
import System.Linq
import Xunit

/// Issue #2921: lambda bodies participate in GS0100 definite-return analysis.
/// Historically an emit-vs-interpreter diagnostic parity harness; the
/// evaluator arm retired with the tree-walking evaluator in ADR-0156 Phase 3c
/// (#3176) — the emitted assertions carry the same expectations.
open class Issue2921LambdaBodyDefiniteReturnInterpreterTests {
    @Fact
    func MissingReturnReportsGS0100() {
        const Source = "func Use(f (int32) -> int32) { }\nUse((v int32) -> { if v == 0 { return 1 } })"
        using let output = MemoryStream()
        let emitResult = Compilation(SyntaxTree.Parse(Source)).Emit(output)
        Assert.Equal(
            []string{"GS0100"},
            emitResult
                .Diagnostics
                .Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
                .Select((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id)
        )
    }

    @Fact
    func SequenceLambdaDoesNotRequireOrdinaryReturn() {
        const Source = "let values = func() sequence[int32] { yield 2 }\n0"
        let result = EmittedOracle.Evaluate(Source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }
}
