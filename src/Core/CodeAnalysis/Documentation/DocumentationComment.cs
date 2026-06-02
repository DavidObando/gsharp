// <copyright file="DocumentationComment.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Documentation;

/// <summary>
/// The internal, structured documentation model for a symbol (ADR-0057 §4). A single
/// surface for every IDE feature (hover, signature help, completion), populated either
/// from authored G# Markdown or from ingested C# XML-doc. Sections map 1:1 to the
/// standard XML-doc vocabulary so the model round-trips losslessly in both directions.
/// </summary>
/// <param name="Summary">The <c>&lt;summary&gt;</c> content.</param>
/// <param name="Parameters">The <c>&lt;param&gt;</c> entries (name + content).</param>
/// <param name="TypeParameters">The <c>&lt;typeparam&gt;</c> entries.</param>
/// <param name="Returns">The <c>&lt;returns&gt;</c> content.</param>
/// <param name="Remarks">The <c>&lt;remarks&gt;</c> content.</param>
/// <param name="Value">The <c>&lt;value&gt;</c> content (properties).</param>
/// <param name="Exceptions">The <c>&lt;exception&gt;</c> entries (cref + content).</param>
/// <param name="SeeAlso">The <c>&lt;seealso&gt;</c> references.</param>
public sealed record DocumentationComment(
    ImmutableArray<DocInline> Summary,
    ImmutableArray<DocParam> Parameters,
    ImmutableArray<DocParam> TypeParameters,
    ImmutableArray<DocInline> Returns,
    ImmutableArray<DocInline> Remarks,
    ImmutableArray<DocInline> Value,
    ImmutableArray<DocException> Exceptions,
    ImmutableArray<DocReference> SeeAlso)
{
    /// <summary>
    /// An empty documentation comment with every section defaulted to empty. Useful as
    /// a non-null sentinel and a builder base.
    /// </summary>
    public static readonly DocumentationComment Empty = new(
        ImmutableArray<DocInline>.Empty,
        ImmutableArray<DocParam>.Empty,
        ImmutableArray<DocParam>.Empty,
        ImmutableArray<DocInline>.Empty,
        ImmutableArray<DocInline>.Empty,
        ImmutableArray<DocInline>.Empty,
        ImmutableArray<DocException>.Empty,
        ImmutableArray<DocReference>.Empty);
}

/// <summary>
/// A named documentation entry — a <c>&lt;param&gt;</c> or <c>&lt;typeparam&gt;</c>.
/// </summary>
/// <param name="Name">The parameter or type-parameter name.</param>
/// <param name="Content">The documentation content.</param>
public sealed record DocParam(string Name, ImmutableArray<DocInline> Content);

/// <summary>
/// A documented exception — an <c>&lt;exception cref&gt;</c>.
/// </summary>
/// <param name="Cref">The exception type's documentation id (cref).</param>
/// <param name="Content">The documentation content.</param>
public sealed record DocException(string Cref, ImmutableArray<DocInline> Content);

/// <summary>
/// A <c>&lt;seealso&gt;</c> reference, to either a symbol (cref) or an external link (href).
/// </summary>
/// <param name="Cref">The target documentation id, or null when this is a link.</param>
/// <param name="Href">The external link target, or null when this is a cref.</param>
/// <param name="Content">The optional display content.</param>
public sealed record DocReference(string Cref, string Href, ImmutableArray<DocInline> Content);
