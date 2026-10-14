// <copyright file="Issue1157SwitchCaseLiteralAdaptationTests.cs" company="GSharp">
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

/// Issue #1157: a constant integer LITERAL case label adapts to a narrow /
/// unsigned governing (discriminant) type when its value is representable
/// there — the switch-case-label analogue of the binary-operator constant
/// adaptation restored by #1144. A label that does NOT fit the governing
/// type still errors with GS0171, and non-integer discriminants (string,
/// enum) are unaffected.
open class Issue1157SwitchCaseLiteralAdaptationTests {
    // ── The exact repro: switch-EXPRESSION over uint8 ──────────────────
    @Fact
    func SwitchExpression_UInt8_LiteralLabelsAdapt_NoDiagnostics() {
        let source = Wrap(`func F(b uint8) int32 {
        return switch b {
            case 0: 10
            case 1: 20
            default: 30
        }
    }`)
        Assert.Empty(Errors(source))
    }

    // ── switch-STATEMENT over uint8 routes through the same path ────────
    @Fact
    func SwitchStatement_UInt8_LiteralLabelsAdapt_NoDiagnostics() {
        let source = Wrap(`func F(b uint8) {
        switch b {
            case 0 { var a = 1 }
            case 1 { var c = 2 }
            default { var d = 3 }
        }
    }`)
        Assert.Empty(Errors(source))
    }

    // ── Other narrow / unsigned governing types ────────────────────────
    @Theory
    @InlineData("uint8", "0", "1")
    @InlineData("uint16", "0", "1000")
    @InlineData("int16", "0", "100")
    @InlineData("int8", "0", "100")
    @InlineData("uint32", "0", "40000")
    @InlineData("uint64", "0", "1")
    func SwitchExpression_NarrowGoverningType_FittingLabels_NoDiagnostics(type string, a string, b string) {
        let source = Wrap("func F(v " + type + `) int32 {
        return switch v {
            case ` + a + ": 10\n            case " + b + `: 20
            default: 30
        }
    }`)
        Assert.Empty(Errors(source))
    }

    // ── Negative literal fits int8 but not uint8 ───────────────────────
    @Fact
    func SwitchExpression_Int8_NegativeLiteralFits_NoDiagnostics() {
        let source = Wrap(`func F(v int8) int32 {
        return switch v {
            case -1: 10
            default: 30
        }
    }`)
        Assert.Empty(Errors(source))
    }

    @Fact
    func SwitchExpression_UInt8_NegativeLiteralDoesNotFit_GS0171() {
        let source = Wrap(`func F(v uint8) int32 {
        return switch v {
            case -1: 10
            default: 30
        }
    }`)
        Assert.Contains(Errors(source), (d Diagnostic) -> d.Id == "GS0171")
    }

    // ── Out-of-range label still errors ────────────────────────────────
    @Fact
    func SwitchExpression_UInt8_OutOfRangeLiteral_StillErrorsGS0171() {
        let source = Wrap(`func F(b uint8) int32 {
        return switch b {
            case 300: 10
            default: 30
        }
    }`)
        Assert.Contains(Errors(source), (d Diagnostic) -> d.Id == "GS0171")
    }

    // ── Nullable discriminant adapts to underlying then widens ─────────
    @Fact
    func SwitchExpression_NullableUInt8_LiteralLabelAdapts_NoDiagnostics() {
        let source = Wrap(`func F(b uint8?) int32 {
        return switch b {
            case 0: 10
            case 1: 20
            default: 30
        }
    }`)
        Assert.Empty(Errors(source))
    }

    // ── Non-integer discriminants unaffected ───────────────────────────
    @Fact
    func SwitchExpression_String_LiteralLabel_StillWorks() {
        let source = Wrap(`func F(s string) int32 {
        return switch s {
            case "hi": 10
            case "bye": 20
            default: 30
        }
    }`)
        Assert.Empty(Errors(source))
    }

    @Fact
    func SwitchExpression_Enum_StillWorks() {
        let source = `
package p
enum Color { Red, Green, Blue }
class C {
    func F(c Color) int32 {
        return switch c {
            case Color.Red: 10
            case Color.Green: 20
            default: 30
        }
    }
}
`
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
