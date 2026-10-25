// <copyright file="StructLiteralExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents a struct composite literal: `Point{X: 1, Y: 2}` (Phase 3.B.1).
/// ADR-0180: (cref:Elements) may also interleave bare content elements
/// and non-leading `...source` content spreads with the
/// `Field: value` members, e.g.
/// `Container{ Width: 320.0, Text("Account"), ...rows }`.
@SyntaxChildSourceOrder
partial class StructLiteralExpressionSyntax : ExpressionSyntax {
    // Backing field for the property the parser assigns after construction. Its setter
    // invalidates the node's cached span (issue #1675).
    private var typeArgumentList TypeArgumentListSyntax?

    // ADR-0180: lazily computed, filtered view of Elements exposing only the
    // FieldInitializerSyntax members, for the many pre-existing binder paths
    // (ADR-0148 structural projection, imported-CLR-type/type-parameter
    // construction, generic type-argument inference) that only ever cared
    // about members and never need to see a content element or spread.
    private var cachedInitializers SeparatedSyntaxList[FieldInitializerSyntax]?

    /// Initializes a new instance of the (cref:StructLiteralExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param typeIdentifier The struct type identifier.
    /// @param openBraceToken The opening brace.
    /// @param spreadToken The optional leading ellipsis (ADR-0148 structural spread).
    /// @param spreadExpression The optional spread source.
    /// @param spreadSeparatorToken The optional separator after the spread source.
    /// @param elements The ordered field-initializer / content-element / content-spread elements
    /// (ADR-0180).
    /// @param closeBraceToken The closing brace.
    init(
        syntaxTree SyntaxTree,
        typeIdentifier SyntaxToken,
        openBraceToken SyntaxToken,
        spreadToken SyntaxToken?,
        spreadExpression ExpressionSyntax?,
        spreadSeparatorToken SyntaxToken?,
        elements SeparatedSyntaxList[StructLiteralElementSyntax],
        closeBraceToken SyntaxToken
    ) : base(syntaxTree) {
        TypeIdentifier = typeIdentifier
        OpenBraceToken = openBraceToken
        SpreadToken = spreadToken
        SpreadExpression = spreadExpression
        SpreadSeparatorToken = spreadSeparatorToken
        Elements = elements
        CloseBraceToken = closeBraceToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.StructLiteralExpression

    /// Gets the struct type identifier.
    prop TypeIdentifier SyntaxToken {
        get;
    }

    /// Gets the opening brace.
    prop OpenBraceToken SyntaxToken {
        get;
    }

    /// Gets the optional leading `...` token.
    prop SpreadToken SyntaxToken? {
        get;
    }

    /// Gets the optional source expression whose public shape is projected.
    prop SpreadExpression ExpressionSyntax? {
        get;
    }

    /// Gets the comma separating the spread from explicit overrides, when present.
    prop SpreadSeparatorToken SyntaxToken? {
        get;
    }

    /// Gets the ordered field-initializer / content-element / content-spread elements (ADR-0180).
    prop Elements SeparatedSyntaxList[StructLiteralElementSyntax] {
        get;
    }

    /// Gets the field initializers only, in source order, filtered out of
    /// (cref:Elements) (ADR-0180). Ignored by (cref:SyntaxNode.GetChildren)
    /// — (cref:Elements) is the authoritative child list — so consumers that
    /// only care about members (ADR-0148 structural projection, imported-CLR-type
    /// and type-parameter construction, generic type-argument inference) can keep
    /// reading this exactly as before.
    @SyntaxChildIgnore
    prop Initializers SeparatedSyntaxList[FieldInitializerSyntax] {
        get {
            if cachedInitializers != nil {
                return cachedInitializers!!
            }
            // Reuse the REAL separator token that preceded each kept member in
            // Elements' own nodes-and-separators array, rather than
            // synthesizing a fresh comma — this keeps every token in the
            // filtered view an authentic token from the source (correct span
            // and text), even though the view is necessarily lossy about
            // which content elements sat between two kept members.
            let raw = Elements.GetWithSeparators()
            let builder = ImmutableArray.CreateBuilder[SyntaxNode]()
            for var i = 0; i < raw.Length; i += 2 {
                if raw[i] is not FieldInitializerSyntax memberInitializer {
                    continue
                }
                if builder.Count > 0 {
                    builder.Add(raw[i - 1])
                }
                builder.Add(memberInitializer)
            }
            // A trailing separator (raw ends in node, separator) is only
            // authentic to the filtered view when the true final source
            // element is itself a kept member — otherwise the separator
            // followed a content element/spread that this view drops, and
            // fabricating a trailing comma after the last kept member would
            // misrepresent the source.
            if raw.Length > 0 && raw.Length % 2 == 0 && raw[^2] is FieldInitializerSyntax {
                builder.Add(raw[^1])
            }
            let result = SeparatedSyntaxList[FieldInitializerSyntax](builder.ToImmutable())
            cachedInitializers = result
            return result
        }
    }

    /// Gets the closing brace.
    prop CloseBraceToken SyntaxToken {
        get;
    }

    /// Gets or sets the optional type-argument list (Phase 4.3 / ADR-0020), e.g.
    /// `Result[int, string]{...}`. `null` for non-generic literals or for literals whose type arguments are
    /// to be inferred.
    prop TypeArgumentList TypeArgumentListSyntax? {
        get -> typeArgumentList
        set {
            typeArgumentList = value
            InvalidateCachedSpan()
        }
    }
}
