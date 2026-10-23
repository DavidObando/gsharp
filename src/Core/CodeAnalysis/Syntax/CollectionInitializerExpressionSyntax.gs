// <copyright file="CollectionInitializerExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Issue #479 / ADR-0117: a collection initializer applied to a generic
/// collection construction. Examples:
/// `List[int32]{1, 2, 3}`, `HashSet[int32](){1, 2}`,
/// `Dictionary[string, int32]{"a": 1}`, and
/// `Dictionary[K, V](comparer){ ["k"] = v }`, and
/// `List[T](){ ...items }`. ADR-0180 also admits explicit receiver
/// members in lexical order, e.g. `List[int32](4){ .Capacity: 8, 1, ...items }`.
///
/// The (cref:Target) is the constructor call expression (a
/// (cref:CallExpressionSyntax) carrying the type-argument list and any
/// explicit constructor arguments). For the no-parentheses spelling
/// (`List[int32]{…}`) the parser synthesizes an empty-argument
/// constructor call as the target. Each element in (cref:Elements) is
/// one of the (cref:CollectionElementSyntax) shapes; a spread is
/// an (cref:ExpressionCollectionElementSyntax) containing a
/// (cref:SpreadElementExpressionSyntax). The binder
/// lowers this to a (cref:GSharp.Core.CodeAnalysis.Binding.BoundBlockExpression)
/// that constructs into a synthetic local, calls `Add(...)` / sets the
/// indexer or an explicitly designated member for each element, and yields the local.
///
/// Issue #1567: (cref:Target) is `null` for the
/// <em>member</em> collection-initializer form used as a composite/object-
/// initializer member value (`T{ GetOnlyProp: { a, b } }` /
/// `T(){ GetOnlyProp = { a, b } }`). There is no construction — the
/// composite-literal binder instead reads the (get-only) collection member of
/// the just-constructed receiver and lowers each element to an
/// `Add(...)` call / indexer set on it, mirroring the C# collection-
/// initializer-in-object-initializer lowering.
partial class CollectionInitializerExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:CollectionInitializerExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param target The underlying constructor call expression.
    /// @param openBraceToken The '{' opening the initializer list.
    /// @param elements The collection elements.
    /// @param closeBraceToken The matching '}'.
    init(
        syntaxTree SyntaxTree,
        target ExpressionSyntax?,
        openBraceToken SyntaxToken,
        elements SeparatedSyntaxList[CollectionElementSyntax],
        closeBraceToken SyntaxToken
    ) : base(syntaxTree) {
        Target = target
        OpenBraceToken = openBraceToken
        Elements = elements
        CloseBraceToken = closeBraceToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.CollectionInitializerExpression

    /// Gets the explicit native-buffer type of a literal, when present.
    prop BufferType TypeClauseSyntax? {
        get;
        internal set;
    }

    /// Gets the underlying constructor call expression (a (cref:CallExpressionSyntax)).
    prop Target ExpressionSyntax? {
        get;
    }

    /// Gets the '{' opening the initializer list.
    prop OpenBraceToken SyntaxToken {
        get;
    }

    /// Gets the collection elements (zero or more).
    prop Elements SeparatedSyntaxList[CollectionElementSyntax] {
        get;
    }

    /// Gets the '}' closing the initializer list.
    prop CloseBraceToken SyntaxToken {
        get;
    }
}
