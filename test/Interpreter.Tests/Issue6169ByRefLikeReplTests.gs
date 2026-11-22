// <copyright file="Issue6169ByRefLikeReplTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #6169 (ADR-0228): in the interactive REPL (`EmittedSessionEngine`),
/// top-level by-ref-like bindings execute inside the cell's entry-point locals
/// and never persist as `<Program>` static fields, `<Result>$` values,
/// `ReplState` variables, or cross-submission bindings.
open class Issue6169ByRefLikeReplTests {
    @Fact
    func TopLevelSpan_RunsInOwnCell_AndNeverPersistsAcrossSubmissions() {
        using let engine = EmittedSessionEngine(default(IReadOnlyList[string])){CaptureConsole = true}

        let cell1 = engine.Evaluate(`import System
let view readonly span[byte] = u8"hello"
Console.WriteLine(view.Length)`)
        Assert.False(cell1.HasError, string.Join("; ", cell1.Diagnostics))
        Assert.Equal("5\n", cell1.Output)
        Assert.DoesNotContain(
            engine.Snapshot().Variables,
            (symbol ReplSymbol) -> symbol.Display.Contains("view", StringComparison.Ordinal)
        )

        // Referencing the stack-only binding from a later submission must fail,
        // never read a missing field or leak `<Program>` metadata.
        let cell2 = engine.Evaluate(`view`)
        Assert.True(cell2.HasError)
        Assert.Contains(cell2.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0125")
        Assert.DoesNotContain(cell2.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS9998")

        let cell2Member = engine.Evaluate(`Console.WriteLine(view.Length)`)
        Assert.True(cell2Member.HasError)
        Assert.True(cell2Member.Diagnostics.Any((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError))
        Assert.DoesNotContain(cell2Member.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS9998")

        // A trailing by-ref-like declaration/expression in a later cell also runs
        // cleanly without trying to persist `<Result>$`, and ordinary globals still persist.
        let cell3 = engine.Evaluate(`var x = 40
let tail readonly span[byte] = u8"ab"
x + tail.Length`)
        Assert.False(cell3.HasError, string.Join("; ", cell3.Diagnostics))
        Assert.Equal(42, cell3.Value)
        Assert.Contains(
            engine.Snapshot().Variables,
            (symbol ReplSymbol) -> symbol.Display.Contains("x", StringComparison.Ordinal)
        )
        Assert.DoesNotContain(
            engine.Snapshot().Variables,
            (symbol ReplSymbol) -> symbol.Display.Contains("tail", StringComparison.Ordinal)
        )
    }

    @Fact
    func TopLevelSpan_InCellWithDeclaredFunction_ReportsGS9004() {
        using let engine = EmittedSessionEngine(default(IReadOnlyList[string])){CaptureConsole = true}

        let cell = engine.Evaluate(`import System
let view readonly span[byte] = u8"hello"
f()
func f() int32 -> view.Length`)
        Assert.True(cell.HasError)
        Assert.Contains(cell.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS9004")
        Assert.DoesNotContain(cell.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS9998")
    }
}
