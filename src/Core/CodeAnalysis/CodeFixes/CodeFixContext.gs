// <copyright file="CodeFixContext.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Threading

/// The input of (cref:GSharpCodeFixProvider.RegisterCodeFixes) (ADR-0227 D2).
class CodeFixContext {
    private let fixes List[CodeFix] = List[CodeFix]()
    private var semanticModel SemanticModel?

    internal init(
        diagnostic Diagnostic,
        tree SyntaxTree,
        compilation Compilation,
        providerId string,
        cancellationToken CancellationToken
    ) {
        Diagnostic = diagnostic
        Tree = tree
        Compilation = compilation
        ProviderId = providerId
        CancellationToken = cancellationToken
    }

    /// Gets the diagnostic to fix.
    prop Diagnostic Diagnostic {
        get;
    }

    /// Gets the tree that holds the diagnostic.
    prop Tree SyntaxTree {
        get;
    }

    /// Gets the compilation that reported the diagnostic. A provider must not change it.
    prop Compilation Compilation {
        get;
    }

    /// Gets the semantic model of (cref:Tree). The first read creates it.
    prop SemanticModel SemanticModel {
        get {
            if semanticModel == nil {
                semanticModel = Compilation.GetSemanticModel(Tree)
            }
            return semanticModel!!
        }
    }

    /// Gets the token that cancels the registration.
    prop CancellationToken CancellationToken {
        get;
    }

    internal prop ProviderId string {
        get;
    }

    internal prop Fixes IReadOnlyList[CodeFix] -> fixes

    /// Registers a fix in (cref:Tree). The service calls [`compute`](paramref) when a host asks
    /// for the changes, with a new editor of (cref:Tree).
    /// @param title The title that a person sees.
    /// @param equivalenceKey The key of the kind of fix.
    /// @param applicability How safely a host can apply the fix.
    /// @param compute Records the edits of the fix.
    func RegisterFix(title string, equivalenceKey string, applicability Applicability, compute(SyntaxEditor) -> void) {
        ArgumentNullException.ThrowIfNull(compute)
        let tree = Tree
        fixes.Add(
            CodeFix(
                title,
                equivalenceKey,
                applicability,
                ImmutableArray.Create(Diagnostic),
                ProviderId,
                (ct CancellationToken) -> {
                    ct.ThrowIfCancellationRequested()
                    let editor = SyntaxEditor(tree)
                    compute(editor)
                    return FixChanges(
                        ImmutableArray.Create(DocumentChanges(tree, editor.GetChanges(), editor.GetPlaceholders()))
                    )
                }
            )
        )
    }

    /// Registers a fix that a provider built itself, for example one with changes in more than one tree.
    /// @param fix The fix.
    func RegisterFix(fix CodeFix) {
        ArgumentNullException.ThrowIfNull(fix)
        fixes.Add(fix)
    }
}
