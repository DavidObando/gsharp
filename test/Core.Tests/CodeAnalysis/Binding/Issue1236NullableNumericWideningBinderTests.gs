// <copyright file="Issue1236NullableNumericWideningBinderTests.cs" company="GSharp">
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

/// Issue #1236: a lifted (nullable) binary operator must honour the same
/// implicit lossless integer-widening lattice and constant-integer-literal
/// adaptation as its non-nullable counterpart, operating on the underlying
/// numeric types and re-wrapping the result nullability. Previously a lifted
/// operator only bound when both operands shared the same underlying numeric
/// type, so e.g. `uint8? == 11` and `uint8? == int32` failed with
/// GS0129 even though their non-nullable forms compile. Guardrails (out-of-range
/// literals, non-widening mixed pairs) still error in BOTH nullable and
/// non-nullable forms.
open class Issue1236NullableNumericWideningBinderTests {
    // ── Constant integer-literal adaptation against a nullable operand ──
    @Theory
    @InlineData("b uint8?", "b == 11")
    @InlineData("b int64?", "b == 11")
    @InlineData("b uint8?", "b != 11")
    @InlineData("b int64?", "b < 11")
    func LiftedLiteralAdaptation_Binds(parms string, expr string) {
        let source = Wrap("func F($parms) bool { return $expr }")
        Assert.Empty(Errors(source))
    }

    @Fact
    func LiftedLiteralArithmeticAdaptation_Binds() {
        // literal 11 (int32) adapts to int64; binds at int64 lifted -> int64?.
        let source = Wrap("func F(b int64?) int64? { return b + 11 }")
        Assert.Empty(Errors(source))
    }

    // ── Directional widening between nullable / mixed operands ─────────
    @Theory
    @InlineData("a uint8?, b int32", "a == b")
    @InlineData("a uint8?, b int32?", "a == b")
    @InlineData("a uint8, b int32?", "a == b")
    @InlineData("a uint8?, b int32?", "a < b")
    @InlineData("a uint32?, b int64?", "a + b == 0")
    func LiftedDirectionalWidening_Binds(parms string, expr string) {
        let source = Wrap("func F($parms) bool { return $expr }")
        Assert.Empty(Errors(source))
    }

    @Fact
    func LiftedArithmeticWidening_ProducesNullableResult() {
        let source = Wrap("func F(a int64?, b int32?) int64? { return a + b }")
        Assert.Empty(Errors(source))
    }

    // ── Existing behaviour preserved ───────────────────────────────────
    @Fact
    func LiftedSameUnderlying_StillBinds() {
        let source = Wrap("func F(a int32?) bool { return a == 11 }")
        Assert.Empty(Errors(source))
    }

    // ── Guardrails: out-of-range / non-widening still error ────────────
    @Fact
    func LiftedLiteralOutOfRange_StillErrors() {
        // 300 is out of range for uint8; an explicit cast is still required.
        let source = Wrap("func F(b uint8?) bool { return b == 300 }")
        Assert.NotEmpty(Errors(source))
    }

    @Fact
    func LiftedNonWideningPair_UInt32VsInt32_StillErrorsGS0129() {
        // Neither uint32 nor int32 implicitly converts to the other, so the
        // lifted operator stays unbound — consistent with the non-nullable form.
        let source = Wrap("func F(a uint32?, b int32?) bool { return a == b }")
        Assert.Contains(Errors(source), (d Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func NonNullableNonWideningPair_UInt32VsInt32_StillErrorsGS0129() {
        let source = Wrap("func F(a uint32, b int32) bool { return a == b }")
        Assert.Contains(Errors(source), (d Diagnostic) -> d.Id == "GS0129")
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
