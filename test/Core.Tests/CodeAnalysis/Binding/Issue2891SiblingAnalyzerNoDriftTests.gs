// <copyright file="Issue2891SiblingAnalyzerNoDriftTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Guards the two analyzers that share (cref:ControlFlowGraph.Create):
/// definite-return-only try and exhaustiveness projection must not change
/// GS0238/GS0239 assignment or GS0219 async ref-struct diagnostics.
open class Issue2891SiblingAnalyzerNoDriftTests {
    @Theory
    @MemberData("Cases")
    func SharedCfgDiagnosticsRemainUnchanged(name string, expectedIds string, source string) {
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        let actual = compilation
            .GlobalScope
            .Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where((diagnostic Diagnostic) -> (diagnostic.Id is "GS0219" or "GS0238" or "GS0239"))
            .Select((diagnostic Diagnostic) -> diagnostic.Id)
            .Distinct()
            .OrderBy((id string) -> id)
        let expected = expectedIds.Split(',', StringSplitOptions.RemoveEmptyEntries).OrderBy((id string) -> id)
        Assert.Equal(expected, actual)
    }

    shared {
        /// Gets sibling-analyzer shapes and expected relevant diagnostic IDs.
        func Cases() sequence[[]object] {
            yield Case("OutFinallyAssigned", "", `func F(out value int32) {
    try {
    } finally {
        value = 1
    }
}`)
            yield Case("OutTryOnlyCatchCompletes", "GS0238", `import System
func F(out value int32) {
    try {
        value = 1
    } catch (ex Exception) {
    }
}`)
            yield Case("OutTryAndCatchAssigned", "", `import System
func F(out value int32) {
    try {
        value = 1
    } catch (ex Exception) {
        value = 2
    }
}`)
            yield Case("OutTryCatchFinallyAssigned", "", `import System
func F(out value int32) {
    try {
    } catch (ex Exception) {
    } finally {
        value = 3
    }
}`)
            yield Case("OutEscapingFinallyGoto", "GS0238", `func F(out value int32) {
    try {
    } finally {
        goto done
    }
done:
    var reached = true
}`)
            yield Case("OutNestedEscapingFinallyClean", "", `func F(out value int32) {
    outer: for {
        try {
            for {
                try {
                } finally {
                    goto innerDone
                }
            }
        innerDone:
            value = 1
        } finally {
            break outer
        }
    }
}`)
            yield Case("RefTryOnlyCatchCompletes", "GS0239", `import System
func Bump(ref value int32) {
    value += 1
}
func F() {
    var value int32
    try {
        value = 1
    } catch (ex Exception) {
    }
    Bump(&value)
}`)
            yield Case("RefFinallyAssigned", "", `func Bump(ref value int32) {
    value += 1
}
func F() {
    var value int32
    try {
    } finally {
        value = 1
    }
    Bump(&value)
}`)
            yield Case("OutExhaustiveEnumNoDefault", "GS0238", `enum E { A, B }
func F(out value int32, x E) {
    switch x {
        case E.A { value = 1 }
        case E.B { value = 2 }
    }
}`)
            yield Case("OutEnumWithDefault", "", `enum E { A, B }
func F(out value int32, x E) {
    switch x {
        case E.A { value = 1 }
        default { value = 2 }
    }
}`)
            yield Case("RefExhaustiveEnumNoDefault", "GS0239", `enum E { A, B }
func Bump(ref value int32) {
    value += 1
}
func F(x E) {
    var value int32
    switch x {
        case E.A { value = 1 }
        case E.B { value = 2 }
    }
    Bump(&value)
}`)
            yield Case("SpanTryDeadBeforeAwait", "", `import System
import System.Threading.Tasks
async func F(values []int32) Task[int32] {
    var span ReadOnlySpan[int32] = values
    var length = 0
    try {
        length = span.Length
    } finally {
    }
    await Task.Yield()
    return length
}`)
            yield Case("SpanTryLiveAcrossAwait", "GS0219", `import System
import System.Threading.Tasks
async func F(values []int32) Task[int32] {
    var span ReadOnlySpan[int32] = values
    try {
        await Task.Yield()
    } finally {
        var length = span.Length
    }
    return 0
}`)
            yield Case("SpanEscapingFinallyGotoLiveAcrossAwait", "GS0219", `import System
import System.Threading.Tasks
async func F(values []int32) Task[int32] {
    var span ReadOnlySpan[int32] = values
    try {
        await Task.Yield()
    } finally {
        goto done
    }
done:
    return span.Length
}`)
            yield Case("SpanExhaustiveSwitchLiveAcrossAwait", "GS0219", `import System
import System.Threading.Tasks
enum E { A, B }
async func F(values []int32, x E) Task[int32] {
    var span ReadOnlySpan[int32] = values
    await Task.Yield()
    switch x {
        case E.A { return span.Length }
        case E.B { return span.Length + 1 }
    }
}`)
        }

        private func Case(name string, expectedIds string, body string)[]object -> []object{
            name,
            expectedIds,
            "package Issue2891.NoDrift$name${Environment.NewLine}$body"
        }
    }
}
