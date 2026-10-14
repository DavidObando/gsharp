// <copyright file="Issue1246CompoundAssignWideningBinderTests.cs" company="GSharp">
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

/// Issue #1246: a compound assignment `lhs op= rhs` must apply the SAME
/// implicit lossless numeric widening (and constant-integer-literal adaptation)
/// to the right operand that the binary operator `lhs op rhs` applies, then
/// convert the result back to the LHS type for the store. Before the fix the
/// underlying operator was bound against the RAW operand types, so
/// `int32 += uint8` failed GS0129 even though `a = a + b` compiled.
///
/// The non-widening direction (LHS strictly narrower than the result, e.g.
/// `uint8 += int32`) must STILL be rejected, exactly as
/// `u = u + i` is — the final assignment conversion back to the LHS type
/// guards against silent narrowing.
open class Issue1246CompoundAssignWideningBinderTests {
    // ── Positive: RHS widens into the LHS integer type ─────────────────
    @Theory
    @InlineData("int32", "uint8")
    @InlineData("int32", "int8")
    @InlineData("int32", "uint16")
    @InlineData("int32", "int16")
    @InlineData("int64", "int32")
    @InlineData("int64", "uint16")
    @InlineData("int64", "uint32")
    @InlineData("int16", "uint8")
    func PlusEquals_RhsWidensToLhs_NoDiagnostics(lhs string, rhs string) {
        let source = CompoundBody("+=", lhs, rhs)
        Assert.Empty(Errors(source))
    }

    @Theory
    @InlineData("+=")
    @InlineData("-=")
    @InlineData("*=")
    @InlineData("/=")
    @InlineData("%=")
    @InlineData("&=")
    @InlineData("|=")
    @InlineData("^=")
    func AllArithmeticAndBitwiseCompound_Int64WithInt32_NoDiagnostics(op string) {
        let source = CompoundBody(op, "int64", "int32")
        Assert.Empty(Errors(source))
    }

    @Theory
    @InlineData("<<=")
    @InlineData(">>=")
    func ShiftCompound_Int64WithInt32_NoDiagnostics(op string) {
        let source = CompoundBody(op, "int64", "int32")
        Assert.Empty(Errors(source))
    }

    // ── Positive: untyped constant integer literal adapts to the LHS ───
    @Fact
    func Int64PlusEqualsIntLiteral_NoDiagnostics() {
        let source = Wrap(`func F() int64 {
        var x int64 = 0
        x += 1
        return x
    }`)
        Assert.Empty(Errors(source))
    }

    @Fact
    func UInt8PlusEqualsInRangeLiteral_NoDiagnostics() {
        let source = Wrap(`func F() uint8 {
        var u uint8 = 0
        u += 5
        return u
    }`)
        Assert.Empty(Errors(source))
    }

    // ── Negative: narrowing direction stays an error (C# semantics) ────
    @Fact
    func UInt8PlusEqualsInt32_StillErrors() {
        // Mirrors `u = u + i`, whose result int32 does not implicitly convert
        // back to uint8 — a cast would be required.
        let source = Wrap(`func F() uint8 {
        var u uint8 = 0
        var i int32 = 300
        u += i
        return u
    }`)
        Assert.NotEmpty(Errors(source))
    }

    @Fact
    func UInt8PlusEqualsOutOfRangeLiteral_StillErrors() {
        let source = Wrap(`func F() uint8 {
        var u uint8 = 0
        u += 300
        return u
    }`)
        Assert.NotEmpty(Errors(source))
    }

    @Fact
    func Int32PlusEqualsUInt32_NeitherWidens_StillErrors() {
        // int32 and uint32 are mutually non-implicit, so neither operand
        // widens to the other — consistent with the binary `a + b` behaviour.
        let source = Wrap(`func F() int32 {
        var a int32 = 0
        var b uint32 = 3
        a += b
        return a
    }`)
        Assert.NotEmpty(Errors(source))
    }

    shared {
        private func CompoundBody(op string, lhs string, rhs string) string {
            return Wrap(
                "func F() " +
                    lhs +
                    " {\n        var a " +
                    lhs +
                    " = 1\n        var b " +
                    rhs +
                    " = 1\n        a " +
                    op +
                    ` b
        return a
    }`
            )
        }

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
