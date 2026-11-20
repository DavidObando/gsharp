// <copyright file="DocumentChanges.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable

/// The text changes of a fix in one document (ADR-0227 D2).
class DocumentChanges {
    /// Initializes a new instance of the (cref:DocumentChanges) class.
    /// @param tree The original tree.
    /// @param changes The changes, in positions of the original text and in position order.
    /// @param placeholders The placeholder spans in the changed text.
    init(tree SyntaxTree, changes ImmutableArray[TextChange], placeholders ImmutableArray[TextSpan]) {
        ArgumentNullException.ThrowIfNull(tree)
        Tree = tree
        Changes = if changes.IsDefault {
            ImmutableArray[TextChange].Empty
        } else {
            changes
        }
        Placeholders = if placeholders.IsDefault {
            ImmutableArray[TextSpan].Empty
        } else {
            placeholders
        }
    }

    /// Gets the original tree.
    prop Tree SyntaxTree {
        get;
    }

    /// Gets the changes, in positions of the original text and in position order.
    prop Changes ImmutableArray[TextChange] {
        get;
    }

    /// Gets the placeholder spans in the changed text (ADR-0227 D5).
    prop Placeholders ImmutableArray[TextSpan] {
        get;
    }

    /// Gets the text with the changes applied.
    /// @returns The changed text.
    func GetChangedText() SourceText -> Tree.Text.WithChanges(Changes)
}
