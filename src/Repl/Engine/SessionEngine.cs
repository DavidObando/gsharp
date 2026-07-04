// <copyright file="SessionEngine.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Repl.Engine;

/// <summary>
/// Owns the incremental compilation state and the transcript of evaluated cells.
/// Replaces the eval core of the old <c>GSharpRepl</c> without any console output.
/// </summary>
public sealed class SessionEngine
{
    private readonly Dictionary<VariableSymbol, object> variables = new();
    private readonly List<Cell> cells = new();
    private Compilation? previous;

    public IReadOnlyList<Cell> Cells => cells;

    public IReadOnlyDictionary<VariableSymbol, object> Variables => variables;

    /// <summary>
    /// When <see langword="true"/>, standard output and error produced while evaluating a cell
    /// are captured into the cell (see <see cref="Cell.Output"/> / <see cref="Cell.StandardError"/>)
    /// instead of leaking to the raw terminal. The interactive TUI enables this; the script runner
    /// leaves it off so output streams straight through.
    /// </summary>
    public bool CaptureConsole { get; set; }

    /// <summary>
    /// Optional provider that supplies a line of standard input when evaluated code reads from
    /// <see cref="Console.In"/> (e.g. <c>Console.ReadLine()</c>). Returning <see langword="null"/>
    /// signals end-of-input. When unset, <see cref="Console.In"/> is left untouched.
    /// </summary>
    public Func<string?>? InputProvider { get; set; }

    /// <summary>Evaluate a submission, append a cell, and return it. Never throws.</summary>
    public Cell Evaluate(string text)
    {
        var index = cells.Count + 1;

        var originalOut = Console.Out;
        var originalError = Console.Error;
        var originalIn = Console.In;
        StringWriter? stdout = null;
        StringWriter? stderr = null;

        if (CaptureConsole)
        {
            stdout = new StringWriter { NewLine = "\n" };
            stderr = new StringWriter { NewLine = "\n" };
            Console.SetOut(stdout);
            Console.SetError(stderr);
        }

        if (InputProvider is not null)
        {
            Console.SetIn(new CallbackTextReader(InputProvider));
        }

        Cell cell;
        try
        {
            try
            {
                var tree = SyntaxTree.Parse(text);
                var compilation = previous == null ? new Compilation(tree) : previous.ContinueWith(tree);
                var result = compilation.Evaluate(variables);

                var hasError = result.Diagnostics.Any(d => d.IsError);
                if (!hasError)
                {
                    previous = compilation;
                }

                cell = new Cell(index, text, result.Value, result.Diagnostics, hasError, stdout?.ToString() ?? string.Empty, stderr?.ToString() ?? string.Empty);
            }
            catch (Exception ex)
            {
                var diag = new Diagnostic(default, "GSI001", DiagnosticSeverity.Error, $"Evaluation error: {ex.Message}");
                cell = new Cell(index, text, null, ImmutableArray.Create(diag), true, stdout?.ToString() ?? string.Empty, stderr?.ToString() ?? string.Empty);
            }
        }
        finally
        {
            if (CaptureConsole)
            {
                Console.SetOut(originalOut);
                Console.SetError(originalError);
            }

            if (InputProvider is not null)
            {
                Console.SetIn(originalIn);
            }
        }

        cells.Add(cell);
        return cell;
    }

    /// <summary>Whether the text is a complete submission (balanced, parses fully).</summary>
    public static bool IsComplete(string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return true;
        }

        var tree = SyntaxTree.Parse(text);
        return tree.Root.Members.Length > 0 && !tree.Root.Members.Last().GetLastToken().IsMissing;
    }

    public void Reset()
    {
        previous = null;
        variables.Clear();
        cells.Clear();
    }
}

/// <summary>One transcript entry: input plus its result, captured console output, or diagnostics.</summary>
public sealed record Cell(
    int Index,
    string Input,
    object? Value,
    ImmutableArray<Diagnostic> Diagnostics,
    bool HasError,
    string Output = "",
    string StandardError = "");

/// <summary>
/// A <see cref="TextReader"/> that sources whole lines from a callback, letting the interactive
/// REPL prompt the user on demand when evaluated code reads from <see cref="Console.In"/>.
/// </summary>
internal sealed class CallbackTextReader : TextReader
{
    private readonly Func<string?> readLine;
    private string? buffer;
    private int bufferPos;

    public CallbackTextReader(Func<string?> readLine) => this.readLine = readLine ?? throw new ArgumentNullException(nameof(readLine));

    public override string? ReadLine() => readLine();

    public override int Peek() => EnsureBuffer() ? buffer![bufferPos] : -1;

    public override int Read()
    {
        if (!EnsureBuffer())
        {
            return -1;
        }

        var ch = buffer![bufferPos++];
        if (bufferPos >= buffer!.Length)
        {
            buffer = null;
        }

        return ch;
    }

    private bool EnsureBuffer()
    {
        if (buffer is not null && bufferPos < buffer.Length)
        {
            return true;
        }

        var line = readLine();
        if (line is null)
        {
            return false;
        }

        buffer = line + "\n";
        bufferPos = 0;
        return true;
    }
}
