// <copyright file="Repl.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;

namespace GSharp.Interpreter;

/// <summary>
/// A generic eval core shared by REPL hosts. The interactive surface is provided
/// by the Spectre.Console TUI in the <see cref="GSharp.Repl"/> namespace; this base
/// type owns the submission history and submission-completeness heuristics so the
/// host can stay focused on rendering.
/// </summary>
public abstract class Repl
{
    private readonly List<string> submissionHistory = new List<string>();

    /// <summary>
    /// Gets the previously evaluated submissions, oldest first.
    /// </summary>
    public IReadOnlyList<string> SubmissionHistory => submissionHistory;

    /// <summary>
    /// Evaluates a submission.
    /// </summary>
    /// <param name="text">The text containing the submission.</param>
    public abstract void EvaluateSubmission(string text);

    /// <summary>
    /// Records a submission in the history buffer.
    /// </summary>
    /// <param name="text">The submission text.</param>
    public void RememberSubmission(string text)
    {
        if (!string.IsNullOrEmpty(text))
        {
            submissionHistory.Add(text);
        }
    }

    /// <summary>
    /// Clears the submission history.
    /// </summary>
    public void ClearHistory()
    {
        submissionHistory.Clear();
    }

    /// <summary>
    /// Evaluates whether the input text represents a complete submission for the interpreter.
    /// </summary>
    /// <param name="text">The input text.</param>
    /// <returns>Whether the input text is a complete submission.</returns>
    protected abstract bool IsCompleteSubmission(string text);

    /// <summary>
    /// Evaluates a meta command.
    /// </summary>
    /// <param name="input">The meta command to evaluate.</param>
    protected virtual void EvaluateMetaCommand(string input)
    {
        Console.ForegroundColor = ConsoleColor.Red;
        Console.WriteLine($"Invalid command {input}.");
        Console.ResetColor();
    }
}
