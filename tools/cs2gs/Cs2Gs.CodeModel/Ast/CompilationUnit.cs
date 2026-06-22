// <copyright file="CompilationUnit.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace Cs2Gs.CodeModel.Ast;

/// <summary>
/// A G# compilation unit: an optional package declaration, an import block, and
/// ordered top-level members/statements (ADR-0115 §B.1). This is the root node
/// the canonical pretty-printer consumes.
/// </summary>
public sealed class CompilationUnit : GNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="CompilationUnit"/> class.
    /// </summary>
    /// <param name="package">The package name, or <see langword="null"/> for none.</param>
    /// <param name="imports">The import directives, in original order.</param>
    /// <param name="members">The ordered top-level members and statements.</param>
    /// <param name="leadingComments">Optional file-leading comment lines (without the <c>//</c> prefix).</param>
    public CompilationUnit(
        string package = null,
        IReadOnlyList<ImportDirective> imports = null,
        IReadOnlyList<GNode> members = null,
        IReadOnlyList<string> leadingComments = null)
    {
        Package = package;
        Imports = imports ?? new List<ImportDirective>();
        Members = members ?? new List<GNode>();
        LeadingComments = leadingComments ?? new List<string>();
    }

    /// <summary>Gets the package name, or <see langword="null"/> for none.</summary>
    public string Package { get; }

    /// <summary>Gets the import directives, in original order.</summary>
    public IReadOnlyList<ImportDirective> Imports { get; }

    /// <summary>Gets the ordered top-level members and statements.</summary>
    public IReadOnlyList<GNode> Members { get; }

    /// <summary>Gets the file-leading comment lines (without the <c>//</c> prefix).</summary>
    public IReadOnlyList<string> LeadingComments { get; }
}

/// <summary>
/// An <c>import X.Y</c> directive, optionally aliased (<c>import A = X.Y</c>)
/// (ADR-0115 §B.1).
/// </summary>
public sealed class ImportDirective : GNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ImportDirective"/> class.
    /// </summary>
    /// <param name="name">The imported dotted name.</param>
    /// <param name="alias">The optional alias.</param>
    public ImportDirective(string name, string alias = null)
    {
        Name = name;
        Alias = alias;
    }

    /// <summary>Gets the imported dotted name.</summary>
    public string Name { get; }

    /// <summary>Gets the optional alias.</summary>
    public string Alias { get; }
}
