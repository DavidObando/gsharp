// <copyright file="Issue3034NullableNarrowingDiagnosticEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #3034: Emitted-oracle coverage for nullable narrowing diagnostic.
open class Issue3034NullableNarrowingDiagnosticEmittedOracleTests {
    @Theory
    @InlineData(
        "function",
        "M()",
        "Cannot call function M because receiver 'c' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.",
        nil
    )
    @InlineData(
        "top-level",
        "M()",
        "Cannot call function M because receiver 'c' may be nil. Use '?.' for a null-safe call or bind it with 'if let'.",
        nil
    )
    @InlineData("function", "M()", "Cannot find function M.", "value int32")
    @InlineData("top-level", "M()", "Cannot find function M.", "value int32")
    @InlineData("function", "M(\"x\")", "Cannot find function M.", "value int32")
    @InlineData("top-level", "M(\"x\")", "Cannot find function M.", "value int32")
    func NullableReceiverDiagnostic_MatchesCompiler(
        $scope string,
        call string,
        expectedMessage string,
        parameter string? = nil
    ) {
        let source = if $scope == "top-level" {
            (`class C { func M(` + "$parameter" + `) { } }

var c C? = nil
c.` + "$call")
        } else {
            (`class C { func M(` + "$parameter" + `) { } }

func Run() {
    var c C? = nil
    c.` + "$call" + `
}`)
        }
        let evaluation = EmittedOracle.Evaluate(source)
        let diagnostic = Assert.Single(
            evaluation.Diagnostics.Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.Id == "GS0159")
        )
        Assert.Equal(expectedMessage, diagnostic.Message)
    }

    shared {
        private const NullableReceiverMessage string = "Cannot call function M because receiver 'c' may be nil. Use '?.' for a null-safe call or bind it with 'if let'."
    }
}
