// <copyright file="DiagnosticBag.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
using System.Collections;
using System.Collections.Generic;
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

    private readonly List<Diagnostic> diagnostics = new List<Diagnostic>();

    /// <summary>
    /// Gets the number of diagnostics currently held in the bag. Used together
    /// with <see cref="TruncateTo"/> to discard speculative diagnostics emitted
    /// while binding an expression that is subsequently re-bound (e.g. issue
    /// #1238 target-typed conditional arguments).
    /// </summary>
    public int Count => diagnostics.Count;

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
}
