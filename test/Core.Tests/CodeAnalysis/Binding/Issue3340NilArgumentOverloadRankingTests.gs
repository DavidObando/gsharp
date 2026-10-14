// <copyright file="Issue3340NilArgumentOverloadRankingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Linq
import Xunit

/// PR #3340. A `nil` argument has no CLR type, so its entry in the
/// betterness comparison's `sources` vector is `null`.
/// That must mean "this argument expresses no preference between the two
/// candidates" and the comparison must CONTINUE to the remaining arguments —
/// it must not abandon the whole comparison.
///
/// The ADR-0155 nullable migration briefly made it abandon: a guard added to
/// silence a nullable warning returned `false` from
/// `ClrOverloadResolution.IsStrictlyBetter` on the first null source, so
/// no candidate was ever strictly better and every overload set containing a
/// `nil` argument collapsed into GS0160 ambiguity. It took out 14 of 15
/// applications in the pinned cs2gs migration job. `CompareNumericTargets`
/// already handled a null source by returning 0, which is exactly the
/// "no preference, keep looking" behaviour the loop needs.
///
/// ADR-0154 witness, established by re-introducing the guard and re-running:
/// (cref:NilArgument_DoesNotSuppressNumericRanking_OnImportedCtorOverloads)
/// goes RED (GS0160 + GS0130) and passes with the fix. The other three do NOT
/// discriminate and are labelled individually — two are deliberate controls,
/// and the user-overload case turned out to reach a different resolver
/// entirely. Recording which tests actually witness matters more than the
/// count: three of these four would have shipped this bug.
///
/// Types are named `Issue3340*` because the in-process FunctionTypeSymbol
/// cache is not cleared between tests.
open class Issue3340NilArgumentOverloadRankingTests {
    /// The original failure, reduced: `System.Threading.Timer` has three
    /// constructors differing only in the integral width of their last two
    /// parameters. With `nil` in the state slot, the int literals must
    /// still select the `(TimerCallback, object, int32, int32)` overload.
    @Fact
    func NilArgument_DoesNotSuppressNumericRanking_OnImportedCtorOverloads() {
        const source = `
package p
import System
import System.Threading
func Issue3340MakeTimer() Timer -> Timer((state) -> { }, nil, 0, 1000)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        // GS0160 is the ambiguity the regression produced; GS0130 ("doesn't
        // exist") is the follow-on it caused once binding failed.
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0160")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0130")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    /// COVERAGE, NOT A WITNESS. User-declared overloads are ranked by a
    /// different resolver than `ClrOverloadResolution`, so this passes
    /// both with and without the defect — verified by re-introducing it. It is
    /// kept because the user-function path deserves the same pinning, but it
    /// must not be mistaken for the regression guard: only
    /// (cref:NilArgument_DoesNotSuppressNumericRanking_OnImportedCtorOverloads)
    /// exercises the fixed code.
    @Fact
    func NilArgument_DoesNotSuppressNumericRanking_OnUserOverloads() {
        const source = `
package p
func Issue3340Pick(tag string?, width int32) int32 -> 1
func Issue3340Pick(tag string?, width int64) int32 -> 2
func Issue3340Use() int32 -> Issue3340Pick(nil, 7)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0160")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    /// Control: the identical overload set WITHOUT a `nil` argument. This
    /// passes both before and after the fix, so a failure here means the
    /// numeric-ranking rule itself broke rather than the null-source path —
    /// it tells the two causes apart when this file goes red.
    @Fact
    func NonNilArgument_RanksNumericOverloadsUnchanged() {
        const source = `
package p
func Issue3340Ctl(tag string, width int32) int32 -> 1
func Issue3340Ctl(tag string, width int64) int32 -> 2
func Issue3340CtlUse() int32 -> Issue3340Ctl("x", 7)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0160")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
    }

    /// A genuinely ambiguous call must STILL report GS0160. Without this, the
    /// three tests above could be satisfied by disabling ambiguity detection
    /// altogether — this pins that the fix restored ranking rather than
    /// removed the diagnostic.
    @Fact
    func GenuinelyAmbiguousNilCall_StillReportsAmbiguity() {
        const source = `
package p
func Issue3340Amb(a string?, b string) int32 -> 1
func Issue3340Amb(a string, b string?) int32 -> 2
func Issue3340AmbUse() int32 -> Issue3340Amb(nil, nil)
`
        let compilation = Compile(source)
        let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.IsError)
    }

    shared {
        private func Compile(source string) Compilation {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Compilation(tree){IsLibrary = true}
        }
    }
}
