// <copyright file="DiagnosticBag.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Runtime.CompilerServices

/// Represents a collection of code analysis diagnostics information.
partial class DiagnosticBag : IEnumerable[Diagnostic] {
    private let diagnostics ImmutableArray[Diagnostic].Builder = ImmutableArray.CreateBuilder[Diagnostic]()
    private let duplicateSuppressions Stack[List[Diagnostic]] = Stack[List[Diagnostic]]()

    // Issue #3734: one GS0547 per (file, offset, name) — a bare imported
    // homonym is looked up many times while binding a single reference.
    private let reportedImportedTypeAmbiguities HashSet[string] = HashSet[string](StringComparer.Ordinal)

    private let transactions Stack[List[Diagnostic]] = Stack[List[Diagnostic]]()

    // Issue #3887: the GS0158/GS0159 diagnostics raised by a member lookup on a
    // receiver that is already error-typed. They stay in `diagnostics` — the
    // binder's speculative-rebind paths use Count deltas and TruncateTo as
    // their success signal, so removing an entry outright silently changes
    // which overload/lookup path the binder commits to — and are filtered only
    // when diagnostics are READ.
    private let cascadeSuppressed HashSet[Diagnostic] = HashSet[Diagnostic](ReferenceEqualityComparer.Instance)

    // Issue #3887: nesting depth of member lookups performed on a receiver
    // whose type is already TypeSymbol.Error. See
    // SuppressMemberLookupCascadeIn.
    private var memberLookupCascadeDepth int32

    /// Gets the number of diagnostics currently held in the bag. Used together
    /// with (cref:TruncateTo) to discard speculative diagnostics emitted
    /// while binding an expression that is subsequently re-bound (e.g. issue
    /// #1238 target-typed conditional arguments).
    prop Count int32 -> diagnostics.Count

    /// Creates an immutable snapshot of the diagnostics currently held in the bag.
    /// @returns An immutable array of diagnostics in insertion order.
    func ToImmutableArray() ImmutableArray[Diagnostic] -> Visible().ToImmutableArray()

    /// Removes every diagnostic added after the bag reached [`count`](paramref)
    /// entries, restoring it to an earlier marked state. Used to roll back the
    /// speculative diagnostics produced while eagerly binding an expression that
    /// will be re-bound against a now-known target type.
    /// @param count The diagnostic count to truncate back to. Values
    /// outside the current range are clamped.
    func TruncateTo(count int32) {
        var count = count
        if count < 0 {
            count = 0
        }
        if count < diagnostics.Count {
            while diagnostics.Count > count {
                diagnostics.RemoveAt(diagnostics.Count - 1)
            }
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func GetEnumerator() IEnumerator[Diagnostic] -> Visible().GetEnumerator()

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()

    /// Adds the diagnotics contained by the specified diagnostics bag into
    /// this instance.
    /// @param diagnostics The diagnostics bag to copy from.
    func AddRange(diagnostics DiagnosticBag) {
        AddRange(diagnostics.diagnostics)
    }

    /// Adds a sequence of already-constructed diagnostics into this instance.
    /// Used to surface inner diagnostics (e.g. an interpolation hole's syntax
    /// errors) whose locations have already been mapped to the outer file.
    /// @param diagnostics The diagnostics to copy in.
    func AddRange(diagnostics IEnumerable[Diagnostic]) {
        for diagnostic in diagnostics {
            Add(diagnostic)
        }
    }

    /// Adds an already-constructed diagnostic to the bag. This is the public
    /// reporting entry point used by the analyzer framework (ADR-0169);
    /// compiler-internal reports go through the typed partial methods.
    /// @param diagnostic The diagnostic to add.
    func Report(diagnostic Diagnostic) {
        Add(diagnostic)
    }

    /// Runs a contextual rebind while suppressing only diagnostics already
    /// reported for the same syntax subtree. Each existing diagnostic can
    /// suppress one exact duplicate, preserving legitimate repeated reports.
    /// @typeparam T The result type of the binding operation.
    /// @param owner The syntax subtree whose existing diagnostics own
    /// any exact duplicates emitted by the rebind.
    /// @param bind The contextual binding operation.
    /// @returns The result of [`bind`](paramref).
    internal func SuppressDuplicateDiagnosticsIn[T](owner TextLocation, bind() -> T) T {
        var owner = owner
        let existing = diagnostics.Where(
            (diagnostic Diagnostic) -> object.ReferenceEquals(diagnostic.Location.Text, owner.Text) &&
                diagnostic
                .Location
                .Span
                .Start >= owner
                .Span
                .Start &&
                diagnostic
                .Location
                .Span
                .End <= owner
                .Span
                .End
        )
            .ToList()
        return SuppressDuplicateDiagnostics(existing, bind)
    }

    /// Suppresses exact existing reports during a whole-program analysis rerun.
    /// @typeparam T The operation result.
    /// @param bind The analysis operation.
    /// @returns The operation result.
    internal func SuppressDuplicateDiagnostics[T](bind() -> T) T -> SuppressDuplicateDiagnostics(
        diagnostics.ToList(),
        bind
    )

    private func SuppressDuplicateDiagnostics[T](existing List[Diagnostic], bind() -> T) T {
        if existing.Count == 0 {
            return bind()
        }
        duplicateSuppressions.Push(existing)
        try {
            return bind()
        } finally {
            duplicateSuppressions.Pop()
        }
    }

    /// Issue #3887: runs a member lookup whose receiver is already error-typed,
    /// dropping only the `GS0158 Cannot find member` / `GS0159 Cannot
    /// find function` that such a lookup is guaranteed to produce.
    ///
    /// The receiver can only carry `TypeSymbol.Error` downstream of an
    /// expression that was already diagnosed, so those two reports are always
    /// redundant with that earlier diagnostic — and actively misdirecting,
    /// since they name members that exist on the type the user meant. Every
    /// other diagnostic the lookup raises is kept.
    ///
    /// Nothing about BINDING changes — this alters which diagnostics are
    /// emitted, never what binds. Two narrower-looking designs were tried and
    /// are wrong:
    ///
    /// 1. Returning an error expression instead of performing the lookup. Member resolution has
    /// load-bearing side effects, and skipping it made an unrelated type stop resolving in a REPL session
    /// (`Issue710NullConditionalIndexingEmittedSessionTests`).
    /// 2. Dropping the diagnostic in `Add`. The binder's speculative rebinds use (cref:Count) deltas and
    /// (cref:TruncateTo) as their success signal, so never adding an entry silently changes which lookup
    /// path the binder COMMITS to — the same session tests failed again, for a second, different reason.
    ///
    /// So the entry is added exactly as before and merely marked; the filter
    /// happens when diagnostics are read. Count, TruncateTo and every binding
    /// decision see the bag unchanged.
    /// @typeparam T The result type of the binding operation.
    /// @param bind The member-lookup operation.
    /// @returns The result of [`bind`](paramref).
    internal func SuppressMemberLookupCascadeIn[T](bind() -> T) T {
        memberLookupCascadeDepth++
        try {
            return bind()
        } finally {
            memberLookupCascadeDepth--
        }
    }

    internal func BeginTransaction() Transaction {
        let added = List[Diagnostic]()
        transactions.Push(added)
        return Transaction(this, added)
    }

    /// Issue #3887: the diagnostics a caller should SEE — everything in the bag
    /// except the redundant member-lookup cascade recorded by
    /// (cref:SuppressMemberLookupCascadeIn{T}). The bag itself keeps
    /// those entries so (cref:Count) and (cref:TruncateTo) retain
    /// their exact meaning for the binder's speculative-rebind paths.
    private func Visible() IEnumerable[Diagnostic] -> if cascadeSuppressed.Count == 0 {
        cast[IEnumerable[Diagnostic]](diagnostics)
    } else {
        diagnostics.Where((d Diagnostic) -> !cascadeSuppressed.Contains(d))
    }

    private func Add(diagnostic Diagnostic) {
        // Issue #3887: mark — do NOT drop — the "cannot find member/function"
        // pair raised inside a lookup on an already-error-typed receiver. It
        // still enters the bag so Count keeps its exact current meaning (see
        // cascadeSuppressed), and is filtered out when diagnostics are read.
        if memberLookupCascadeDepth > 0 &&
            (
            diagnostic.Id == DiagnosticDescriptors
                .UnableToFindMember
                .Id ||
                diagnostic.Id == DiagnosticDescriptors
                .UnableToFindFunction
                .Id
        ) {
            cascadeSuppressed.Add(diagnostic)
        }
        if duplicateSuppressions.TryPeek(out var existing) {
            for var i = 0; i < existing.Count; i++ {
                if AreEquivalent(existing[i], diagnostic) {
                    existing.RemoveAt(i)
                    return
                }
            }
        }
        diagnostics.Add(diagnostic)
        for transaction in transactions {
            transaction.Add(diagnostic)
        }
    }

    private func CompleteTransaction(added List[Diagnostic], commit bool) {
        if !object.ReferenceEquals(transactions.Pop(), added) || commit {
            return
        }
        for var addedIndex = added.Count - 1; addedIndex >= 0; addedIndex-- {
            for var diagnosticIndex = diagnostics.Count - 1; diagnosticIndex >= 0; diagnosticIndex-- {
                if object.ReferenceEquals(diagnostics[diagnosticIndex], added[addedIndex]) {
                    diagnostics.RemoveAt(diagnosticIndex)
                    break
                }
            }
        }
    }

    private func Report(location TextLocation, descriptor DiagnosticDescriptor, messageArguments ...object) {
        Report(location, descriptor, descriptor.Severity, messageArguments)
    }

    private func ReportWithErrorPromotion(
        location TextLocation,
        descriptor DiagnosticDescriptor,
        promoteToError bool,
        messageArguments ...object
    ) {
        let severity = if promoteToError {
            DiagnosticSeverity.Error
        } else {
            descriptor.Severity
        }
        Report(location, descriptor, severity, messageArguments)
    }

    private func Report(
        location TextLocation,
        descriptor DiagnosticDescriptor,
        severity DiagnosticSeverity,
        messageArguments[]object
    ) {
        let message = string.Format(descriptor.MessageFormat, messageArguments)
        let diagnostic = Diagnostic(location, descriptor.Id, severity, message)
        Add(diagnostic)
    }

    internal class Transaction : IDisposable {
        private let owner DiagnosticBag
        private let added List[Diagnostic]
        private var completed bool

        internal init(owner DiagnosticBag, added List[Diagnostic]) {
            this.owner = owner
            this.added = added
        }

        func Dispose() {
            Complete(commit: false)
        }

        internal func Commit() {
            Complete(commit: true)
        }

        private func Complete(commit bool) {
            if completed {
                return
            }
            completed = true
            owner.CompleteTransaction(added, commit)
        }
    }

    shared {
        internal let EquivalenceComparer IEqualityComparer[Diagnostic] = EqualityComparer[Diagnostic].Create(
            (left Diagnostic?, right Diagnostic?) -> object.ReferenceEquals(left, right) ||
                (left != nil && right != nil && AreEquivalent(left, right)),
            (diagnostic Diagnostic) -> HashCode.Combine(
                diagnostic.Id,
                diagnostic.Severity,
                diagnostic.Message,
                if diagnostic.Location.Text is {} text {
                    RuntimeHelpers.GetHashCode(text)
                } else {
                    0
                },
                diagnostic.Location.Span.Start,
                diagnostic.Location.Span.Length
            )
        )

        private func AreEquivalent(left Diagnostic, right Diagnostic) bool {
            return left.Id == right.Id &&
                left.Severity == right.Severity &&
                left.Message == right.Message &&
                object.ReferenceEquals(left.Location.Text, right.Location.Text) &&
                left
                .Location
                .Span
                .Start == right
                .Location
                .Span
                .Start &&
                left
                .Location
                .Span
                .Length == right
                .Location
                .Span
                .Length &&
                left
                .AdditionalLocations
                .SequenceEqual(right.AdditionalLocations) &&
                left
                .Properties
                .Count == right
                .Properties
                .Count &&
                left
                .Properties
                .All(
                (property KeyValuePair[string, string?]) -> right.Properties.TryGetValue(property.Key, out var value) &&
                    property.Value == value
            )
        }
    }
}
