// <copyright file="GSharpRepl.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Core.IO;
using GSharp.Repl.Engine;

namespace GSharp.Interpreter;

/// <summary>
/// Compatibility shim preserving the legacy <c>GSharp.Interpreter.GSharpRepl</c> API used by
/// existing tests. Wraps the emitted submission-chaining <see cref="EmittedSessionEngine"/>
/// (ADR-0156 Phase 3c, #3176 — previously the tree-walking <c>SessionEngine</c>) and writes
/// results to the console.
/// </summary>
public sealed class GSharpRepl : IDisposable
{
    private readonly EmittedSessionEngine engine = new();

    /// <summary>Evaluate one submission, printing diagnostics then the value to the console.</summary>
    public void EvaluateSubmission(string text)
    {
        var cell = engine.Evaluate(text);
        if (cell.Diagnostics.Length > 0)
        {
            Console.Out.WriteDiagnostics(cell.Diagnostics);
        }

        if (!cell.HasError && cell.Value is not null)
        {
            Console.WriteLine(cell.Value);
        }
    }

    /// <inheritdoc/>
    public void Dispose() => engine.Dispose();
}
