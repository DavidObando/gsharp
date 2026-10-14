// <copyright file="Issue1232NumericErgonomicsBinderTests.cs" company="GSharp">
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

/// Issue #1232: implicit numeric ergonomics aligning G# with C#.
///
/// (1) Shift-count widening — the RHS of `<<` / `>>` /
/// `<<=` / `>>=` may be any integer that implicitly
/// converts to `int32` (sbyte/byte/short/ushort/char); G# widens it to
/// int32 instead of reporting GS0129. The result type stays the left
/// operand's type. Counts that do NOT implicitly convert to int32
/// (uint32/int64/...) still error, matching C#.
///
/// (2) Value-producing `if` / conditional arms — an in-range constant
/// integer literal arm adapts to the other arm's integer type, so
/// `if cond { someUint32 } else { 0 }` binds without an explicit cast.
///
/// (3) `==` (and comparison) numeric-literal ergonomics — idiomatic
/// comparisons such as `someUint8 == 11` bind via implicit widening +
/// in-range literal adaptation (regression coverage; nullable operands are a
/// deliberate gap tracked by #1236).
open class Issue1232NumericErgonomicsBinderTests {
    // ── (1) Shift-count widening ───────────────────────────────────────
    @Theory
    @InlineData("int8")
    @InlineData("uint8")
    @InlineData("int16")
    @InlineData("uint16")
    func ShiftLeft_NarrowOrderCount_WidensToInt32(countType string) {
        let source = Wrap("func F(value uint32, count " + countType + ") uint32 { return value << count }")
        Assert.Empty(Errors(source))
    }

    @Theory
    @InlineData("int8")
    @InlineData("uint8")
    @InlineData("int16")
    @InlineData("uint16")
    func ShiftRight_NarrowOrderCount_WidensToInt32(countType string) {
        let source = Wrap("func F(value uint32, count " + countType + ") uint32 { return value >> count }")
        Assert.Empty(Errors(source))
    }

    @Fact
    func Shift_CharCount_WidensToInt32() {
        let source = Wrap("func F(value uint32, count char) uint32 { return value << count }")
        Assert.Empty(Errors(source))
    }

    @Fact
    func Shift_SubI4LeftOperand_NarrowCount_Compiles() {
        // The left operand's type is preserved; the count widens to int32.
        let source = Wrap("func F(value uint8, count uint8) uint8 { return value << count }")
        Assert.Empty(Errors(source))
    }

    @Fact
    func CompoundShiftLeft_NarrowCount_WidensToInt32() {
        let source = Wrap(`func F(value uint32, count uint8) uint32 {
        var v = value
        v <<= count
        return v
    }`)
        Assert.Empty(Errors(source))
    }

    @Fact
    func CompoundShiftRight_NarrowCount_WidensToInt32() {
        let source = Wrap(`func F(value uint32, count uint16) uint32 {
        var v = value
        v >>= count
        return v
    }`)
        Assert.Empty(Errors(source))
    }

    // Counts that do NOT implicitly convert to int32 still error (C# also
    // rejects a uint/long/... shift count).
    @Theory
    @InlineData("uint32")
    @InlineData("int64")
    @InlineData("uint64")
    func Shift_NonWideningCount_StillErrorsGS0129(countType string) {
        let source = Wrap("func F(value uint32, count " + countType + ") uint32 { return value << count }")
        Assert.Contains(Errors(source), (d Diagnostic) -> d.Id == "GS0129")
    }

    // ── (2) Value-producing if / conditional arms ──────────────────────
    @Fact
    func ValueIf_Uint32ThenZeroElse_AdaptsLiteralArm() {
        let source = Wrap("func F(cond bool, u uint32) uint32 { return if cond { u } else { 0 } }")
        Assert.Empty(Errors(source))
    }

    @Fact
    func ValueIf_ZeroThenUint32Else_AdaptsLiteralArm() {
        let source = Wrap("func F(cond bool, u uint32) uint32 { return if cond { 0 } else { u } }")
        Assert.Empty(Errors(source))
    }

    @Fact
    func Ternary_Uint32AndZero_AdaptsLiteralArm() {
        let source = Wrap("func F(cond bool, u uint32) uint32 { return cond ? u : 0 }")
        Assert.Empty(Errors(source))
    }

    @Theory
    @InlineData("uint8")
    @InlineData("int16")
    @InlineData("uint16")
    @InlineData("uint64")
    func ValueIf_LiteralArm_AdaptsAcrossIntegerTypes(type string) {
        let source = Wrap("func F(cond bool, v " + type + ") " + type + " { return if cond { v } else { 0 } }")
        Assert.Empty(Errors(source))
    }

    @Fact
    func ValueIf_TypedArmsThatWiden_StillUnify() {
        // Directional widening across typed arms (uint16 widens to uint32).
        let source = Wrap("func F(cond bool, a uint16, b uint32) uint32 { return if cond { a } else { b } }")
        Assert.Empty(Errors(source))
    }

    @Fact
    func ValueIf_OutOfRangeLiteralArm_StillErrors() {
        // 999 is not representable in uint8, so it is NOT silently adapted. The
        // arms unify to int32 (uint8 widens to int32, like C#'s common type),
        // and returning that int32 where uint8 is expected still errors — the
        // out-of-range literal never wraps.
        let source = Wrap("func F(cond bool, v uint8) uint8 { return if cond { v } else { 999 } }")
        Assert.NotEmpty(Errors(source))
    }

    // ── (3) == / comparison numeric-literal ergonomics ─────────────────
    @Theory
    @InlineData("c == 11")
    @InlineData("c != 11")
    @InlineData("c < 11")
    @InlineData("c >= 11")
    func Comparison_Uint8WithIntLiteral_Compiles(expr string) {
        let source = Wrap("func F(c uint8) bool { return " + expr + " }")
        Assert.Empty(Errors(source))
    }

    @Fact
    func Equality_Uint32WithZeroLiteral_Compiles() {
        let source = Wrap("func F(u uint32) bool { return u == 0 }")
        Assert.Empty(Errors(source))
    }

    @Fact
    func Equality_MixedWidthNonNullable_WidensImplicitly() {
        let source = Wrap("func F(a uint16, b uint32) bool { return a == b }")
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
