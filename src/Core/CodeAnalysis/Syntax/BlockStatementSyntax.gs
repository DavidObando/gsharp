// <copyright file="BlockStatementSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents a block statement syntax in the language.
partial class BlockStatementSyntax : StatementSyntax {
    // Backing field for the property the parser assigns after construction. Its setter
    // invalidates the node's cached span (issue #1675).
    private var unsafeKeyword SyntaxToken?

    // Issue #1881: backing fields for the checked/unchecked contextual block
    // keyword, mirroring the unsafeKeyword pattern above.
    private var checkedKeyword SyntaxToken?

    private var uncheckedKeyword SyntaxToken?

    /// Initializes a new instance of the (cref:BlockStatementSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param openBraceToken The open brace token.
    /// @param statements The immutable array of statements.
    /// @param closeBraceToken The close brace token.
    init(
        syntaxTree SyntaxTree,
        openBraceToken SyntaxToken,
        statements ImmutableArray[StatementSyntax],
        closeBraceToken SyntaxToken
    ) : base(syntaxTree) {
        OpenBraceToken = openBraceToken
        Statements = statements
        CloseBraceToken = closeBraceToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.BlockStatement

    /// Gets or sets the optional `unsafe` contextual keyword (ADR-0122 / issue #1014) that introduces this
    /// block as an `unsafe { … }`
    /// contextual keyword that introduces this block as an `unsafe { … }`
    /// block. When non-null the statements in the block are bound in an
    /// `unsafe` context (unmanaged raw pointers and raw-pointer operations
    /// permitted). Assigned by the parser; `null` for ordinary blocks.
    prop UnsafeKeyword SyntaxToken? {
        get -> unsafeKeyword
        set {
            unsafeKeyword = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this block is an `unsafe { … }` block (ADR-0122 / issue #1014).
    prop IsUnsafe bool -> UnsafeKeyword != nil

    /// Gets or sets the optional `checked` contextual keyword (issue #1881)
    /// that introduces this block as a `checked { … }` block. When
    /// non-null, integral `+`/`-`/`*` and narrowing numeric
    /// conversions inside the block trap on overflow. Assigned by the parser;
    /// `null` for ordinary blocks.
    prop CheckedKeyword SyntaxToken? {
        get -> checkedKeyword
        set {
            checkedKeyword = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this block is a `checked { … }` block (issue #1881).
    prop IsChecked bool -> CheckedKeyword != nil

    /// Gets or sets the optional `unchecked` contextual keyword (issue #1881)
    /// that introduces this block as an `unchecked { … }` block, restoring
    /// truncating arithmetic/conversions inside the block. Assigned by the
    /// parser; `null` for ordinary blocks.
    prop UncheckedKeyword SyntaxToken? {
        get -> uncheckedKeyword
        set {
            uncheckedKeyword = value
            InvalidateCachedSpan()
        }
    }

    /// Gets a value indicating whether this block is an `unchecked { … }` block (issue #1881).
    prop IsUnchecked bool -> UncheckedKeyword != nil

    /// Gets the open brace token.
    prop OpenBraceToken SyntaxToken {
        get;
    }

    /// Gets the immutable array of statements.
    prop Statements ImmutableArray[StatementSyntax] {
        get;
    }

    /// Gets the close brace token.
    prop CloseBraceToken SyntaxToken {
        get;
    }

    /// Gets the ADR-0175 annotations written immediately before this block's
    /// `{` (`@SuppressDiagnostic("GSA0005") { … }`). Assigned by the
    /// parser; empty for ordinary blocks.
    /// @remarks Deliberately excluded from the node's children so the block's span stays
    /// exactly `{`..`}`: that span is the suppression scope, and a
    /// diagnostic reported on the annotation itself must not be inside it.
    private var _annotations ImmutableArray[AnnotationSyntax] = ImmutableArray[AnnotationSyntax].Empty

    @SyntaxChildIgnore
    prop Annotations ImmutableArray[AnnotationSyntax] {
        get {
            return _annotations
        }
        private set {
            _annotations = value
        }
    }

    /// Attaches parser-collected annotations to this block.
    /// @param annotations The annotations preceding the open brace.
    internal func WithAnnotations(annotations ImmutableArray[AnnotationSyntax]) {
        Annotations = if annotations.IsDefault {
            ImmutableArray[AnnotationSyntax].Empty
        } else {
            annotations
        }
    }
}
