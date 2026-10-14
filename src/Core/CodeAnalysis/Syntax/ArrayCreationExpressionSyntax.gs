// <copyright file="ArrayCreationExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents an array creation expression `[N]T{e1, e2, …}`.
///
/// Issue #1272: also represents the runtime/zero-initialised allocation form
/// `[n]T` (and the equivalent empty-initializer spelling `[n]T{}`),
/// where `n` is an arbitrary length expression and there are no element
/// initialisers. That form carries its length via (cref:LengthExpression)
/// instead of the literal (cref:LengthToken), and yields a
/// zero-initialised slice `[]T` of length `n`.
class ArrayCreationExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:ArrayCreationExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param openBracketToken The opening bracket token.
    /// @param lengthToken The literal length token.
    /// @param closeBracketToken The closing bracket token.
    /// @param elementTypeIdentifier The element type identifier.
    /// @param openBraceToken The opening brace token.
    /// @param elements The element initialisers.
    /// @param closeBraceToken The closing brace token.
    init(
        syntaxTree SyntaxTree,
        openBracketToken SyntaxToken,
        lengthToken SyntaxToken?,
        closeBracketToken SyntaxToken,
        elementTypeIdentifier SyntaxToken,
        openBraceToken SyntaxToken?,
        elements SeparatedSyntaxList[ExpressionSyntax]?,
        closeBraceToken SyntaxToken?
    ) : base(syntaxTree) {
        OpenBracketToken = openBracketToken
        LengthToken = lengthToken
        CloseBracketToken = closeBracketToken
        ElementTypeIdentifier = elementTypeIdentifier
        OpenBraceToken = openBraceToken
        Elements = elements
        CloseBraceToken = closeBraceToken
    }

    /// Initializes a new instance of the (cref:ArrayCreationExpressionSyntax) class
    /// whose element type is itself a (non-identifier) nested type clause — enabling
    /// jagged-array literals such as `[][]int32{ []int32{1}, []int32{2, 3} }` (issue #1046).
    /// @param syntaxTree The parent syntax tree.
    /// @param openBracketToken The opening bracket token.
    /// @param lengthToken The literal length token.
    /// @param closeBracketToken The closing bracket token.
    /// @param elementTypeClause The nested element type clause.
    /// @param openBraceToken The opening brace token.
    /// @param elements The element initialisers.
    /// @param closeBraceToken The closing brace token.
    init(
        syntaxTree SyntaxTree,
        openBracketToken SyntaxToken,
        lengthToken SyntaxToken?,
        closeBracketToken SyntaxToken,
        elementTypeClause TypeClauseSyntax,
        openBraceToken SyntaxToken?,
        elements SeparatedSyntaxList[ExpressionSyntax]?,
        closeBraceToken SyntaxToken?
    ) : base(syntaxTree) {
        OpenBracketToken = openBracketToken
        LengthToken = lengthToken
        CloseBracketToken = closeBracketToken
        ElementTypeClause = elementTypeClause
        OpenBraceToken = openBraceToken
        Elements = elements
        CloseBraceToken = closeBraceToken
    }

    /// Initializes a new instance of the (cref:ArrayCreationExpressionSyntax) class
    /// for the runtime/zero-initialised allocation form `[n]T` (issue #1272),
    /// whose length is an arbitrary [`lengthExpression`](paramref) and whose
    /// element type is a plain identifier. There are no element initialisers; an
    /// optional empty brace pair (`[n]T{}`) may be present.
    /// @param syntaxTree The parent syntax tree.
    /// @param openBracketToken The opening bracket token.
    /// @param lengthExpression The runtime length expression.
    /// @param closeBracketToken The closing bracket token.
    /// @param elementTypeIdentifier The element type identifier.
    /// @param openBraceToken The opening brace token, or `null` when there is no brace.
    /// @param elements The (empty) element initialisers, or `null` when there is no brace.
    /// @param closeBraceToken The closing brace token, or `null` when there is no brace.
    init(
        syntaxTree SyntaxTree,
        openBracketToken SyntaxToken,
        lengthExpression ExpressionSyntax,
        closeBracketToken SyntaxToken,
        elementTypeIdentifier SyntaxToken,
        openBraceToken SyntaxToken?,
        elements SeparatedSyntaxList[ExpressionSyntax]?,
        closeBraceToken SyntaxToken?
    ) : base(syntaxTree) {
        OpenBracketToken = openBracketToken
        LengthExpression = lengthExpression
        Dimensions = SeparatedSyntaxList[ExpressionSyntax](ImmutableArray.Create[SyntaxNode](lengthExpression))
        CloseBracketToken = closeBracketToken
        ElementTypeIdentifier = elementTypeIdentifier
        OpenBraceToken = openBraceToken
        Elements = elements
        CloseBraceToken = closeBraceToken
    }

    /// Initializes a new instance of the (cref:ArrayCreationExpressionSyntax) class.
    /// @param syntaxTree Parent syntax tree.
    /// @param openBracketToken Opening bracket.
    /// @param dimensions Dimension expressions.
    /// @param closeBracketToken Closing bracket.
    /// @param elementTypeIdentifier Element type identifier.
    /// @param openBraceToken Optional initializer brace.
    /// @param elements Optional initializer elements.
    /// @param closeBraceToken Optional closing brace.
    init(
        syntaxTree SyntaxTree,
        openBracketToken SyntaxToken,
        dimensions SeparatedSyntaxList[ExpressionSyntax],
        closeBracketToken SyntaxToken,
        elementTypeIdentifier SyntaxToken,
        openBraceToken SyntaxToken?,
        elements SeparatedSyntaxList[ExpressionSyntax]?,
        closeBraceToken SyntaxToken?
    ) : base(syntaxTree) {
        OpenBracketToken = openBracketToken
        Dimensions = dimensions
        LengthExpression = if dimensions.Count > 0 {
            dimensions[0]
        } else {
            default(ExpressionSyntax?)
        }
        CloseBracketToken = closeBracketToken
        ElementTypeIdentifier = elementTypeIdentifier
        OpenBraceToken = openBraceToken
        Elements = elements
        CloseBraceToken = closeBraceToken
    }

    /// Initializes a new instance of the (cref:ArrayCreationExpressionSyntax) class.
    /// @param syntaxTree Parent syntax tree.
    /// @param openBracketToken Opening bracket.
    /// @param dimensions Dimension expressions.
    /// @param closeBracketToken Closing bracket.
    /// @param elementTypeClause Element type clause.
    /// @param openBraceToken Optional initializer brace.
    /// @param elements Optional initializer elements.
    /// @param closeBraceToken Optional closing brace.
    init(
        syntaxTree SyntaxTree,
        openBracketToken SyntaxToken,
        dimensions SeparatedSyntaxList[ExpressionSyntax],
        closeBracketToken SyntaxToken,
        elementTypeClause TypeClauseSyntax,
        openBraceToken SyntaxToken?,
        elements SeparatedSyntaxList[ExpressionSyntax]?,
        closeBraceToken SyntaxToken?
    ) : base(syntaxTree) {
        OpenBracketToken = openBracketToken
        Dimensions = dimensions
        LengthExpression = if dimensions.Count > 0 {
            dimensions[0]
        } else {
            default(ExpressionSyntax?)
        }
        CloseBracketToken = closeBracketToken
        ElementTypeClause = elementTypeClause
        OpenBraceToken = openBraceToken
        Elements = elements
        CloseBraceToken = closeBraceToken
    }

    /// Initializes a new instance of the (cref:ArrayCreationExpressionSyntax) class
    /// for the runtime/zero-initialised allocation form `[n]T` (issue #1272)
    /// whose element type is itself a (non-identifier) nested type clause, e.g.
    /// `[n][]int32` (issue #1046 element shape). There are no element
    /// initialisers; an optional empty brace pair may be present.
    /// @param syntaxTree The parent syntax tree.
    /// @param openBracketToken The opening bracket token.
    /// @param lengthExpression The runtime length expression.
    /// @param closeBracketToken The closing bracket token.
    /// @param elementTypeClause The nested element type clause.
    /// @param openBraceToken The opening brace token, or `null` when there is no brace.
    /// @param elements The (empty) element initialisers, or `null` when there is no brace.
    /// @param closeBraceToken The closing brace token, or `null` when there is no brace.
    init(
        syntaxTree SyntaxTree,
        openBracketToken SyntaxToken,
        lengthExpression ExpressionSyntax,
        closeBracketToken SyntaxToken,
        elementTypeClause TypeClauseSyntax,
        openBraceToken SyntaxToken?,
        elements SeparatedSyntaxList[ExpressionSyntax]?,
        closeBraceToken SyntaxToken?
    ) : base(syntaxTree) {
        OpenBracketToken = openBracketToken
        LengthExpression = lengthExpression
        Dimensions = SeparatedSyntaxList[ExpressionSyntax](ImmutableArray.Create[SyntaxNode](lengthExpression))
        CloseBracketToken = closeBracketToken
        ElementTypeClause = elementTypeClause
        OpenBraceToken = openBraceToken
        Elements = elements
        CloseBraceToken = closeBraceToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.ArrayCreationExpression

    /// Gets the opening bracket token.
    prop OpenBracketToken SyntaxToken {
        get;
    }

    /// Gets the literal length token, or `null` for the slice form (`[]T{…}`) or the runtime-length form
    /// (which carries (cref:LengthExpression)).
    prop LengthToken SyntaxToken? {
        get;
    }

    /// Gets the runtime length expression for the zero-initialised allocation form `[n]T` (issue #1272), or
    /// `null` when the length is a literal (see (cref:LengthToken)) or absent (slice form).
    @SyntaxChildIgnore
    prop LengthExpression ExpressionSyntax? {
        get;
    }

    /// Gets rectangular allocation dimensions.
    prop Dimensions SeparatedSyntaxList[ExpressionSyntax]? {
        get;
    }

    /// Gets allocation rank.
    prop Rank int32 -> Dimensions?.Count ?? 1

    /// Gets the closing bracket token.
    prop CloseBracketToken SyntaxToken {
        get;
    }

    /// Gets the element type identifier, or `null` when the element is a nested type clause (see
    /// (cref:ElementTypeClause)).
    prop ElementTypeIdentifier SyntaxToken? {
        get;
    }

    /// Gets the nested element type clause for a jagged-array literal (issue #1046), or `null` when the
    /// element is a plain identifier carried via (cref:ElementTypeIdentifier).
    prop ElementTypeClause TypeClauseSyntax? {
        get;
    }

    /// Gets a value indicating whether this literal's element type is a nested type clause rather than a
    /// plain identifier (issue #1046).
    prop HasNestedElementTypeClause bool -> ElementTypeClause != nil

    /// Gets the opening brace token.
    prop OpenBraceToken SyntaxToken? {
        get;
    }

    /// Gets the element initialisers.
    prop Elements SeparatedSyntaxList[ExpressionSyntax]? {
        get;
    }

    /// Gets the closing brace token.
    prop CloseBraceToken SyntaxToken? {
        get;
    }

    /// Gets a value indicating whether an explicit brace-delimited initializer is present.
    prop HasInitializer bool -> OpenBraceToken != nil

    /// Gets a value indicating whether this is the runtime/zero-initialised allocation form `[n]T` (issue
    /// #1272), carrying its length via (cref:LengthExpression).
    prop IsRuntimeLengthAllocation bool -> LengthExpression != nil
}
