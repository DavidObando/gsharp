// <copyright file="DiagnosticBag.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Represents a collection of code analysis diagnostics information.
/// </summary>
public sealed partial class DiagnosticBag : IEnumerable<Diagnostic>
{
    private readonly ImmutableArray<Diagnostic>.Builder diagnostics = ImmutableArray.CreateBuilder<Diagnostic>();

    /// <summary>
    /// Gets the number of diagnostics currently held in the bag. Used together
    /// with <see cref="TruncateTo"/> to discard speculative diagnostics emitted
    /// while binding an expression that is subsequently re-bound (e.g. issue
    /// #1238 target-typed conditional arguments).
    /// </summary>
    public int Count => diagnostics.Count;

    /// <summary>
    /// Creates an immutable snapshot of the diagnostics currently held in the bag.
    /// </summary>
    /// <returns>An immutable array of diagnostics in insertion order.</returns>
    public ImmutableArray<Diagnostic> ToImmutableArray() => diagnostics.ToImmutable();

    /// <summary>
    /// Removes every diagnostic added after the bag reached <paramref name="count"/>
    /// entries, restoring it to an earlier marked state. Used to roll back the
    /// speculative diagnostics produced while eagerly binding an expression that
    /// will be re-bound against a now-known target type.
    /// </summary>
    /// <param name="count">The diagnostic count to truncate back to. Values
    /// outside the current range are clamped.</param>
    public void TruncateTo(int count)
    {
        if (count < 0)
        {
            count = 0;
        }

        if (count < diagnostics.Count)
        {
            while (diagnostics.Count > count)
            {
                diagnostics.RemoveAt(diagnostics.Count - 1);
            }
        }
    }

    /// <inheritdoc/>
    public IEnumerator<Diagnostic> GetEnumerator() => diagnostics.GetEnumerator();

    /// <inheritdoc/>
    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

    /// <summary>
    /// Adds the diagnotics contained by the specified diagnostics bag into
    /// this instance.
    /// </summary>
    /// <param name="diagnostics">The diagnostics bag to copy from.</param>
    public void AddRange(DiagnosticBag diagnostics)
    {
        this.diagnostics.AddRange(diagnostics.diagnostics);
    }

    /// <summary>
    /// Adds a sequence of already-constructed diagnostics into this instance.
    /// Used to surface inner diagnostics (e.g. an interpolation hole's syntax
    /// errors) whose locations have already been mapped to the outer file.
    /// </summary>
    /// <param name="diagnostics">The diagnostics to copy in.</param>
    public void AddRange(IEnumerable<Diagnostic> diagnostics)
    {
        this.diagnostics.AddRange(diagnostics);
    }

    private void Report(TextLocation location, string id, string message, DiagnosticSeverity severity = DiagnosticSeverity.Error)
    {
        var diagnostic = new Diagnostic(location, id, severity, message);
        diagnostics.Add(diagnostic);
    }
}
