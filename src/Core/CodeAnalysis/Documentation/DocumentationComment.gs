// <copyright file="DocumentationComment.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Documentation

import System
import System.Collections.Immutable

/// The internal, structured documentation model for a symbol (ADR-0057 §4). A single
/// surface for every IDE feature (hover, signature help, completion), populated either
/// from authored G# Markdown or from ingested C# XML-doc. Sections map 1:1 to the
/// standard XML-doc vocabulary so the model round-trips losslessly in both directions.
/// @param Summary The `<summary>` content.
/// @param Parameters The `<param>` entries (name + content).
/// @param TypeParameters The `<typeparam>` entries.
/// @param Returns The `<returns>` content.
/// @param Remarks The `<remarks>` content.
/// @param Value The `<value>` content (properties).
/// @param Exceptions The `<exception>` entries (cref + content).
/// @param SeeAlso The `<seealso>` references.
data class DocumentationComment(
    Summary ImmutableArray[DocInline],
    Parameters ImmutableArray[DocParam],
    TypeParameters ImmutableArray[DocParam],
    Returns ImmutableArray[DocInline],
    Remarks ImmutableArray[DocInline],
    Value ImmutableArray[DocInline],
    Exceptions ImmutableArray[DocException],
    SeeAlso ImmutableArray[DocReference]
) : IEquatable[DocumentationComment] {
    shared {
        /// An empty documentation comment with every section defaulted to empty. Useful as
        /// a non-null sentinel and a builder base.
        let Empty DocumentationComment = DocumentationComment(
            ImmutableArray[DocInline].Empty,
            ImmutableArray[DocParam].Empty,
            ImmutableArray[DocParam].Empty,
            ImmutableArray[DocInline].Empty,
            ImmutableArray[DocInline].Empty,
            ImmutableArray[DocInline].Empty,
            ImmutableArray[DocException].Empty,
            ImmutableArray[DocReference].Empty
        )
    }
}

/// A named documentation entry — a `<param>` or `<typeparam>`.
/// @param Name The parameter or type-parameter name.
/// @param Content The documentation content.
data class DocParam(Name string?, Content ImmutableArray[DocInline]) : IEquatable[DocParam] { }

/// A documented exception — an `<exception cref>`.
/// @param Cref The exception type's documentation id (cref).
/// @param Content The documentation content.
data class DocException(Cref string?, Content ImmutableArray[DocInline]) : IEquatable[DocException] { }

/// A `<seealso>` reference, to either a symbol (cref) or an external link (href).
/// @param Cref The target documentation id, or null when this is a link.
/// @param Href The external link target, or null when this is a cref.
/// @param Content The optional display content.
data class DocReference(Cref string?, Href string?, Content ImmutableArray[DocInline]) : IEquatable[DocReference] { }
