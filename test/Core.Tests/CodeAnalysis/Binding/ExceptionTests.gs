// <copyright file="ExceptionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import Xunit

/// Phase 3.D — try / catch / finally / throw statements.
open class ExceptionTests {
    @Fact
    func TryFinally_RunsFinally() {
        let source = `
var trace = ""
try {
    trace = trace + "t"
} finally {
    trace = trace + "f"
}
trace
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("tf", result.Value)
    }

    @Fact
    func TryCatch_CatchesBclException() {
        let source = `
import System
var caught = "before"
try {
    var n = Int32.Parse("not a number")
} catch (e Exception) {
    caught = "caught"
}
caught
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("caught", result.Value)
    }

    @Fact
    func TryCatchFinally_CatchAndFinallyBothRun() {
        let source = `
import System
var trace = ""
try {
    var n = Int32.Parse("bad")
} catch (e Exception) {
    trace = trace + "c"
} finally {
    trace = trace + "f"
}
trace
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("cf", result.Value)
    }

    @Fact
    func TryWithoutCatchOrFinally_Diagnosed() {
        let diagnostics = Bind("try { var x = 1 }\n")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("catch") || d.Message.Contains("finally"))
    }

    @Fact
    func Throw_NonExceptionDiagnosed() {
        let diagnostics = Bind("throw 42\n")
        Assert.NotEmpty(diagnostics)
    }

    // Issue #1649: typed catch clauses must match the REAL exception type, not
    // the EvaluatorException wrapper EvaluateExpression attaches at each
    // expression boundary for node-context reporting.
    @Fact
    func TryCatch_TypedCatchMatchesThrownClrExceptionType() {
        let source = `
import System
var caught = "before"
try {
    var n = Int32.Parse("not a number")
} catch (e FormatException) {
    caught = "caught"
}
caught
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("caught", result.Value)
    }

    @Fact
    func TryCatch_TypedCatchDoesNotMatchUnrelatedType() {
        // FormatException should not be caught by a clause typed to a sibling
        // exception type — confirms the matcher isn't just falling back to
        // "catch everything".
        let source = `
import System
var caught = "before"
try {
    var n = Int32.Parse("not a number")
} catch (e IndexOutOfRangeException) {
    caught = "wrong"
} catch (e FormatException) {
    caught = "right"
}
caught
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("right", result.Value)
    }

    @Fact
    func TryCatch_BaseTypeCatchMatchesDerivedThrow() {
        // FormatException derives from SystemException/Exception; a catch
        // typed to the CLR base Exception type still needs to match.
        let source = `
import System
var caught = "before"
try {
    var n = Int32.Parse("not a number")
} catch (e Exception) {
    caught = "caught"
}
caught
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("caught", result.Value)
    }

    @Fact
    func TryCatch_HandlerVariableBindsRealExceptionObject() {
        // The handler variable must be the real FormatException, not the
        // EvaluatorException wrapper — so .Message reads the original text.
        let source = `
import System
var msg = ""
try {
    var n = Int32.Parse("not-a-number")
} catch (e FormatException) {
    msg = e.Message
}
msg
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Contains("not-a-number", cast[string](result.Value), StringComparison.Ordinal)
    }

    @Fact
    func TryCatch_IsExpressionObservesRealExceptionType() {
        let source = `
import System
var isFormat = false
try {
    var n = Int32.Parse("bad")
} catch (e Exception) {
    isFormat = e is FormatException
}
isFormat
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func TryCatch_RethrowPropagatesOriginalTypeToOuterTypedCatch() {
        let source = `
import System
var caught = "none"
try {
    try {
        var n = Int32.Parse("bad")
    } catch (e FormatException) {
        throw e
    }
} catch (e FormatException) {
    caught = "outer-typed"
}
caught
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("outer-typed", result.Value)
    }

    @Fact
    func Uncaught_TypedException_StillReportsNodeContext() {
        // Nothing catches this — the emitted oracle must surface it as a
        // diagnosed runtime error (GS9999) carrying the exception context.
        let source = `
import System
var n = Int32.Parse("still-bad")
n
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func Bind(source string) ImmutableArray[Diagnostic] -> Evaluate(source).Diagnostics
    }
}
