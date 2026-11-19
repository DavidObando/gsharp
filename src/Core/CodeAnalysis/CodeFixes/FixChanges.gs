// <copyright file="FixChanges.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

import System
import System.Collections.Immutable
import System.Linq

/// The changes of a fix, for each document that it edits (ADR-0227 D2).
class FixChanges {
    /// Initializes a new instance of the (cref:FixChanges) class.
    /// @param documents The changes of each document. The order is by file name, ordinal.
    init(documents ImmutableArray[DocumentChanges]) {
        Documents = if documents.IsDefault {
            ImmutableArray[DocumentChanges].Empty
        } else {
            documents.OrderBy((d DocumentChanges) -> d.Tree.Text.FileName, StringComparer.Ordinal).ToImmutableArray()
        }
    }

    /// Gets the changes of each document, ordered by file name (ordinal).
    prop Documents ImmutableArray[DocumentChanges] {
        get;
    }

    /// Gets a value that tells whether the fix changes nothing.
    prop IsEmpty bool -> Documents.All((d DocumentChanges) -> d.Changes.IsEmpty)
}
