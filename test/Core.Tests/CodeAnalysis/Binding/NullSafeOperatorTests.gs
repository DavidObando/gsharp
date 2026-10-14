// <copyright file="NullSafeOperatorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.IO
import Xunit

/// Phase 3.C.3 — null-safe operators `??` (null-coalescing) and postfix `!!`
/// (null assertion), plus Phase 3.C.3b null-conditional member access
/// `?.`.
open class NullSafeOperatorTests {
    @Fact
    func Elvis_NullLeft_ReturnsRight() {
        let source = `
var x int32? = nil
x ?? 42
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func Elvis_NonNullLeft_ReturnsLeft() {
        let source = `
var x int32? = 7
x ?? 42
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func BangBang_NonNull_ReturnsUnderlying() {
        let source = `
var x int32? = 9
x!!
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.Value)
    }

    @Fact
    func BangBang_Null_Throws() {
        let source = `
var x int32? = nil
x!!
`
        // Issue #3216 contract decision: `!!` on nil fails with the
        // underlying CLR exception (compiled semantics); the evaluator's
        // 'nil value !!' panic message retires with the evaluator
        // (ADR-0156 Phase 3c). Unwrapping a value-type `T?` surfaces
        // InvalidOperationException.
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.IsType[InvalidOperationException](result.UnhandledException)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Nullable object must have a value"))
    }

    @Fact
    func NullConditional_NilReceiver_ShortCircuits() {
        // BCL string method called via `?.` on a nil receiver returns nil
        // (the whole expression's type becomes string?).
        let source = `
var s string? = nil
s?.ToUpper() ?? "fallback"
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("fallback", result.Value)
    }

    @Fact
    func NullConditional_NonNilReceiver_EvaluatesAccess() {
        let source = `
var s string? = "hi"
s?.ToUpper() ?? "fallback"
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("HI", result.Value)
    }

    @Fact
    func BangBang_ChainedMemberAccess_OnNonNilReceiver_BindsAndEvaluates() {
        // Issue #518: `expr!!.Member` must bind end-to-end. Models the
        // reduced reproducer (DirectoryInfo.Parent!!.Name) with a
        // string?, which exercises the same parse-tree shape the binder
        // sees: `AccessorExpression(LeftPart = UnaryExpression(!!), RightPart = Name)`.
        let source = `
import System

var s string? = "hello"
s!!.Length
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func BangBang_ChainedMethodCall_OnNonNilReceiver_BindsAndEvaluates() {
        // `expr!!.Method()` — accessor LeftPart is the `!!` UnaryExpression,
        // RightPart is a CallExpression. Confirms the binder routes the
        // call through the unwrapped receiver.
        let source = `
import System

var s string? = "hello"
s!!.ToUpper()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("HELLO", result.Value)
    }

    @Fact
    func BangBang_ChainedMemberAccess_OnNilReceiver_Throws() {
        // Mirrors PR #541's semantics: when `!!` is applied to a value
        // that is actually nil, evaluation must surface the failure (the
        // chained `.Length` is never reached).
        let source = `
import System

var s string? = nil
s!!.Length
`
        // Issue #3216 contract decision: `!!` on nil fails with the
        // underlying CLR exception (compiled semantics) — a nil reference
        // receiver surfaces NullReferenceException; the evaluator's
        // 'nil value !!' panic retires with the evaluator (Phase 3c).
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.IsType[NullReferenceException](result.UnhandledException)
    }

    @Fact
    func BangBang_DoubleChain_OnNonNilReceivers_BindsAndEvaluates() {
        // `a!!.b!!.c` — two `!!` unwraps interleaved with member access.
        // Each `!!` resumes the postfix chain so the next `.` hangs off
        // the unwrapped value, never the bare name.
        let source = `
import System

var s string? = "hello"
var u string? = s!!.ToUpper()
u!!.Length
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(5, result.Value)
    }

    @Fact
    func BangBang_ChainedMemberAccess_DirectoryInfoParentName_BindsAndEvaluates() {
        // Original reproducer shape from the issue. Picks a path whose
        // parent is guaranteed to exist (we walk to root from a directory
        // we already created); confirms `dir.Parent!!.Name` binds and
        // executes against a CLR `DirectoryInfo`.
        let tempDir = Directory.CreateTempSubdirectory("gs_bug518_parent_").FullName
        try {
            let literal = EscapeForGSharpString(tempDir)
            let source = (`
import System.IO

let dir = DirectoryInfo("` + "$literal" + `")
dir.Parent!!.Name
`)
            let result = Evaluate(source)
            Assert.Empty(result.Diagnostics)
            let expected = DirectoryInfo(tempDir).Parent!!.Name
            Assert.Equal(expected, result.Value)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func BangBang_ChainedMemberAccess_DirectoryInfoParentName_NullParent_Throws() {
        // The complement: when `.Parent` is actually nil (root directory),
        // `dir.Parent!!.Name` must surface the `!!`-on-nil failure
        // (consistent with PR #541), not silently return null and then
        // NRE in `.Name`.
        let rootPath string? = Path.GetPathRoot(Directory.GetCurrentDirectory())
        Assert.False(string.IsNullOrEmpty(rootPath), "could not determine filesystem root")
        let literal = EscapeForGSharpString(rootPath)
        let source = (`
import System.IO

let dir = DirectoryInfo("` + "$literal" + `")
dir.Parent!!.Name
`)
        // Issue #3216 contract decision: `!!` on nil fails with the
        // underlying CLR exception (compiled semantics) — a nil reference
        // receiver surfaces NullReferenceException; the evaluator's
        // 'nil value !!' panic retires with the evaluator (Phase 3c).
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
        Assert.IsType[NullReferenceException](result.UnhandledException)
    }

    shared {
        private func EscapeForGSharpString(s string?) string -> s!!.Replace("\\", "\\\\").Replace("\"", "\\\"")

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
