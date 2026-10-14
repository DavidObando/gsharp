// <copyright file="ISessionEngine.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Engine

import System
import System.Collections.Generic
import System.Threading
import System.Threading.Tasks

/// The evaluation engine surface the interactive TUI drives (ADR-0156): the
/// emitted submission-chaining (cref:EmittedSessionEngine) implements
/// it (the only engine since Phase 3c deleted the tree-walking evaluator),
/// and the interface keeps the REPL screen engine-agnostic for tests.
interface ISessionEngine {
    /// Gets the transcript of evaluated cells.
    prop Cells IReadOnlyList[Cell] {
        get;
    }

    /// Gets or sets a value indicating whether standard output/error produced
    /// while evaluating a cell are captured into the cell instead of leaking
    /// to the raw terminal.
    prop CaptureConsole bool {
        get;
        set;
    }

    /// Gets or sets the optional provider that supplies a line of standard
    /// input when evaluated code reads from (cref:Console.In).
    prop InputProvider(() -> string?)? {
        get;
        set;
    }

    /// Evaluates a submission, appends a cell, and returns it. Never throws.
    /// @param text The submission source.
    /// @returns The evaluated cell.
    func Evaluate(text string) Cell;

    /// Evaluates a submission on a background thread so the caller's render
    /// loop stays responsive. Cancellation is best-effort: the token is only
    /// observed at the single checkpoint before the result would be committed
    /// to (cref:Cells)/session state.
    /// @param text The submission source.
    /// @param cancellationToken Best-effort cancellation token.
    /// @returns The evaluated cell.
    func EvaluateAsync(text string, cancellationToken CancellationToken) Task[Cell];

    /// Builds a snapshot of the accumulated session state for the REPL sidebar.
    /// @returns The snapshot; (cref:ReplState.Empty) when nothing has been evaluated.
    func Snapshot() ReplState;

    /// Discards all session state and starts a fresh submission chain.
    func Reset();
}
