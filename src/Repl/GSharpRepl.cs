// <copyright file="GSharpRepl.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Diagnostics;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Core.IO;

namespace GSharp.Interpreter;

/// <summary>
/// Implements a GSharp-specific read-eval-print loop core. The submission engine
/// is shared between the file-evaluation entry point and the interactive TUI; the
/// latter consumes <see cref="EvaluateForRepl(string)"/> for structured results.
/// </summary>
public class GSharpRepl : Repl
{
    private readonly Dictionary<VariableSymbol, object> variables = new Dictionary<VariableSymbol, object>();

    private Compilation previous;

    /// <summary>
    /// Initializes a new instance of the <see cref="GSharpRepl"/> class.
    /// </summary>
    /// <param name="logger">Optional host logger.</param>
    public GSharpRepl(ILogger logger = null)
    {
        Logger = logger ?? NullLogger.Instance;
    }

    /// <summary>
    /// Gets the host logger for this REPL.
    /// </summary>
    public ILogger Logger { get; }

    /// <inheritdoc/>
    public override void EvaluateSubmission(string text)
    {
        var result = EvaluateForRepl(text);
        if (result.Diagnostics.Any())
        {
            Console.Out.WriteDiagnostics(result.Diagnostics);
        }

        if (result.Success && result.Value != null)
        {
            Console.ForegroundColor = ConsoleColor.White;
            Console.WriteLine(result.Value);
            Console.ResetColor();
        }
    }

    /// <summary>
    /// Evaluates a submission and returns a structured result. Evaluation is fully
    /// guarded: parser, binder, and runtime exceptions are converted into diagnostics
    /// so the interactive host never crashes (e.g. redefining a function).
    /// </summary>
    /// <param name="text">The submission text.</param>
    /// <returns>The structured evaluation result.</returns>
    public ReplEvaluationResult EvaluateForRepl(string text)
    {
        Logger.LogDebug("Evaluating REPL submission");

        if (string.IsNullOrWhiteSpace(text))
        {
            return new ReplEvaluationResult(true, null, ImmutableArray<Diagnostic>.Empty);
        }

        try
        {
            var syntaxTree = SyntaxTree.Parse(text);
            var compilation = previous == null
                                ? new Compilation(syntaxTree) { Logger = Logger }
                                : previous.ContinueWith(syntaxTree);

            var result = compilation.Evaluate(variables);
            var hasError = result.Diagnostics.Any(d => d.IsError);
            if (!hasError)
            {
                previous = compilation;
            }
            else
            {
                Logger.LogWarning("Submission completed with errors");
            }

            return new ReplEvaluationResult(!hasError, hasError ? null : result.Value, result.Diagnostics);
        }
        catch (Exception ex)
        {
            // Never let a redefinition / binder / runtime fault tear down the REPL.
            Logger.LogWarning("Submission raised an exception", ex);
            var diagnostics = ImmutableArray.Create(SyntheticDiagnostic(text, ex.Message));
            return new ReplEvaluationResult(false, null, diagnostics);
        }
    }

    /// <summary>
    /// Resets the accumulated compilation state and variables.
    /// </summary>
    public void Reset()
    {
        previous = null;
        variables.Clear();
        ClearHistory();
    }

    /// <inheritdoc/>
    protected override bool IsCompleteSubmission(string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return true;
        }

        var lastTwoLinesAreBlank = text.Split(Environment.NewLine)
                                       .Reverse()
                                       .TakeWhile(s => string.IsNullOrEmpty(s))
                                       .Take(2)
                                       .Count() == 2;
        if (lastTwoLinesAreBlank)
        {
            return true;
        }

        var syntaxTree = SyntaxTree.Parse(text);
        if (syntaxTree.Root.Members.Length == 0 ||
            syntaxTree.Root.Members.Last().GetLastToken().IsMissing)
        {
            return false;
        }

        return true;
    }

    private static Diagnostic SyntheticDiagnostic(string text, string message)
    {
        var source = SourceText.From(text);
        var location = new TextLocation(source, new TextSpan(0, Math.Max(1, text.Length)));
        return new Diagnostic(location, "GSI0001", DiagnosticSeverity.Error, message);
    }
}

/// <summary>
/// Structured outcome of a single REPL submission.
/// </summary>
/// <param name="Success">Whether evaluation completed without errors.</param>
/// <param name="Value">The produced value, or null.</param>
/// <param name="Diagnostics">Diagnostics raised during evaluation.</param>
public sealed record ReplEvaluationResult(bool Success, object Value, ImmutableArray<Diagnostic> Diagnostics);
