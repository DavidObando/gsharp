// <copyright file="Issue1281ImplicitNumericCallSiteBinderTests.cs" company="GSharp">
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

/// Issue #1281: implicit numeric promotion at call sites.
///
/// G# already applies the implicit lossless-widening lattice (ADR-0044) at
/// call sites for both fixed parameters and generic inference. This adds the
/// remaining C# §10.2.11 rule: a <b>constant</b> integer argument whose value
/// fits a narrower / cross-sign integer parameter converts implicitly with no
/// cast — exactly as at a declaration target (ADR-0129). Non-constant
/// narrowing/cross-sign arguments and out-of-range constants stay an error.
open class Issue1281ImplicitNumericCallSiteBinderTests {
    // ── In-range constant argument narrows implicitly (fixed param) ────
    @Theory
    @InlineData("uint16", "5")
    @InlineData("uint16", "65535")
    @InlineData("uint16", "0")
    @InlineData("uint32", "5")
    @InlineData("uint32", "4294967295")
    @InlineData("uint8", "200")
    @InlineData("int16", "100")
    @InlineData("int16", "-30000")
    @InlineData("int8", "-5")
    func InRangeConstantArgument_NarrowsImplicitly(paramType string, value string) {
        let source = `
package p
func Take(x ` + paramType + ") { }\nfunc Use() { Take(" + value + ") }\n"
        Assert.Empty(Errors(source))
    }

    @Fact
    func InRangeConstantArgument_UnaryNegated_NarrowsImplicitly() {
        let source = `
package p
func Take(x int16) { }
func Use() { Take(-100) }
`
        Assert.Empty(Errors(source))
    }

    // ── Constructor / ctor-chaining argument narrows implicitly ────────
    @Fact
    func InRangeConstantArgument_ConstructorCall_NarrowsImplicitly() {
        let source = `
package p
class Box(value uint16) { }
func Use() { let b = Box(42) }
`
        Assert.Empty(Errors(source))
    }

    // ── Generic user function with a constant-narrowing argument ────────
    @Fact
    func GenericUserFunction_ConstantArgument_UnifiesWithNarrowerArg() {
        // `tag` fixes T = uint16; the constant `5` then narrows to uint16.
        let source = `
package p
func Pick[T](a T, b T) T { return a }
func Use(tag uint16) uint16 { return Pick(tag, 5) }
`
        Assert.Empty(Errors(source))
    }

    // ── Out-of-range / negative constant argument STILL errors ─────────
    @Theory
    @InlineData("uint16", "70000")
    @InlineData("uint16", "-1")
    @InlineData("uint8", "300")
    @InlineData("uint32", "-1")
    @InlineData("int8", "200")
    func OutOfRangeConstantArgument_StillErrors(paramType string, value string) {
        let source = `
package p
func Take(x ` + paramType + ") { }\nfunc Use() { Take(" + value + ") }\n"
        Assert.Contains(Errors(source), (d Diagnostic) -> d.Id == "GS0154")
    }

    // ── Non-constant narrowing / cross-sign argument STILL errors ──────
    @Fact
    func NonConstantNarrowingArgument_RequiresCast_Errors() {
        let source = `
package p
func Take(x uint16) { }
func Use(n int32) { Take(n) }
`
        Assert.Contains(Errors(source), (d Diagnostic) -> d.Id == "GS0154")
    }

    @Fact
    func NonConstantCrossSignArgument_RequiresCast_Errors() {
        let source = `
package p
func Take(x uint32) { }
func Use(n int32) { Take(n) }
`
        Assert.Contains(Errors(source), (d Diagnostic) -> d.Id == "GS0154")
    }

    // ── Non-constant lossless widening argument is implicit (regression)─
    @Theory
    @InlineData("int32", "int64")
    @InlineData("uint16", "int32")
    @InlineData("uint8", "int32")
    @InlineData("uint16", "uint32")
    func NonConstantWideningArgument_IsImplicit(from string, to string) {
        let source = `
package p
func Take(x ` + to + ") { }\nfunc Use(n " + from + ") { Take(n) }\n"
        Assert.Empty(Errors(source))
    }

    shared {
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
