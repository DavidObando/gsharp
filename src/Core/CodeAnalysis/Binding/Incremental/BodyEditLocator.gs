// <copyright file="BodyEditLocator.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable

/// Finds the one function body that an edit is confined to (ADR-0227 D4, issue #6128).
/// @remarks Every change must be strictly between the braces of the body of one function
/// declaration, the outermost one that contains them, and the edited tree must have the
/// skeleton of the old tree: the same text once every member body is blanked out
/// ((cref:IncrementalGlobalScopeReuse)). So no declaration, signature, attribute, import or
/// top-level statement changes, and no body other than the located one.
internal shared class BodyEditLocator {
    /// Locates the edited function body.
    /// @param oldTree The tree before the edit.
    /// @param newTree The tree after the edit, parsed from the changed text.
    /// @param changes The changes, on the text of [`oldTree`](paramref).
    /// @param oldDeclaration The declaration in [`oldTree`](paramref) whose body holds every change.
    /// @param newDeclaration The same declaration in [`newTree`](paramref).
    /// @returns `true` when the edit is confined to one function body.
    func TryLocate(
        oldTree SyntaxTree,
        newTree SyntaxTree,
        changes ImmutableArray[TextChange],
        out oldDeclaration FunctionDeclarationSyntax?,
        out newDeclaration FunctionDeclarationSyntax?
    ) bool {
        oldDeclaration = nil
        newDeclaration = nil
        if changes.IsDefaultOrEmpty {
            return false
        }
        var start = int32.MaxValue
        var end = int32.MinValue
        for change in changes {
            start = Math.Min(start, change.Span.Start)
            end = Math.Max(end, change.Span.End)
        }
        var found FunctionDeclarationSyntax? = nil
        for node in oldTree.Root.DescendantNodes() {
            if node is FunctionDeclarationSyntax declaration &&
                declaration.Body is {} body &&
                !body
                .OpenBraceToken
                .IsMissing &&
                !body
                .CloseBraceToken
                .IsMissing &&
                body
                .OpenBraceToken
                .Span
                .End <= start &&
                end <= body
                .CloseBraceToken
                .Span
                .Start &&
                (found == nil || declaration.Span.Start < found.Span.Start) {
                found = declaration
            }
        }
        if found == nil {
            return false
        }
        let oldSkeleton = IncrementalGlobalScopeReuse.BuildSkeleton(
            oldTree.Text,
            IncrementalGlobalScopeReuse.CollectBodySpans(oldTree)
        )
        let newSkeleton = IncrementalGlobalScopeReuse.BuildSkeleton(
            newTree.Text,
            IncrementalGlobalScopeReuse.CollectBodySpans(newTree)
        )
        if !string.Equals(oldSkeleton, newSkeleton, StringComparison.Ordinal) {
            return false
        }
        // The edit starts after the opening brace, so the declaration keeps its position.
        var match FunctionDeclarationSyntax? = nil
        for node in newTree.Root.DescendantNodes() {
            if node is FunctionDeclarationSyntax candidate &&
                candidate
                .Span
                .Start == found
                .Span
                .Start &&
                candidate.Body is {} candidateBody &&
                candidateBody
                .OpenBraceToken
                .Span
                .Start == found.Body!!
                .OpenBraceToken
                .Span
                .Start &&
                candidate
                .Identifier
                .Text == found
                .Identifier
                .Text {
                match = candidate
                break
            }
        }
        if match == nil || match.Body!!.CloseBraceToken.IsMissing {
            return false
        }
        oldDeclaration = found
        newDeclaration = match
        return true
    }
}
