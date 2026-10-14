// <copyright file="GNode.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Ast

import System.Collections.Generic

/// Base type for every node in the G# emit AST. The model is intentionally
/// small and composable; later migration steps add nodes without disturbing
/// the canonical pretty-printer contract (ADR-0115 §B).
abstract class GNode {
    /// Gets or sets the author comment lines captured from the source C#
    /// node's leading trivia (issue #3469). Each entry is a complete comment
    /// line carrying its own marker (`// …` or `/// …`); the
    /// printer emits them, indented, immediately above the node. Block
    /// comments are normalized to `//` lines at capture time so the
    /// emitted G# stays in the canonical single-line form. `null`
    /// when the node has no attached comments (the overwhelmingly common
    /// case — synthesized nodes never carry any).
    prop AttachedComments IReadOnlyList[string]?

    /// Gets or sets the author comment that followed the source construct on
    /// the same line (issue #3501 B3), carrying its own `//` marker;
    /// the printer appends it after the rendered node. `null`
    /// when there is none.
    prop TrailingComment string?
}
