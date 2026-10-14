// <copyright file="Issue2999TargetInvocationExceptionEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.Collections.Generic
import System.Reflection
import Xunit

/// Issue #2999: Emitted-oracle coverage for target invocation exception.
open class Issue2999TargetInvocationExceptionEmittedOracleTests {
    @Fact
    func UserThrownTargetInvocationException_IsCatchable() {
        const Source = `import System
import System.Reflection

let handler () -> int32 = () -> throw TargetInvocationException(
    "outer",
    InvalidOperationException("inner"))

var caught = false
try {
    handler()
} catch (ex TargetInvocationException) {
    caught = true
}
caught`
        let result = Evaluate(Source)
        Assert.Equal(true, result.Value)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ReflectionWrapper_UnwrapsOnlyToUserTargetInvocationException() {
        const Source = `import System
import System.Reflection
import GSharp.Interpreter.Tests

var message = ""
try {
    Issue2999ExceptionProbe.ThrowUserTargetInvocationException()
} catch (ex TargetInvocationException) {
    message = ex.Message
}
message`
        let result = Evaluate(Source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("outer", result.Value)
    }

    @Fact
    func ReflectionWrappedFormatException_IsCatchable() {
        const Source = `import System

var caught = false
try {
    Convert.ToInt32("x")
} catch (ex FormatException) {
    caught = true
}
caught`
        let result = Evaluate(Source)
        Assert.Equal(true, result.Value)
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult -> EmittedOracle.Evaluate(source)
    }
}

/// CLR exception probes for issue #2999.
shared class Issue2999ExceptionProbe {
    /// Throws a deliberate target-invocation exception.
    /// @returns This method never returns.
    func ThrowUserTargetInvocationException() int32 {
        throw TargetInvocationException("outer", InvalidOperationException("inner"))
    }
}
