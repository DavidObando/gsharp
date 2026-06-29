// <copyright file="SessionEngine.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
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

    /// <summary>Evaluate a submission, append a cell, and return it. Never throws.</summary>
    public Cell Evaluate(string text)
    {
        var index = cells.Count + 1;
        Cell cell;
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

            cell = new Cell(index, text, result.Value, result.Diagnostics, hasError);
        }
        catch (Exception ex)
        {
            var diag = new Diagnostic(default, "GSI001", DiagnosticSeverity.Error, $"Evaluation error: {ex.Message}");
            cell = new Cell(index, text, null, ImmutableArray.Create(diag), true);
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

/// <summary>One transcript entry: input plus its result or diagnostics.</summary>
public sealed record Cell(int Index, string Input, object? Value, ImmutableArray<Diagnostic> Diagnostics, bool HasError);
