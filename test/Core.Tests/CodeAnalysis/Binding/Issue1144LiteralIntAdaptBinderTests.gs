// <copyright file="Issue1144LiteralIntAdaptBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #1144: a constant integer literal operand of a binary operator
/// adapts to the OTHER operand's integer type when its value is
/// representable there (C#-style constant-expression conversion). This is
/// local to binary-expression binding: conversions between two TYPED
/// integer operands still require an explicit cast, and an out-of-range
/// literal still errors (never silently wraps).
///
/// The result TYPE of each positive case is asserted indirectly but
/// precisely via the enclosing function's declared return type: if the
/// binary expression did not bind to the expected integer/bool type the
/// implicit `return` conversion would surface a diagnostic.
open class Issue1144LiteralIntAdaptBinderTests {
    // ── Arithmetic: uint32 operand + int literal → uint32 ──────────────
    @Theory
    @InlineData("a + 1")
    @InlineData("a - 1")
    @InlineData("a * 2")
    @InlineData("a / 2")
    @InlineData("a % 2")
    func Arithmetic_UInt32OperandWithIntLiteral_BindsToUInt32(expr string) {
        let source = Wrap("func F(a uint32) uint32 { return " + expr + " }")
        Assert.Empty(Errors(source))
    }

    // ── Bitwise: uint8 operand | int literal → uint8 ───────────────────
    @Theory
    @InlineData("b | 4")
    @InlineData("b & 4")
    @InlineData("b ^ 4")
    func Bitwise_UInt8OperandWithIntLiteral_BindsToUInt8(expr string) {
        let source = Wrap("func F(b uint8) uint8 { return " + expr + " }")
        Assert.Empty(Errors(source))
    }

    // ── Comparison: uint8 operand vs int literal → bool ────────────────
    @Theory
    @InlineData("c == 0")
    @InlineData("c != 0")
    @InlineData("c < 10")
    @InlineData("c >= 1")
    func Comparison_UInt8OperandWithIntLiteral_BindsToBool(expr string) {
        let source = Wrap("func F(c uint8) bool { return " + expr + " }")
        Assert.Empty(Errors(source))
    }

    // ── Literal on the LEFT adapts too ─────────────────────────────────
    @Fact
    func LiteralOnLeft_Arithmetic_BindsToUInt32() {
        let source = Wrap("func F(a uint32) uint32 { return 1 + a }")
        Assert.Empty(Errors(source))
    }

    @Fact
    func LiteralOnLeft_Comparison_BindsToBool() {
        let source = Wrap("func F(c uint8) bool { return 0 == c }")
        Assert.Empty(Errors(source))
    }

    // ── Each of the ten integer target types ───────────────────────────
    @Theory
    @InlineData("int8")
    @InlineData("uint8")
    @InlineData("int16")
    @InlineData("uint16")
    @InlineData("int32")
    @InlineData("uint32")
    @InlineData("int64")
    @InlineData("uint64")
    @InlineData("nint")
    @InlineData("nuint")
    func AllIntegerTargetTypes_LiteralAdapts(type string) {
        let source = Wrap("func F(v " + type + ") " + type + " { return v + 1 }")
        Assert.Empty(Errors(source))
    }

    @Fact
    func Int64Operand_WithIntLiteral_BindsToInt64() {
        let source = Wrap("func F(l int64) int64 { return l + 1 }")
        Assert.Empty(Errors(source))
    }

    // ── Negative cases: must STILL error ───────────────────────────────
    @Fact
    func OutOfRangeLiteral_UInt8_StillErrorsGS0129() {
        let source = Wrap("func F(c uint8) bool { return c == 999 }")
        Assert.Contains(Errors(source), (d Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func NegativeLiteral_NotRepresentableInUInt32_StillErrorsGS0129() {
        let source = Wrap("func F(a uint32) uint32 { return a + -1 }")
        Assert.Contains(Errors(source), (d Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func TwoTypedIntegerOperands_StillErrorsGS0129() {
        // No literal involved, and neither operand widens to the other:
        // int32 + uint32 (neither is an implicit conversion to the other)
        // still requires an explicit cast. Issue #1150 only adds DIRECTIONAL
        // lossless widening (e.g. uint8 + int32), which does not apply here.
        let source = Wrap(`func F(x int32, y uint32) int64 {
        return int64(x + y)
    }`)
        Assert.Contains(Errors(source), (d Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func TypedVariableNarrowing_StillErrorsGS0156() {
        // Proves the general numeric-conversion path still requires a cast for
        // NON-constant narrowing: assigning a (typed int32) parameter value to a
        // uint8 needs an explicit cast and reports GS0156. (Issue #1183 only
        // relaxes this for in-range *constant* expressions; `x` here is not
        // constant, so the narrowing remains an error.)
        let source = Wrap("func F(x int32) { let a uint8 = x }")
        Assert.Contains(Errors(source), (d Diagnostic) -> d.Id == "GS0156")
    }

    @Fact
    func InRangeConstantNarrowing_NowCompiles() {
        // Issue #1183: an in-range *constant* integer expression narrows
        // implicitly (C# §10.2.11), so `let a uint8 = 4` now binds cleanly.
        let source = Wrap("func F() { let a uint8 = 4 }")
        Assert.Empty(Errors(source))
    }

    // ── Regression: pre-existing behaviour preserved ───────────────────
    @Fact
    func TwoIntLiterals_StillBindToInt32() {
        let source = Wrap("func F() int32 { return 1 + 2 }")
        Assert.Empty(Errors(source))
    }

    @Fact
    func ExplicitCastWorkaround_StillCompiles() {
        let source = Wrap("func F(a uint32) uint32 { return a + uint32(1) }")
        Assert.Empty(Errors(source))
    }

    @Fact
    func ShiftWithIntRhs_StillCompiles() {
        let source = Wrap("func F(a uint32) uint32 { return a << 8 }")
        Assert.Empty(Errors(source))
    }

    shared {
        private func Wrap(member string) string {
            return `
package p
class C {
    ` + member + `
}
`
        }

        private func Errors(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation
                .Emit(peStream)
                .Diagnostics
                .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                .ToList()
        }
    }
}
