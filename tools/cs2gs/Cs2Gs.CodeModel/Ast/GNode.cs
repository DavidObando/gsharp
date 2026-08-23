// <copyright file="GNode.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.CodeModel.Ast;

/// <summary>
/// Base type for every node in the G# emit AST. The model is intentionally
/// small and composable; later migration steps add nodes without disturbing
/// the canonical pretty-printer contract (ADR-0115 §B).
/// </summary>
public abstract class GNode
{
    /// <summary>
    /// Gets or sets the author comment lines captured from the source C#
    /// node's leading trivia (issue #3469). Each entry is a complete comment
    /// line carrying its own marker (<c>// …</c> or <c>/// …</c>); the
    /// printer emits them, indented, immediately above the node. Block
    /// comments are normalized to <c>//</c> lines at capture time so the
    /// emitted G# stays in the canonical single-line form. <see langword="null"/>
    /// when the node has no attached comments (the overwhelmingly common
    /// case — synthesized nodes never carry any).
    /// </summary>
    public System.Collections.Generic.IReadOnlyList<string> AttachedComments { get; set; }

    /// <summary>
    /// Gets or sets the author comment that followed the source construct on
    /// the same line (issue #3501 B3), carrying its own <c>//</c> marker;
    /// the printer appends it after the rendered node. <see langword="null"/>
    /// when there is none.
    /// </summary>
    public string TrailingComment { get; set; }
}
