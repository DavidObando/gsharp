// <copyright file="Issue2890SwitchSelectEscapingBranchFlowTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import Xunit

/// Issue #2890: definite-return CFG must model pattern-switch and select arms
/// as alternatives while preserving branches that escape those arms.
open class Issue2890SwitchSelectEscapingBranchFlowTests {
    @Fact
    func BreakOutOfPatternSwitchArm_ExitsSwitchAndBindsClean() {
        const Source = `package Issue2890.SwitchBreak

func F(x int32) int32 {
    for {
        switch x {
            default { break }
        }
    }
}`
        AssertBindsClean(Source)
    }

    @Fact
    func BreakOutOfSelectDefaultArm_ExitsSelectAndBindsClean() {
        const Source = `package Issue2890.SelectBreak

func F() int32 {
    for {
        select {
            default { break }
        }
    }
}`
        AssertBindsClean(Source)
    }

    @Fact
    func BreakOutOfRealSelectArm_ExitsSelectAndBindsClean() {
        const Source = `package Issue2890.SelectRealBreak

func F() int32 {
    let ch = chan[int32](1)
    for {
        select {
            case ch <- 1 { break }
            case <-ch { continue }
            default { continue }
        }
    }
}`
        AssertBindsClean(Source)
    }

    @Fact
    func BreakOutOfNestedPatternSwitchArm_ExitsInnerSwitchAndBindsClean() {
        const Source = `package Issue2890.NestedSwitchBreak

func F(x int32, y int32) int32 {
    for {
        switch x {
            case 1 {
                switch y {
                    default { break }
                }
            }
            default { continue }
        }
    }
}`
        AssertBindsClean(Source)
    }

    @Fact
    func LabeledBreakOutOfPatternSwitchArm_ReportsGs0100() {
        const Source = `package Issue2890.LabeledSwitchBreak

func F(x int32) int32 {
    outer: for {
        for {
            switch x {
                default { break outer }
            }
        }
    }
}`
        AssertOnlyGs0100(Source)
    }

    @Fact
    func GotoOutOfPatternSwitchArm_ReportsGs0100() {
        const Source = `package Issue2890.SwitchGoto

func F(x int32) int32 {
    switch x {
        case 1 { goto done }
        default { return 1 }
    }
    return 2
done:
    var reached = true
}`
        AssertOnlyGs0100(Source)
    }

    @Fact
    func GotoOutOfSelectArm_ReportsGs0100() {
        const Source = `package Issue2890.SelectGoto

func F() int32 {
    select {
        default { goto done }
    }
    return 1
done:
    var reached = true
}`
        AssertOnlyGs0100(Source)
    }

    @Fact
    func PatternSwitchInsideFixedBreak_ExitsSwitchAndBindsClean() {
        const Source = `package Issue2890.SwitchFixedBreak

func F(x int32, xs []int32) int32 {
    unsafe {
        for {
            fixed p *int32 = xs {
                switch x {
                    default { break }
                }
            }
        }
    }
}`
        AssertBindsClean(Source)
    }

    @Fact
    func PatternSwitchInsideScopeBreak_ExitsSwitchAndBindsClean() {
        const Source = `package Issue2890.SwitchScopeBreak

func F(x int32) int32 {
    for {
        scope {
            switch x {
                default { break }
            }
        }
    }
}`
        AssertBindsClean(Source)
    }

    @Fact
    func LiteralSwitchWithoutDefault_DoesNotReportGs0100() {
        const Source = `package Issue2890.LiteralNoDefault

func F() int32 {
    switch 1 {
        case 1 { return 10 }
        case 2 { return 20 }
    }
}`
        AssertNoErrors(Source)
    }

    @Fact
    func ImpossibleLiteralArmBreak_DoesNotReportGs0100() {
        const Source = `package Issue2890.ImpossibleLiteralBreak

func F() int32 {
    for {
        switch 1 {
            case 2 { break }
        }
    }
}`
        AssertNoErrors(Source)
    }

    @Fact
    func FalseGuardArmBreak_ExitsSwitchAndBindsClean() {
        const Source = `package Issue2890.FalseGuardBreak

func F(x int32) int32 {
    for {
        switch x {
            case _ when false { break }
            default { return 1 }
        }
    }
}`
        AssertBindsClean(Source)
    }

    @Fact
    func CompletingSwitchArmDoesNotFallThroughToDefault_ReportsGs0100() {
        const Source = `package Issue2890.SwitchArmCompletion

func F(x int32) int32 {
    switch x {
        case 1 { }
        default { return 1 }
    }
}`
        AssertOnlyGs0100(Source)
    }

    @Fact
    func CompletingSelectArmDoesNotFallThroughToDefault_ReportsGs0100() {
        const Source = `package Issue2890.SelectArmCompletion

func F() int32 {
    let ch = chan[int32](1)
    select {
        case ch <- 1 { }
        default { return 1 }
    }
}`
        AssertOnlyGs0100(Source)
    }

    @Fact
    func SelectWhoseEveryArmReturns_DoesNotReportGs0100() {
        const Source = `package Issue2890.SelectReturns

func F() int32 {
    let ch = chan[int32](1)
    select {
        case ch <- 1 { return 1 }
        case <-ch { return 2 }
        default { return 3 }
    }
}`
        AssertNoErrors(Source)
    }

    @Fact
    func SelectWithoutDefaultWhoseEveryArmReturns_DoesNotReportGs0100() {
        const Source = `package Issue2890.SelectNoDefaultReturns

func F() int32 {
    let ch = chan[int32](1)
    select {
        case ch <- 1 { return 1 }
        case <-ch { return 2 }
    }
}`
        AssertNoErrors(Source)
    }

    @Fact
    func SelectWhoseEveryArmThrows_DoesNotReportGs0100() {
        const Source = `package Issue2890.SelectThrows
import System

func F() int32 {
    let ch = chan[int32](1)
    select {
        case ch <- 1 { throw Exception() }
        case <-ch { throw Exception() }
        default { throw Exception() }
    }
}`
        AssertNoErrors(Source)
    }

    @Fact
    func TotalDiscardSwitchWhoseArmReturns_DoesNotReportGs0100() {
        const Source = `package Issue2890.DiscardReturns

func F(x int32) int32 {
    switch x {
        case _ { return 1 }
    }
}`
        AssertNoErrors(Source)
    }

    @Fact
    func SwitchArmContainingReturningSelect_DoesNotReportGs0100() {
        const Source = `package Issue2890.SwitchSelectReturns

func F(x int32) int32 {
    let ch = chan[int32](1)
    switch x {
        case 1 {
            select {
                case ch <- 1 { return 1 }
                default { return 2 }
            }
        }
        default { return 3 }
    }
}`
        AssertNoErrors(Source)
    }

    @Fact
    func LiteralSwitchImpossibleEscapingArms_ExitSwitchAndBindClean() {
        const Source = `package Issue2890.LiteralSwitch

func F() int32 {
    for {
        switch 1 {
            case 2 { break }
            case > 5 { break }
            default { return 1 }
        }
    }
}`
        AssertBindsClean(Source)
    }

    @Fact
    func PatternSwitchWhoseEveryArmReturns_RemainsValid() {
        const Source = `package Issue2890.SwitchReturnsGuard

func F(x int32) int32 {
    switch x {
        case 1 { return 1 }
        default { return 2 }
    }
}`
        AssertNoErrors(Source)
    }

    @Fact
    func CompletingSwitchArmFollowedByReturn_RemainsValid() {
        const Source = `package Issue2890.SwitchThenReturnGuard

func F(x int32) int32 {
    switch x {
        case 1 { }
        default { return 1 }
    }

    return 2
}`
        AssertNoErrors(Source)
    }

    @Fact
    func TypePatternSwitchWhoseEveryArmReturns_RemainsValid() {
        const Source = `package Issue2890.TypePatternGuard

func F(value object) int32 {
    switch value {
        case _ is string { return 1 }
        default { return 2 }
    }
}`
        AssertNoErrors(Source)
    }

    shared {
        // Issue #3501 A3: an unlabeled `break` inside a switch/select arm now
        // exits the switch/select (Go/C# alignment), so the enclosing infinite
        // `for` never terminates and the function binds clean — the shapes above
        // stopped being GS0100 escapes. Labeled break still targets the loop and
        // keeps its GS0100 coverage (see the Labeled* tests).
        private func AssertBindsClean(source string) {
            let (result, _) = Compile(source)
            Assert.Empty(result.Diagnostics.Where((candidate Diagnostic) -> candidate.IsError))
            Assert.True(result.Success)
        }

        private func AssertOnlyGs0100(source string) {
            let (result, emittedLength) = Compile(source)
            let diagnostic = Assert.Single(result.Diagnostics.Where((candidate Diagnostic) -> candidate.IsError))
            let expectedStart = source.IndexOf("F(", StringComparison.Ordinal)
            Assert.False(result.Success)
            Assert.Equal("GS0100", diagnostic.Id)
            Assert.Equal(expectedStart, diagnostic.Location.Span.Start)
            Assert.Equal(1, diagnostic.Location.Span.Length)
            Assert.Equal("F", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
            Assert.Equal(int64(0), emittedLength)
        }

        private func AssertNoErrors(source string) {
            let (result, emittedLength) = Compile(source)
            Assert.True(
                result.Success,
                string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.ToString())
                )
            )
            Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
            Assert.True(emittedLength > int64(0))
        }

        private func Compile(source string)(Result EmitResult, EmittedLength int64) {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            return (result, peStream.Length)
        }
    }
}
