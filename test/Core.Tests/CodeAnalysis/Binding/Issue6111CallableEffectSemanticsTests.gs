// <copyright file="Issue6111CallableEffectSemanticsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Text
import Xunit

open class Issue6111CallableEffectSemanticsTests {
    @Fact
    func ClosureCallChain_CapturedWriteInLeaf_InvalidatesNarrowing() {
        let sb = StringBuilder()
        sb.AppendLine("func Run(initial string?) int32 {")
        sb.AppendLine("    var value = initial")
        sb.AppendLine("    if value != nil {")
        sb.AppendLine("        let _ = {")
        sb.AppendLine("            let helper0 () -> int32 = func() int32 {")
        sb.AppendLine("                value = nil")
        sb.AppendLine("                return 0")
        sb.AppendLine("            }")
        for var i = 1; i < 64; i++ {
            sb.AppendLine("            let helper${i} () -> int32 = func() int32 { return helper${i - 1}() }")
        }
        sb.AppendLine("            helper63()")
        sb.AppendLine("        }")
        sb.AppendLine("        return value.Length")
        sb.AppendLine("    }")
        sb.AppendLine("    return 0")
        sb.AppendLine("}")
        sb.AppendLine("Run(\"ok\")")
        let result = EmittedOracle.Evaluate(sb.ToString())
        AssertContainsError(result, "GS0158")
    }

    @Fact
    func ClosureCallChain_PureLeaf_PreservesNarrowingEvenWithUncalledMutatingClosure() {
        let sb = StringBuilder()
        sb.AppendLine("func Run(initial string?, flag bool) int32 {")
        sb.AppendLine("    var value = initial")
        sb.AppendLine("    let _ = () -> { if flag { value = nil } }")
        sb.AppendLine("    var offset = 1")
        sb.AppendLine("    if value != nil {")
        sb.AppendLine("        let _ = {")
        sb.AppendLine("            let helper0 () -> int32 = func() int32 { return offset }")
        for var i = 1; i < 64; i++ {
            sb.AppendLine("            let helper${i} () -> int32 = func() int32 { return helper${i - 1}() }")
        }
        sb.AppendLine("            helper63()")
        sb.AppendLine("        }")
        sb.AppendLine("        return value.Length")
        sb.AppendLine("    }")
        sb.AppendLine("    return 0")
        sb.AppendLine("}")
        sb.AppendLine("Run(\"ok\", false)")
        let result = EmittedOracle.Evaluate(sb.ToString())
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ArgumentDependentEffect_PureCallbackPreserves_MutatingCallbackInvalidates() {
        let pure = EmittedOracle.Evaluate(`
func Run(initial string?, flag bool) int32 {
    var value = initial
    let _ = () -> { if flag { value = nil } }
    if value != nil {
        let _ = {
            let apply ((() -> void) -> int32) = func(cb () -> void) int32 {
                cb()
                return 0
            }
            apply(() -> {})
        }
        return value.Length
    }
    return 0
}
Run("ok", false)
`)
        Assert.Empty(pure.Diagnostics)

        let mutating = EmittedOracle.Evaluate(`
func Run(initial string?, flag bool) int32 {
    var value = initial
    let _ = () -> { if flag { value = nil } }
    if value != nil {
        let _ = {
            let apply ((() -> void) -> int32) = func(cb () -> void) int32 {
                cb()
                return 0
            }
            apply(() -> { value = nil })
        }
        return value.Length
    }
    return 0
}
Run("ok", false)
`)
        AssertContainsError(mutating, "GS0158")
    }

    @Fact
    func ArgumentDependentEffect_DeepCallbackChain_PropagatesCapturedWrite() {
        let pureSb = StringBuilder()
        pureSb.AppendLine("func Run(initial string?, flag bool) int32 {")
        pureSb.AppendLine("    var value = initial")
        pureSb.AppendLine("    let _ = () -> { if flag { value = nil } }")
        pureSb.AppendLine("    if value != nil {")
        pureSb.AppendLine("        let _ = {")
        pureSb.AppendLine("            let apply0 ((() -> void) -> int32) = func(cb () -> void) int32 {")
        pureSb.AppendLine("                cb()")
        pureSb.AppendLine("                return 0")
        pureSb.AppendLine("            }")
        for var i = 1; i < 64; i++ {
            pureSb.AppendLine(
                "            let apply${i} ((() -> void) -> int32) = func(cb () -> void) int32 { return apply${i - 1}(cb) }"
            )
        }
        pureSb.AppendLine("            apply63(() -> {})")
        pureSb.AppendLine("        }")
        pureSb.AppendLine("        return value.Length")
        pureSb.AppendLine("    }")
        pureSb.AppendLine("    return 0")
        pureSb.AppendLine("}")
        pureSb.AppendLine("Run(\"ok\", false)")
        Assert.Empty(EmittedOracle.Evaluate(pureSb.ToString()).Diagnostics)

        let mutatingSb = StringBuilder()
        mutatingSb.AppendLine("func Run(initial string?, flag bool) int32 {")
        mutatingSb.AppendLine("    var value = initial")
        mutatingSb.AppendLine("    let _ = () -> { if flag { value = nil } }")
        mutatingSb.AppendLine("    if value != nil {")
        mutatingSb.AppendLine("        let _ = {")
        mutatingSb.AppendLine("            let apply0 ((() -> void) -> int32) = func(cb () -> void) int32 {")
        mutatingSb.AppendLine("                cb()")
        mutatingSb.AppendLine("                return 0")
        mutatingSb.AppendLine("            }")
        for var i = 1; i < 64; i++ {
            mutatingSb.AppendLine(
                "            let apply${i} ((() -> void) -> int32) = func(cb () -> void) int32 { return apply${i - 1}(cb) }"
            )
        }
        mutatingSb.AppendLine("            apply63(() -> { value = nil })")
        mutatingSb.AppendLine("        }")
        mutatingSb.AppendLine("        return value.Length")
        mutatingSb.AppendLine("    }")
        mutatingSb.AppendLine("    return 0")
        mutatingSb.AppendLine("}")
        mutatingSb.AppendLine("Run(\"ok\", false)")
        AssertContainsError(EmittedOracle.Evaluate(mutatingSb.ToString()), "GS0158")
    }

    @Fact
    func MutuallyRecursiveClosures_CapturedWriteInvalidatesNarrowing() {
        let result = EmittedOracle.Evaluate(`
func Run(initial string?, limit int32) int32 {
    var value = initial
    var remaining = limit
    if value != nil {
        let _ = {
            var a () -> int32 = () -> 0
            var b () -> int32 = () -> 0
            a = () -> {
                if remaining > 0 {
                    remaining--
                    return b()
                }
                return 0
            }
            b = () -> {
                value = nil
                return a()
            }
            a()
        }
        return value.Length
    }
    return 0
}
Run("ok", 1)
`)
        AssertContainsError(result, "GS0158")
    }

    @Fact
    func CallableProvenance_ConditionalReassignmentInvalidatesNarrowing() {
        let result = EmittedOracle.Evaluate(`
func Run(initial string?, flag bool) int32 {
    var value = initial
    if value != nil {
        let _ = {
            var f () -> int32 = () -> 0
            if flag {
                f = () -> {
                    value = nil
                    return 0
                }
            }
            f()
        }
        return value.Length
    }
    return 0
}
Run("ok", true)
`)
        AssertContainsError(result, "GS0158")
    }

    @Fact
    func NullCoalesce_LeftAssignedMutatingTarget_PreservedWhenRightOverwritesTarget() {
        let result = EmittedOracle.Evaluate(`
func Run(initial string?, fallback string?) int32 {
    var value = initial
    if value != nil {
        let _ = {
            var f () -> int32 = () -> 0
            let _ = {
                f = () -> {
                    value = nil
                    return 0
                }
                fallback
            } ?? {
                f = () -> 1
                "ok"
            }
            f()
        }
        return value.Length
    }
    return 0
}
Run("ok", "x")
`)
        AssertContainsError(result, "GS0158")
    }

    shared {
        private func AssertContainsError(result EmittedOracleResult, diagnosticId string) {
            Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.IsError && d.Id == diagnosticId)
        }
    }
}
