// <copyright file="Issue2938DelegateExceptionDiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import Xunit

/// Issue #2938: uncaught exceptions from delegates reached through CLR members
/// retain their real message, and typed catch clauses receive the real
/// exception. Historically these tests also pinned the tree-walking
/// evaluator's runtime-diagnostic protocol — the source-node location
/// anchoring and the recursive unwrapping of the evaluator's own
/// reflection-call wrappers (`TargetInvocationException`,
/// aggregate-await shapes). That machinery retired with the evaluator in
/// ADR-0156 Phase 3c (#3176): emitted code performs direct IL calls, so no
/// interpreter-synthesized wrappers exist to unwrap, and the emitted oracle
/// surfaces an uncaught exception as a GS9999 diagnostic carrying the real
/// (cref:Exception.Message) with no source-node location.
open class Issue2938DelegateExceptionDiagnosticTests {
    @Theory
    @MemberData("StorageCases")
    func StoredDelegate_UncaughtExceptionKeepsMessage(_ string, source string) {
        AssertDiagnostic(source, "Attempted to divide by zero.")
    }

    @Fact
    func NestedDelegate_UncaughtExceptionKeepsInnermostMessage() {
        const Source = `let inner (int32) -> int32 = (value int32) -> 1 / value
let outer (int32) -> int32 = (value int32) -> inner(value)
let pair = (outer, 0)
pair.Item1(0)`
        AssertDiagnostic(Source, "Attempted to divide by zero.")
    }

    @Fact
    func UserThrownException_KeepsMessage() {
        const Source = `import System
import System.Collections.Generic

let handler () -> int32 = () -> throw InvalidOperationException("user boom")
let handlers = List[() -> int32]{ handler }
handlers[0]()`
        AssertDiagnostic(Source, "user boom")
    }

    @Fact
    func NullReferenceException_KeepsMessage() {
        const Source = `import GSharp.Interpreter.Tests

let handler () -> int32 = () -> Issue2938ExceptionProbe.ThrowNullReference()
let pair = (handler, 0)
pair.Item1()`
        AssertDiagnostic(Source, "null boom")
    }

    @Fact
    func NonTargetInvocationInnerException_IsNotOverUnwrapped() {
        const Source = `import GSharp.Interpreter.Tests

let handler () -> int32 = () -> throw Issue2938ExceptionProbe.CreateWithOrdinaryInner()
handler()`
        AssertDiagnostic(Source, "outer boom")
    }

    @Fact
    func UserThrownTargetInvocationException_KeepsOuterMessage() {
        const Source = `import System
import System.Reflection

let handler () -> int32 = () -> throw TargetInvocationException(
    "author outer",
    InvalidOperationException("author inner"))
handler()`
        AssertDiagnostic(Source, "author outer")
    }

    @Fact
    func SingleAggregateTargetInvocation_RemainsCatchableAsAggregateException() {
        const Source = `import System
import System.Reflection

var message = "none"
try {
    throw AggregateException(TargetInvocationException(DivideByZeroException("boom")))
} catch (ex AggregateException) {
    message = "caught-aggregate"
} catch (ex DivideByZeroException) {
    message = "caught-dbz"
}
message`
        let result = EmittedOracle.Evaluate(Source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("caught-aggregate", result.Value)
    }

    @Fact
    func TypedCatch_StillReceivesRealException() {
        const Source = `import System
import GSharp.Interpreter.Tests

let handler () -> int32 = () -> throw Issue2938ExceptionProbe.CreateWithOrdinaryInner()
let pair = (handler, 0)
var message = ""
try {
    pair.Item1()
} catch (ex InvalidOperationException) {
    message = ex.Message
}
message`
        let result = EmittedOracle.Evaluate(Source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("outer boom", result.Value)
    }

    shared {
        /// Gets delegate-storage cases covering CLR and language containers.
        prop StorageCases TheoryData[string, string] -> TheoryData[string, string]{"tuple": `let handler (int32) -> int32 = (value int32) -> 1 / value
let pair = (handler, 0)
pair.Item1(0)`, "list": `import System.Collections.Generic

let handler (int32) -> int32 = (value int32) -> 1 / value
let handlers = List[(int32) -> int32]{ handler }
handlers[0](0)`, "array": `let handler (int32) -> int32 = (value int32) -> 1 / value
let handlers = []((int32) -> int32){ handler }
handlers[0](0)`, "struct-field": `struct Holder {
    var Handler (int32) -> int32
}

let holder = Holder{Handler: (value int32) -> 1 / value}
holder.Handler(0)`, "class-field": `class Holder {
    var Handler (int32) -> int32
}

let holder = Holder{}
holder.Handler = (value int32) -> 1 / value
holder.Handler(0)`, "returned": `func Handler() (int32) -> int32 {
    return (value int32) -> 1 / value
}

Handler()(0)`}

        private func AssertDiagnostic(source string, message string) {
            let result = EmittedOracle.Evaluate(source)
            let diagnostic = Assert.Single(result.Diagnostics)
            Assert.Equal("GS9999", diagnostic.Id)
            Assert.Equal(GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error, diagnostic.Severity)
            Assert.Equal(message, diagnostic.Message)
            Assert.NotNull(result.UnhandledException)
        }
    }
}

/// CLR exception shapes used by issue #2938 tests.
shared class Issue2938ExceptionProbe {
    /// Throws a null-reference exception with a stable message.
    /// @returns This method never returns.
    func ThrowNullReference() int32 {
        throw NullReferenceException("null boom")
    }

    /// Creates an ordinary exception that itself has an inner exception.
    /// @returns Exception with a non-target-invocation inner exception.
    func CreateWithOrdinaryInner() Exception -> InvalidOperationException(
        "outer boom",
        DivideByZeroException("inner boom")
    )
}
