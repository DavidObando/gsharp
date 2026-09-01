// <copyright file="DiagnosticBag.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
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
    private readonly Stack<List<Diagnostic>> duplicateSuppressions = new();

    // Issue #3734: one GS0547 per (file, offset, name) — a bare imported
    // homonym is looked up many times while binding a single reference.
    private readonly HashSet<string> reportedImportedTypeAmbiguities = new(StringComparer.Ordinal);

    private readonly Stack<List<Diagnostic>> transactions = new();

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
        AddRange(diagnostics.diagnostics);
    }

    /// <summary>
    /// Adds a sequence of already-constructed diagnostics into this instance.
    /// Used to surface inner diagnostics (e.g. an interpolation hole's syntax
    /// errors) whose locations have already been mapped to the outer file.
    /// </summary>
    /// <param name="diagnostics">The diagnostics to copy in.</param>
    public void AddRange(IEnumerable<Diagnostic> diagnostics)
    {
        foreach (var diagnostic in diagnostics)
        {
            Add(diagnostic);
        }
    }

    /// <summary>
    /// Adds an already-constructed diagnostic to the bag. This is the public
    /// reporting entry point used by the analyzer framework (ADR-0169);
    /// compiler-internal reports go through the typed partial methods.
    /// </summary>
    /// <param name="diagnostic">The diagnostic to add.</param>
    public void Report(Diagnostic diagnostic)
    {
        Add(diagnostic);
    }

    /// <summary>
    /// Runs a contextual rebind while suppressing only diagnostics already
    /// reported for the same syntax subtree. Each existing diagnostic can
    /// suppress one exact duplicate, preserving legitimate repeated reports.
    /// </summary>
    /// <typeparam name="T">The result type of the binding operation.</typeparam>
    /// <param name="owner">The syntax subtree whose existing diagnostics own
    /// any exact duplicates emitted by the rebind.</param>
    /// <param name="bind">The contextual binding operation.</param>
    /// <returns>The result of <paramref name="bind"/>.</returns>
    internal T SuppressDuplicateDiagnosticsIn<T>(TextLocation owner, Func<T> bind)
    {
        var existing = diagnostics
            .Where(diagnostic =>
                ReferenceEquals(diagnostic.Location.Text, owner.Text)
                && diagnostic.Location.Span.Start >= owner.Span.Start
                && diagnostic.Location.Span.End <= owner.Span.End)
            .ToList();
        if (existing.Count == 0)
        {
            return bind();
        }

        duplicateSuppressions.Push(existing);
        try
        {
            return bind();
        }
        finally
        {
            duplicateSuppressions.Pop();
        }
    }

    internal Transaction BeginTransaction()
    {
        var added = new List<Diagnostic>();
        transactions.Push(added);
        return new Transaction(this, added);
    }

    private void Add(Diagnostic diagnostic)
    {
        if (duplicateSuppressions.TryPeek(out var existing))
        {
            for (var i = 0; i < existing.Count; i++)
            {
                if (AreEquivalent(existing[i], diagnostic))
                {
                    existing.RemoveAt(i);
                    return;
                }
            }
        }

        diagnostics.Add(diagnostic);
        foreach (var transaction in transactions)
        {
            transaction.Add(diagnostic);
        }
    }

    private void CompleteTransaction(List<Diagnostic> added, bool commit)
    {
        if (!ReferenceEquals(transactions.Pop(), added) || commit)
        {
            return;
        }

        for (var addedIndex = added.Count - 1; addedIndex >= 0; addedIndex--)
        {
            for (var diagnosticIndex = diagnostics.Count - 1; diagnosticIndex >= 0; diagnosticIndex--)
            {
                if (ReferenceEquals(diagnostics[diagnosticIndex], added[addedIndex]))
                {
                    diagnostics.RemoveAt(diagnosticIndex);
                    break;
                }
            }
        }
    }

    private static bool AreEquivalent(Diagnostic left, Diagnostic right)
    {
        return left.Id == right.Id
            && left.Severity == right.Severity
            && left.Message == right.Message
            && ReferenceEquals(left.Location.Text, right.Location.Text)
            && left.Location.Span.Start == right.Location.Span.Start
            && left.Location.Span.Length == right.Location.Span.Length
            && left.AdditionalLocations.SequenceEqual(right.AdditionalLocations)
            && left.Properties.Count == right.Properties.Count
            && left.Properties.All(property =>
                right.Properties.TryGetValue(property.Key, out var value)
                && property.Value == value);
    }

    private void Report(TextLocation location, DiagnosticDescriptor descriptor, params object[] messageArguments)
    {
        Report(location, descriptor, descriptor.Severity, messageArguments);
    }

    private void ReportWithErrorPromotion(
        TextLocation location,
        DiagnosticDescriptor descriptor,
        bool promoteToError,
        params object[] messageArguments)
    {
        var severity = promoteToError ? DiagnosticSeverity.Error : descriptor.Severity;
        Report(location, descriptor, severity, messageArguments);
    }

    private void Report(
        TextLocation location,
        DiagnosticDescriptor descriptor,
        DiagnosticSeverity severity,
        object[] messageArguments)
    {
        var message = string.Format(descriptor.MessageFormat, messageArguments);
        var diagnostic = new Diagnostic(location, descriptor.Id, severity, message);
        Add(diagnostic);
    }

    internal sealed class Transaction : IDisposable
    {
        private readonly DiagnosticBag owner;
        private readonly List<Diagnostic> added;
        private bool completed;

        internal Transaction(DiagnosticBag owner, List<Diagnostic> added)
        {
            this.owner = owner;
            this.added = added;
        }

        public void Dispose()
        {
            Complete(commit: false);
        }

        internal void Commit()
        {
            Complete(commit: true);
        }

        private void Complete(bool commit)
        {
            if (completed)
            {
                return;
            }

            completed = true;
            owner.CompleteTransaction(added, commit);
        }
    }
}
