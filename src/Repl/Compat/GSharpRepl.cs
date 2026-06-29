// <copyright file="GSharpRepl.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Core.IO;
using GSharp.Repl.Engine;

namespace GSharp.Interpreter;

/// <summary>
/// Compatibility shim preserving the legacy <c>GSharp.Interpreter.GSharpRepl</c> API used by
/// existing tests. Wraps the new <see cref="SessionEngine"/> and writes results to the console.
/// </summary>
public sealed class GSharpRepl
{
    private readonly SessionEngine engine = new();

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
}
