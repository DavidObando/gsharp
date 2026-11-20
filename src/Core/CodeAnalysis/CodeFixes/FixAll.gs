// <copyright file="FixAll.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable

/// The kind of a (cref:FixAllScope) (ADR-0227 D3).
enum FixAllScopeKind {
    /// One tree of one compilation.
    Document,

    /// Every tree of one compilation.
    Project,

    /// Every tree of several compilations, in the given order.
    Solution
}

/// The targets of a FixAll (ADR-0227 D3).
class FixAllScope {
    private init(kind FixAllScopeKind, compilations ImmutableArray[Compilation], tree SyntaxTree?) {
        Kind = kind
        Compilations = compilations
        Tree = tree
    }

    /// Gets the kind of the scope.
    prop Kind FixAllScopeKind {
        get;
    }

    /// Gets the compilations of the scope, in order.
    prop Compilations ImmutableArray[Compilation] {
        get;
    }

    /// Gets the tree of a (cref:FixAllScopeKind.Document) scope, else `null`.
    prop Tree SyntaxTree? {
        get;
    }

    shared {
        /// Creates a scope of one tree.
        /// @param compilation The compilation of the tree.
        /// @param tree A tree of the compilation.
        /// @returns The scope.
        func Document(compilation Compilation, tree SyntaxTree) FixAllScope {
            ArgumentNullException.ThrowIfNull(compilation)
            ArgumentNullException.ThrowIfNull(tree)
            if !compilation.SyntaxTrees.Contains(tree) {
                throw ArgumentException("The tree is not part of the compilation.", nameof(tree))
            }
            return FixAllScope(FixAllScopeKind.Document, ImmutableArray.Create(compilation), tree)
        }

        /// Creates a scope of every tree of one compilation.
        /// @param compilation The compilation.
        /// @returns The scope.
        func Project(compilation Compilation) FixAllScope {
            ArgumentNullException.ThrowIfNull(compilation)
            return FixAllScope(FixAllScopeKind.Project, ImmutableArray.Create(compilation), nil)
        }

        /// Creates a scope of every tree of several compilations.
        /// @param compilations The compilations, in the order that the service handles them.
        /// @returns The scope.
        func Solution(compilations ImmutableArray[Compilation]) FixAllScope {
            if compilations.IsDefault {
                throw ArgumentNullException(nameof(compilations))
            }
            return FixAllScope(FixAllScopeKind.Solution, compilations, nil)
        }
    }
}

/// The options of a FixAll (ADR-0227 D3).
class FixAllOptions {
    private var minimumApplicability Applicability = Applicability.MachineApplicable
    private var maxRounds int32 = 1

    /// Initializes a new instance of the (cref:FixAllOptions) class with the defaults.
    init() { }

    /// Gets or sets the least safe applicability that FixAll applies. The default is
    /// (cref:Applicability.MachineApplicable), for unattended hosts.
    prop MinimumApplicability Applicability {
        get -> minimumApplicability
        set -> minimumApplicability = value
    }

    /// Gets or sets the number of rounds. Round N + 1 runs on the result of round N, to apply the
    /// fixes that a conflict dropped. The default is 1.
    prop MaxRounds int32 {
        get -> maxRounds
        set {
            if value < 1 {
                throw ArgumentOutOfRangeException(nameof(value))
            }
            maxRounds = value
        }
    }

    /// Gets or sets the gate of each round, or `null` for none. A round whose complete edit set the
    /// gate rejects is not applied.
    prop Gate DeltaPolicy?

    /// Gets or sets the options of the gate's delta, and the analyzers whose diagnostics FixAll also fixes.
    prop DeltaOptions DeltaOptions?
}

/// Why FixAll did not apply a fix (ADR-0227 D3).
enum FixDropReason {
    /// The fix overlaps a fix that FixAll kept. A later round can apply it.
    Overlap,

    /// The provider threw.
    ProviderFailed,

    /// The fix is less safe than (cref:FixAllOptions.MinimumApplicability).
    ApplicabilityFiltered,

    /// The gate rejected the round.
    DeltaRejected,

    /// The provider does not support FixAll.
    NotSupported
}

/// A fix that FixAll did not apply.
class DroppedFix {
    internal init(diagnostic Diagnostic, fix CodeFix?, reason FixDropReason, round int32) {
        Diagnostic = diagnostic
        Fix = fix
        Reason = reason
        Round = round
    }

    /// Gets the diagnostic of the fix.
    prop Diagnostic Diagnostic {
        get;
    }

    /// Gets the fix, or `null` when the provider gave none.
    prop Fix CodeFix? {
        get;
    }

    /// Gets the reason.
    prop Reason FixDropReason {
        get;
    }

    /// Gets the round, from 1.
    prop Round int32 {
        get;
    }
}

/// A document that FixAll changed.
class FixAllDocument {
    internal init(original SyntaxTree, changed SyntaxTree) {
        Original = original
        Changed = changed
    }

    /// Gets the tree before FixAll.
    prop Original SyntaxTree {
        get;
    }

    /// Gets the parsed tree after the last round.
    prop Changed SyntaxTree {
        get;
    }

    /// Gets one change from the original text to the changed text: the span between their common
    /// prefix and their common suffix. Empty when the texts are equal.
    /// @returns The change.
    func GetChanges() ImmutableArray[TextChange] {
        let before = Original.Text.ToString()
        let after = Changed.Text.ToString()
        var prefix = 0
        let shortest = Math.Min(before.Length, after.Length)
        while prefix < shortest && before[prefix] == after[prefix] {
            prefix++
        }
        if prefix == before.Length && prefix == after.Length {
            return ImmutableArray[TextChange].Empty
        }
        var suffix = 0
        while suffix < shortest - prefix && before[before.Length - 1 - suffix] == after[after.Length - 1 - suffix] {
            suffix++
        }
        return ImmutableArray.Create(
            TextChange(
                TextSpan.FromBounds(prefix, before.Length - suffix),
                after.Substring(prefix, after.Length - suffix - prefix)
            )
        )
    }
}

/// The result of a FixAll (ADR-0227 D3).
class FixAllResult {
    internal init(
        applied ImmutableArray[CodeFix],
        dropped ImmutableArray[DroppedFix],
        documents ImmutableArray[FixAllDocument],
        compilations ImmutableArray[Compilation],
        rounds int32
    ) {
        Applied = applied
        Dropped = dropped
        Documents = documents
        Compilations = compilations
        Rounds = rounds
    }

    /// Gets the fixes that FixAll applied, in order.
    prop Applied ImmutableArray[CodeFix] {
        get;
    }

    /// Gets the fixes that FixAll did not apply. A fix dropped in one round and applied in a later
    /// one appears in both lists.
    prop Dropped ImmutableArray[DroppedFix] {
        get;
    }

    /// Gets the changed documents, ordered by file name (ordinal).
    prop Documents ImmutableArray[FixAllDocument] {
        get;
    }

    /// Gets a snapshot compilation for each compilation of the scope, with the changed trees.
    prop Compilations ImmutableArray[Compilation] {
        get;
    }

    /// Gets the number of rounds that ran.
    prop Rounds int32 {
        get;
    }
}
