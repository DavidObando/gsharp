// <copyright file="CompilationUnitSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable
import System.Linq

/// Represents a compilation unit in the language.
@SyntaxChildSourceOrder
open partial class CompilationUnitSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:CompilationUnitSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param members The members of this compilation unit.
    /// @param endOfFileToken The end of file token.
    convenience init(syntaxTree SyntaxTree, members ImmutableArray[MemberSyntax], endOfFileToken SyntaxToken) {
        init(syntaxTree, ImmutableArray[AnnotationSyntax].Empty, members, endOfFileToken)
    }

    /// Initializes a new instance of the (cref:CompilationUnitSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param fileAttributes The file-level `@assembly:` and `@module:` annotations declared before the
    /// first member.
    /// @param members The members of this compilation unit.
    /// @param endOfFileToken The end of file token.
    init(
        syntaxTree SyntaxTree,
        fileAttributes ImmutableArray[AnnotationSyntax],
        members ImmutableArray[MemberSyntax],
        endOfFileToken SyntaxToken
    ) : base(syntaxTree) {
        FileAttributes = if fileAttributes.IsDefault {
            ImmutableArray[AnnotationSyntax].Empty
        } else {
            fileAttributes
        }
        AssemblyAttributes = FileAttributes.Where(
            (attribute AnnotationSyntax) -> attribute.Target?.KindIdentifier.Text == "assembly"
        )
            .ToImmutableArray()
        ModuleAttributes = FileAttributes.Where(
            (attribute AnnotationSyntax) -> attribute.Target?.KindIdentifier.Text == "module"
        )
            .ToImmutableArray()
        Members = members
        EndOfFileToken = endOfFileToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    open override prop Kind SyntaxKind -> SyntaxKind.CompilationUnit

    /// Gets the file-level `@assembly:` annotations declared before the
    /// first member (e.g. `@assembly:InternalsVisibleTo("Foo.Tests")`).
    /// These are producer-declared, assembly-scoped custom attributes — not
    /// attached to any single declaration.
    @SyntaxChildIgnore
    prop AssemblyAttributes ImmutableArray[AnnotationSyntax] {
        get;
    }

    /// Gets the file-level `@module:` annotations declared before the
    /// first member.
    @SyntaxChildIgnore
    prop ModuleAttributes ImmutableArray[AnnotationSyntax] {
        get;
    }

    /// Gets all file-level `@assembly:` and `@module:` annotations
    /// in source order.
    prop FileAttributes ImmutableArray[AnnotationSyntax] {
        get;
    }

    /// Gets the members of this compilation unit.
    prop Members ImmutableArray[MemberSyntax] {
        get;
    }

    /// Gets the end of file token of this compilation unit.
    prop EndOfFileToken SyntaxToken {
        get;
    }
}
