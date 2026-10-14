// <copyright file="Issue319ClrBaseEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Issue #319: Emitted-oracle coverage for clr base.
open class Issue319ClrBaseEmittedOracleTests {
    @Fact
    func InitConstructor_ChainingToClrException_EmittedOracleObservesBaseMessage() {
        // Explicit `init(...) : base(msg)` against System.Exception.
        let source = `
import System
class MyErr : Exception {
    var Code int32
    init(message string, code int32) : base(message) {
        Code = code
    }
}
var e = MyErr("boom", 42)
e.Message
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("boom", result.Value)
    }

    @Fact
    func InitConstructor_ChainingToClrException_BodyAlsoRuns() {
        // Confirms the body still runs (`Code` field gets set) after the CLR
        // base ctor has run — the two were previously fighting for the same
        // 'this' representation.
        let source = `
import System
class MyErr : Exception {
    var Code int32
    init(message string, code int32) : base(message) {
        Code = code
    }
}
var e = MyErr("boom", 42)
e.Code
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func PrimaryConstructor_ChainingToClrException_EmittedOracleObservesBaseMessage() {
        // Kotlin-style primary ctor `: Exception(arg)` — the second of the two
        // shapes covered by issue #306 / #319.
        let source = `
import System
class MyErr(Detail string) : Exception(Detail) {
}
var e = MyErr("nope")
e.Message
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("nope", result.Value)
    }

    @Fact
    func PrimaryConstructor_ChainingToClrException_BaseArgIsAComputedExpression() {
        // Base-init argument is a non-trivial expression that references this
        // class's primary-ctor parameter. Emitted execution must evaluate it
        // after binding the parameter and before invoking the CLR ctor.
        let source = `
import System
class LabeledErr(Label string) : Exception(Label + "!") {
}
var e = LabeledErr("oops")
e.Message
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("oops!", result.Value)
    }

    @Fact
    func InheritedClrProperty_RoundTripsThroughWriteAndRead() {
        // Mutate an inherited CLR instance property (Exception.HResult) and
        // read it back. Confirms both the read path (BoundClrPropertyAccess)
        // and the write path (BoundClrPropertyAssignment) unwrap to the real
        // CLR backing.
        let source = `
import System
class MyErr(Detail string) : Exception(Detail) {
}
var e = MyErr("x")
e.HResult = 123
e.HResult
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(123, result.Value)
    }

    @Fact
    func InheritedClrMethod_DispatchesAgainstBackingInstance() {
        // Calling an inherited CLR instance method (Exception.ToString()) must
        // dispatch to the real backing instance so it sees the base ctor's
        // state. Before the fix this threw a TargetException because the
        // receiver was a StructValue, not a System.Exception.
        let source = `
import System
class MyErr(Detail string) : Exception(Detail) {
}
var e = MyErr("hello")
var s = e.ToString()
s.Contains("hello")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func NonExceptionClrBase_PrimaryCtor_EmittedOracleObservesBaseState() {
        // Non-Exception CLR base — proves the path is general, not Exception-
        // specific. MemoryStream(int capacity) preallocates a backing buffer
        // whose size is observable via the inherited `Capacity` property.
        let source = `
import System.IO
class SizedStream(Cap int32) : MemoryStream(Cap) {
}
var s = SizedStream(128)
s.Capacity
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(128, result.Value)
    }

    @Fact
    func NonExceptionClrBase_InheritedMethodMutatesObservableState() {
        // Calling an inherited CLR instance method that mutates internal state
        // (MemoryStream.SetLength) must be observable through a subsequent
        // inherited property read (`Length`). Validates that read AND write
        // routes share the same CLR backing.
        let source = `
import System.IO
class SizedStream(Cap int32) : MemoryStream(Cap) {
}
var s = SizedStream(16)
s.SetLength(7)
s.Length
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7L, result.Value)
    }

    @Fact
    func ThrowingUserClass_CarriesBaseMessageThroughCatch() {
        // Throwing a GSharp class that inherits System.Exception must surface
        // the real CLR exception instance (carrying the base-set Message) so a
        // `catch (e Exception)` clause sees the correct value. Before the fix
        // the interpreter wrapped the StructValue in a new
        // Exception(value.ToString()).
        let source = `
import System
class MyErr(Detail string) : Exception(Detail) {
}
var msg = ""
try {
    throw MyErr("kaboom")
} catch (e Exception) {
    msg = e.Message
}
msg
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("kaboom", result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
