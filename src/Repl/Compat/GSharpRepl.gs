// <copyright file="GSharpRepl.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter

import GSharp.Core.IO
import GSharp.Repl.Engine
import System

/// Compatibility shim preserving the legacy `GSharp.Interpreter.GSharpRepl` API used by
/// existing tests. Wraps the emitted submission-chaining (cref:EmittedSessionEngine)
/// (ADR-0156 Phase 3c, #3176 — previously the tree-walking `SessionEngine`) and writes
/// results to the console.
class GSharpRepl : IDisposable {
    private let engine EmittedSessionEngine = EmittedSessionEngine()

    /// Evaluate one submission, printing diagnostics then the value to the console.
    func EvaluateSubmission(text string) {
        let cell = engine.Evaluate(text)
        if cell.Diagnostics.Length > 0 {
            Console.Out.WriteDiagnostics(cell.Diagnostics)
        }
        if !cell.HasError && cell.Value != nil {
            // ADR-0157: display-side pretty echo — never emitted semantics.
            Console.WriteLine(ReplValueFormatter.Format(cell.Value))
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() -> engine.Dispose()
}
