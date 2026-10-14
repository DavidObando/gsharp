// <copyright file="Issue2891TryRegionFlowTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #2891: definite-return analysis must model try, catch, and finally
/// regions without hiding escaping branches or treating handlers sequentially.
open class Issue2891TryRegionFlowTests {
    @Theory
    @MemberData("MissingReturnCases")
    func EscapingOrCompletingPath_ReportsGs0100(name string, source string) {
        let (diagnostics, emittedLength) = Compile(source)
        let diagnostic = Assert.Single(diagnostics.Where((candidate Diagnostic) -> candidate.IsError))
        Assert.Equal("GS0100", diagnostic.Id)
        Assert.Equal("F", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        Assert.Equal(int64(0), emittedLength)
    }

    @Theory
    @MemberData("CompleteCases")
    func EveryPathTerminates_DoesNotReportGs0100(name string, source string) {
        let (diagnostics, emittedLength) = Compile(source)
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.True(emittedLength > int64(0))
    }

    shared {
        /// Gets try-region shapes that must report GS0100.
        func MissingReturnCases() sequence[[]object] {
            yield Case("TryFinallyBreak", `func F() int32 {
    for {
        try {
            break
        } finally {
        }
    }
}`)
            yield Case("TryCatchBreak", `import System
func F() int32 {
    for {
        try {
            break
        } catch (ex Exception) {
            return 1
        }
    }
}`)
            yield Case("TryCatchFinallyBreak", `import System
func F() int32 {
    for {
        try {
            break
        } catch (ex Exception) {
            return 1
        } finally {
        }
    }
}`)
            yield Case("CatchBreak", `import System
func F() int32 {
    for {
        try {
            throw Exception("boom")
        } catch (ex Exception) {
            break
        }
    }
}`)
            yield Case("FinallyBreak", `func F() int32 {
    for {
        try {
            return 1
        } finally {
            break
        }
    }
}`)
            yield Case("LabeledTryBreak", `func F() int32 {
    outer: for {
        for {
            try {
                break outer
            } finally {
            }
        }
    }
}`)
            yield Case("LabeledCatchBreak", `import System
func F() int32 {
    outer: for {
        for {
            try {
                throw Exception("boom")
            } catch (ex Exception) {
                break outer
            }
        }
    }
}`)
            yield Case("LabeledFinallyBreak", `func F() int32 {
    outer: for {
        for {
            try {
                return 1
            } finally {
                break outer
            }
        }
    }
}`)
            yield Case("TryGoto", `func F() int32 {
    try {
        goto done
    } finally {
    }
    return 1
done:
    var reached = true
}`)
            yield Case("GotoIntoTryThenBreak", `func F(returnFromTry bool) int32 {
    for {
        goto inside
        try {
        inside:
            if returnFromTry {
                return 1
            }
            break
        } finally {
        }
    }
}`)
            yield Case("CatchGoto", `import System
func F() int32 {
    try {
        throw Exception("boom")
    } catch (ex Exception) {
        goto done
    }
    return 1
done:
    var reached = true
}`)
            yield Case("FinallyGoto", `func F() int32 {
    try {
        return 1
    } finally {
        goto done
    }
done:
    var reached = true
}`)
            yield Case("ExceptionSuppressedByFinallyGotoMissingReturn", `import System
func F() int32 {
    try {
        throw Exception("origin")
    } finally {
        goto done
    }
done:
    var reached = true
}`)
            yield Case("ImplicitExceptionSuppressedByFinallyGoto", `import System
func Crash() {
    throw Exception("origin")
}
func F() int32 {
    try {
        for {
            Crash()
        }
    } finally {
        goto done
    }
done:
    var reached = true
}`)
            yield Case("NestedTryBreak", `func F() int32 {
    for {
        try {
            try {
                break
            } finally {
            }
        } finally {
        }
    }
}`)
            yield Case("TryInsideCatchBreak", `import System
func F() int32 {
    for {
        try {
            throw Exception("outer")
        } catch (ex Exception) {
            try {
                break
            } finally {
            }
        }
    }
}`)
            yield Case("TryInsideFinallyBreak", `func F() int32 {
    for {
        try {
            return 1
        } finally {
            try {
                break
            } finally {
            }
        }
    }
}`)
            yield Case("TryInsideSwitchArmBreak", `func F(x int32) int32 {
    outer: for {
        switch x {
            default {
                try {
                    break outer
                } finally {
                }
            }
        }
    }
}`)
            yield Case("SwitchInsideTryBreak", `func F(x int32) int32 {
    outer: for {
        try {
            switch x {
                default { break outer }
            }
        } finally {
        }
    }
}`)
            yield Case("TryInsideSelectBreak", `func F() int32 {
    outer: for {
        select {
            default {
                try {
                    break outer
                } finally {
                }
            }
        }
    }
}`)
            yield Case("SelectInsideTryBreak", `func F() int32 {
    outer: for {
        try {
            select {
                default { break outer }
            }
        } finally {
        }
    }
}`)
            yield Case("TryInsideFixedBreak", `func F(xs []int32) int32 {
    unsafe {
        for {
            fixed p *int32 = xs {
                try {
                    break
                } finally {
                }
            }
        }
    }
}`)
            yield Case("TryInsideScopeBreak", `func F() int32 {
    for {
        scope {
            try {
                break
            } finally {
            }
        }
    }
}`)
            yield Case("TryInsideUsingBreak", `import System.IO
func F() int32 {
    for {
        using let stream = MemoryStream()
        try {
            break
        } finally {
        }
    }
}`)
            yield Case("MixedCatchEscape", `import System
func F(flag bool) int32 {
    for {
        try {
            if flag {
                return 1
            }
            throw Exception("boom")
        } catch (ex Exception) {
            break
        } finally {
        }
    }
}`)
            yield Case("NormalTryCompletion", `func F() int32 {
    try {
        var value = 1
    } finally {
    }
}`)
            yield Case("ExistingLoopBreak", `func F() int32 {
    for {
        break
    }
}`)
        }

        /// Gets try-region shapes that must not report GS0100.
        func CompleteCases() sequence[[]object] {
            yield Case("FinallyLoopAfterWhileTrue", `import System
func F(exit bool) int32 {
    try {
        while true {
            if exit {
                return 1
            }
        }
    } finally {
        for var i = 0; i < 1; i++ {
            try {
                var cleaned = i
            } catch (ex Exception) {
            }
        }
    }
}`)
            yield Case("WhileTrueInsideTryFinally", `import System
func F(exit bool) int32 {
    try {
        try {
            var initialized = true
        } catch (ex Exception) {
        }
        while true {
            if exit {
                return 1
            }
            if !exit {
                continue
            }
        }
    } finally {
        for var i = 0; i < 1; i++ {
            try {
                var cleaned = i
            } catch (ex Exception) {
            }
        }
    }
}`)
            yield Case("TryContinue", `func F() int32 {
    for {
        try {
            continue
        } finally {
        }
        break
    }
}`)
            yield Case("LabeledTryContinue", `func F() int32 {
    outer: for {
        for {
            try {
                continue outer
            } finally {
            }
            break outer
        }
    }
}`)
            yield Case("CatchContinue", `import System
func F() int32 {
    for {
        try {
            throw Exception("boom")
        } catch (ex Exception) {
            continue
        }
        break
    }
}`)
            yield Case("FinallyContinue", `func F() int32 {
    for {
        try {
            var value = 1
        } finally {
            continue
        }
        break
    }
}`)
            yield Case("LabeledCatchContinue", `import System
func F() int32 {
    outer: for {
        for {
            try {
                throw Exception("boom")
            } catch (ex Exception) {
                continue outer
            }
            break outer
        }
    }
}`)
            yield Case("LabeledFinallyContinue", `func F() int32 {
    outer: for {
        for {
            try {
                var value = 1
            } finally {
                continue outer
            }
            break outer
        }
    }
}`)
            yield Case("TryFinallyReturn", `func F() int32 {
    try {
        return 1
    } finally {
    }
}`)
            yield Case("FinallyReturn", `func F() int32 {
    try {
        return 1
    } finally {
        return 2
    }
}`)
            yield Case("ConditionalFinallyReturnOverException", `import System
func F(replace bool) int32 {
    try {
        throw Exception("origin")
    } finally {
        if replace {
            return 2
        }
    }
}`)
            yield Case("ConditionalFinallyReturnOverReturn", `func F(replace bool) int32 {
    try {
        return 1
    } finally {
        if replace {
            return 2
        }
    }
}`)
            yield Case("ConditionalFinallyReturnOverBreak", `func F(replace bool) int32 {
    var count = 0
    for i in 0 ... 3 {
        try {
            break
        } finally {
            if replace {
                return 2
            }
        }
        count += 1
    }
    return count
}`)
            yield Case("RethrowPreservesOriginStack", `import System
func Origin() {
    throw Exception("origin")
}
func F(replace bool) int32 {
    try {
        Origin()
        return 0
    } finally {
        if replace {
            return 2
        }
    }
}`)
            yield Case("ExceptionSuppressedByFinallyBreak", `import System
func F() int32 {
    for {
        try {
            throw Exception("origin")
        } finally {
            break
        }
    }
    return 4
}`)
            yield Case("ExceptionSuppressedByFinallyContinue", `import System
func F() int32 {
    for i in 0 ... 3 {
        try {
            throw Exception("origin")
        } finally {
            continue
        }
    }
    return 3
}`)
            yield Case("ExceptionSuppressedByFinallyGoto", `import System
func F() int32 {
    try {
        throw Exception("origin")
    } finally {
        goto done
    }
done:
    return 5
}`)
            yield Case("TryCatchReturns", `import System
func F(flag bool) int32 {
    try {
        if flag {
            return 1
        }
        throw Exception("boom")
    } catch (ex Exception) {
        return 2
    }
}`)
            yield Case("TryCatchFinallyReturns", `import System
func F(flag bool) int32 {
    try {
        if flag {
            return 1
        }
        throw Exception("boom")
    } catch (ex Exception) {
        return 2
    } finally {
    }
}`)
            yield Case("ConditionalFinallyReturnOverCatchReturn", `import System
func F(replace bool) int32 {
    try {
        throw Exception("origin")
    } catch (ex Exception) {
        return 1
    } finally {
        if replace {
            return 2
        }
    }
}`)
            yield Case("CatchRethrows", `import System
func F(flag bool) int32 {
    try {
        if flag {
            return 1
        }
        throw Exception("first")
    } catch (ex Exception) {
        throw Exception("second")
    }
}`)
            yield Case("FinallyThrows", `import System
func F() int32 {
    try {
        var value = 1
    } finally {
        throw Exception("stop")
    }
}`)
            yield Case("FinallyInfiniteLoop", `func F() int32 {
    try {
        var value = 1
    } finally {
        for {
        }
    }
}`)
            yield Case("BreakSuppressedByInfiniteFinally", `func F() int32 {
    for {
        try {
            break
        } finally {
            for {
            }
        }
    }
}`)
            yield Case("ReturnAfterTryBreak", `func F() int32 {
    for {
        try {
            break
        } finally {
        }
    }
    return 7
}`)
            yield Case("ReturnAfterCatchBreak", `import System
func F() int32 {
    for {
        try {
            throw Exception("boom")
        } catch (ex Exception) {
            break
        }
    }
    return 8
}`)
            yield Case("TryGotoThenReturn", `func F() int32 {
    try {
        goto done
    } finally {
    }
    return 1
done:
    return 2
}`)
            yield Case("CatchGotoThenReturn", `import System
func F() int32 {
    try {
        throw Exception("boom")
    } catch (ex Exception) {
        goto done
    }
    return 1
done:
    return 2
}`)
            yield Case("FinallyGotoThenReturn", `func F() int32 {
    try {
        return 1
    } finally {
        goto done
    }
done:
    return 2
}`)
            yield Case("TryInsideFinallyReturns", `func F() int32 {
    try {
        return 1
    } finally {
        try {
            var value = 2
        } finally {
        }
    }
}`)
            yield Case("NestedFinallyBreakThenReturn", `func F() int32 {
    for {
        try {
            return 1
        } finally {
            try {
                break
            } finally {
            }
        }
    }
    return 6
}`)
            yield Case("SwitchInsideTryBreakOverriddenByReturn", `func F() int32 {
    for {
        try {
            switch 0 {
                default { break }
            }
        } finally {
            return 1
        }
    }
}`)
            yield Case("SelectInsideTryBreakOverriddenByReturn", `func F() int32 {
    for {
        try {
            select {
                default { break }
            }
        } finally {
            return 2
        }
    }
}`)
            yield Case("ScopeInsideTryBreakOverriddenByReturn", `func F() int32 {
    for {
        try {
            scope {
                break
            }
        } finally {
            return 4
        }
    }
}`)
        }

        private func Case(name string, body string)[]object -> []object{
            name,
            "package Issue2891.$name${Environment.NewLine}$body"
        }

        private func Compile(source string)(Diagnostics ImmutableArray[Diagnostic], EmittedLength int64) {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return (compilation.Emit(peStream).Diagnostics, peStream.Length)
        }
    }
}
