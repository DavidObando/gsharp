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
using GSharp.Core.CodeAnalysis.Symbols.Display;
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
    /// Builds a snapshot of the accumulated session state — the imports, functions, variables,
    /// and user-defined types declared across every successfully evaluated cell. Powers the
    /// REPL's right-hand state sidebar. Never throws; returns <see cref="ReplState.Empty"/> if
    /// nothing has been evaluated yet or if introspection fails.
    /// </summary>
    public ReplState Snapshot()
    {
        if (previous is null)
        {
            return ReplState.Empty;
        }

        try
        {
            var imports = new List<ReplSymbol>();
            var functions = new List<ReplSymbol>();
            var vars = new List<ReplSymbol>();
            var types = new List<ReplSymbol>();
            var seenImports = new HashSet<string>(StringComparer.Ordinal);
            var seenFunctions = new HashSet<string>(StringComparer.Ordinal);
            var seenVars = new HashSet<string>(StringComparer.Ordinal);
            var seenTypes = new HashSet<string>(StringComparer.Ordinal);

            // Walk the scope chain newest-to-oldest so redeclarations show their latest form.
            for (var scope = previous.GlobalScope; scope is not null; scope = scope.Previous)
            {
                foreach (var import in scope.Imports)
                {
                    if (seenImports.Add(import.Name))
                    {
                        imports.Add(new ReplSymbol(Display(import)));
                    }
                }

                foreach (var fn in scope.Functions)
                {
                    if (ReferenceEquals(fn, scope.EntryPoint) || fn.IsSpecialName || !seenFunctions.Add(fn.Name))
                    {
                        continue;
                    }

                    functions.Add(new ReplSymbol(Display(fn)));
                }

                foreach (var v in scope.Variables)
                {
                    if (!seenVars.Add(v.Name))
                    {
                        continue;
                    }

                    var display = Display(v);
                    if (variables.TryGetValue(v, out var value) && value is not null)
                    {
                        display += $" = {Truncate(value.ToString(), 20)}";
                    }

                    vars.Add(new ReplSymbol(display));
                }

                foreach (var s in scope.Structs)
                {
                    if (seenTypes.Add(s.Name))
                    {
                        types.Add(new ReplSymbol(Display(s)));
                    }
                }

                foreach (var i in scope.Interfaces)
                {
                    if (seenTypes.Add(i.Name))
                    {
                        types.Add(new ReplSymbol(Display(i)));
                    }
                }

                foreach (var e in scope.Enums)
                {
                    if (seenTypes.Add(e.Name))
                    {
                        types.Add(new ReplSymbol(Display(e)));
                    }
                }

                foreach (var d in scope.Delegates)
                {
                    if (seenTypes.Add(d.Name))
                    {
                        types.Add(new ReplSymbol(Display(d)));
                    }
                }
            }

            return new ReplState(imports, functions, vars, types);
        }
        catch
        {
            return ReplState.Empty;
        }
    }

    private string Display(Symbol symbol)
        => SymbolDisplay.ToDisplayString(symbol, SymbolDisplayFormat.Signature, previous);

    private static string Truncate(string? text, int max)
    {
        if (string.IsNullOrEmpty(text))
        {
            return string.Empty;
        }

        var oneLine = text.Replace("\r", " ").Replace("\n", " ");
        return oneLine.Length <= max ? oneLine : oneLine[..(max - 1)] + "…";
    }

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

/// <summary>A single entry in the REPL state sidebar, rendered via the shared <c>SymbolDisplay</c> service.</summary>
public sealed record ReplSymbol(string Display);

/// <summary>Snapshot of the accumulated REPL session: imports, functions, variables, and user types.</summary>
public sealed record ReplState(
    IReadOnlyList<ReplSymbol> Imports,
    IReadOnlyList<ReplSymbol> Functions,
    IReadOnlyList<ReplSymbol> Variables,
    IReadOnlyList<ReplSymbol> Types)
{
    public static ReplState Empty { get; } = new(
        Array.Empty<ReplSymbol>(),
        Array.Empty<ReplSymbol>(),
        Array.Empty<ReplSymbol>(),
        Array.Empty<ReplSymbol>());

    public bool IsEmpty => Imports.Count == 0 && Functions.Count == 0 && Variables.Count == 0 && Types.Count == 0;
}

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
