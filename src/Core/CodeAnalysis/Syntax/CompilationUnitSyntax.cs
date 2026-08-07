// <copyright file="CompilationUnitSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System.Collections.Immutable;
using System.Linq;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a compilation unit in the language.
/// </summary>
public class CompilationUnitSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="CompilationUnitSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="members">The members of this compilation unit.</param>
    /// <param name="endOfFileToken">The end of file token.</param>
    public CompilationUnitSyntax(SyntaxTree syntaxTree, ImmutableArray<MemberSyntax> members, SyntaxToken endOfFileToken)
        : this(syntaxTree, ImmutableArray<AnnotationSyntax>.Empty, members, endOfFileToken)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="CompilationUnitSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="fileAttributes">The file-level <c>@assembly:</c> and <c>@module:</c> annotations declared before the first member.</param>
    /// <param name="members">The members of this compilation unit.</param>
    /// <param name="endOfFileToken">The end of file token.</param>
    public CompilationUnitSyntax(SyntaxTree syntaxTree, ImmutableArray<AnnotationSyntax> fileAttributes, ImmutableArray<MemberSyntax> members, SyntaxToken endOfFileToken)
        : base(syntaxTree)
    {
        FileAttributes = fileAttributes.IsDefault ? ImmutableArray<AnnotationSyntax>.Empty : fileAttributes;
        AssemblyAttributes = FileAttributes
            .Where(attribute => attribute.Target?.KindIdentifier.Text == "assembly")
            .ToImmutableArray();
        ModuleAttributes = FileAttributes
            .Where(attribute => attribute.Target?.KindIdentifier.Text == "module")
            .ToImmutableArray();
        Members = members;
        EndOfFileToken = endOfFileToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.CompilationUnit;

    /// <summary>
    /// Gets the file-level <c>@assembly:</c> annotations declared before the
    /// first member (e.g. <c>@assembly:InternalsVisibleTo("Foo.Tests")</c>).
    /// These are producer-declared, assembly-scoped custom attributes — not
    /// attached to any single declaration.
    /// </summary>
    [SyntaxChildIgnore]
    public ImmutableArray<AnnotationSyntax> AssemblyAttributes { get; }

    /// <summary>
    /// Gets the file-level <c>@module:</c> annotations declared before the
    /// first member.
    /// </summary>
    [SyntaxChildIgnore]
    public ImmutableArray<AnnotationSyntax> ModuleAttributes { get; }

    /// <summary>
    /// Gets all file-level <c>@assembly:</c> and <c>@module:</c> annotations
    /// in source order.
    /// </summary>
    public ImmutableArray<AnnotationSyntax> FileAttributes { get; }

    /// <summary>
    /// Gets the members of this compilation unit.
    /// </summary>
    public ImmutableArray<MemberSyntax> Members { get; }

    /// <summary>
    /// Gets the end of file token of this compilation unit.
    /// </summary>
    public SyntaxToken EndOfFileToken { get; }
}
