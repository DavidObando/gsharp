// <copyright file="CodeFix.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

import GSharp.Core.CodeAnalysis
import System
import System.Collections.Immutable
import System.Threading
import SystemObject = System.Object

/// A fix for one or more diagnostics (ADR-0227 D2). The changes are computed on first use and
/// then kept, so a host can list titles before it computes edits.
class CodeFix {
    private let compute(CancellationToken) -> FixChanges
    private let gate object = SystemObject()
    private var changes FixChanges?

    /// Initializes a new instance of the (cref:CodeFix) class.
    /// @param title The title that a person sees.
    /// @param equivalenceKey The key of the kind of fix. FixAll groups fixes by it.
    /// @param applicability How safely a host can apply the fix.
    /// @param diagnostics The diagnostics that the fix is for.
    /// @param providerId The stable name of the provider.
    /// @param compute Computes the changes. The result for one input must always be the same.
    init(
        title string,
        equivalenceKey string,
        applicability Applicability,
        diagnostics ImmutableArray[Diagnostic],
        providerId string,
        compute(CancellationToken) -> FixChanges
    ) {
        ArgumentException.ThrowIfNullOrEmpty(title)
        ArgumentException.ThrowIfNullOrEmpty(equivalenceKey)
        ArgumentException.ThrowIfNullOrEmpty(providerId)
        ArgumentNullException.ThrowIfNull(compute)
        Title = title
        EquivalenceKey = equivalenceKey
        Applicability = applicability
        Diagnostics = if diagnostics.IsDefault {
            ImmutableArray[Diagnostic].Empty
        } else {
            diagnostics
        }
        ProviderId = providerId
        this.compute = compute
    }

    /// Gets the title that a person sees.
    prop Title string {
        get;
    }

    /// Gets the key of the kind of fix. Two fixes with one key make the same kind of change.
    prop EquivalenceKey string {
        get;
    }

    /// Gets how safely a host can apply the fix (ADR-0227 D5).
    prop Applicability Applicability {
        get;
    }

    /// Gets the diagnostics that the fix is for.
    prop Diagnostics ImmutableArray[Diagnostic] {
        get;
    }

    /// Gets the stable name of the provider or program that made the fix.
    prop ProviderId string {
        get;
    }

    // The provider that registered the fix, set by the service; null for a fix built elsewhere.
    internal prop Provider GSharpCodeFixProvider? {
        get -> registeringProvider
    }

    private var registeringProvider GSharpCodeFixProvider?

    internal func MarkProvider(provider GSharpCodeFixProvider) {
        registeringProvider = provider
    }

    /// Gets a value that tells whether a data-defined provider made the fix (ADR-0227 D6). A host
    /// runs the full delta gate on such a fix (decision Q4).
    prop IsDataDefined bool {
        get -> dataDefined
    }

    private var dataDefined bool

    internal func MarkDataDefined() {
        dataDefined = true
    }

    /// Gets the changes of the fix. The first call computes them. Later calls return the same object.
    /// @param cancellationToken Cancels the computation.
    /// @returns The changes.
    func GetChanges(cancellationToken CancellationToken = default(CancellationToken)) FixChanges {
        let existing = Volatile.Read[FixChanges?](&changes)
        if existing != nil {
            return existing
        }
        // One computation: a second caller waits for the first.
        lock gate {
            if changes == nil {
                Volatile.Write[FixChanges?](&changes, compute(cancellationToken))
            }
            return changes!!
        }
    }

    /// Returns a copy of this fix with a lower applicability (ADR-0227 D5). A host can lower the
    /// applicability of a fix, never raise it.
    /// @param applicability The new applicability.
    /// @returns The copy, or this fix when the applicability does not go down.
    func WithLowerApplicability(applicability Applicability) CodeFix {
        if Rank(applicability) <= Rank(Applicability) {
            return this
        }
        let lowered = CodeFix(
            Title,
            EquivalenceKey,
            applicability,
            Diagnostics,
            ProviderId,
            (ct CancellationToken) -> GetChanges(ct)
        )
        // The copy keeps where the fix came from, so a host still gates a data-defined fix fully.
        lowered.registeringProvider = registeringProvider
        lowered.dataDefined = dataDefined
        return lowered
    }

    /// Returns the title.
    /// @returns The title.
    override func ToString() string -> Title

    shared {
        // Unspecified counts as MaybeIncorrect (ADR-0227 D5).
        internal func Rank(applicability Applicability) int32 -> switch applicability {
            case Applicability.MachineApplicable: 0
            case Applicability.MaybeIncorrect: 1
            case Applicability.Unspecified: 1
            default: 2
        }
    }
}
