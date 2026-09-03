// <copyright file="ISessionEngine.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace GSharp.Repl.Engine;

/// <summary>
/// The evaluation engine surface the interactive TUI drives (ADR-0156): the
/// emitted submission-chaining <see cref="EmittedSessionEngine"/> implements
/// it (the only engine since Phase 3c deleted the tree-walking evaluator),
/// and the interface keeps the REPL screen engine-agnostic for tests.
/// </summary>
public interface ISessionEngine
{
    /// <summary>Gets the transcript of evaluated cells.</summary>
    IReadOnlyList<Cell> Cells { get; }

    /// <summary>
    /// Gets or sets a value indicating whether standard output/error produced
    /// while evaluating a cell are captured into the cell instead of leaking
    /// to the raw terminal.
    /// </summary>
    bool CaptureConsole { get; set; }

    /// <summary>
    /// Gets or sets the optional provider that supplies a line of standard
    /// input when evaluated code reads from <see cref="Console.In"/>.
    /// </summary>
    Func<string?>? InputProvider { get; set; }

    bool CaptureSyntaxTree { get; set; }

    bool CaptureIntermediateLanguage { get; set; }

    /// <summary>Evaluates a submission, appends a cell, and returns it. Never throws.</summary>
    /// <param name="text">The submission source.</param>
    /// <returns>The evaluated cell.</returns>
    Cell Evaluate(string text);

    /// <summary>
    /// Evaluates a submission on a background thread so the caller's render
    /// loop stays responsive. Cancellation is best-effort: the token is only
    /// observed at the single checkpoint before the result would be committed
    /// to <see cref="Cells"/>/session state.
    /// </summary>
    /// <param name="text">The submission source.</param>
    /// <param name="cancellationToken">Best-effort cancellation token.</param>
    /// <returns>The evaluated cell.</returns>
    Task<Cell> EvaluateAsync(string text, CancellationToken cancellationToken);

    EditorAnalysis AnalyzeEditor(string text);

    IReadOnlyList<GSharp.LanguageServer.Protocol.CompletionItem> Completions(string text, int line, int col);

    string? Hover(string text, int line, int col);

    /// <summary>Builds a snapshot of the accumulated session state for the REPL sidebar.</summary>
    /// <returns>The snapshot; <see cref="ReplState.Empty"/> when nothing has been evaluated.</returns>
    ReplState Snapshot();

    /// <summary>Discards all session state and starts a fresh submission chain.</summary>
    void Reset();
}
