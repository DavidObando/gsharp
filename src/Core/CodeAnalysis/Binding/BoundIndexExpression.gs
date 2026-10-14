// <copyright file="BoundIndexExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// Bound index expression `target[index]`.
class BoundIndexExpression : BoundExpression {
    /// Initializes a new instance of the (cref:BoundIndexExpression) class.
    /// @param syntax The originating syntax.
    /// @param target The target expression (must have an array type).
    /// @param index The index expression (must be int).
    /// @param resultType The element type.
    convenience init(syntax SyntaxNode?, target BoundExpression, index BoundExpression, resultType TypeSymbol) {
        init(syntax, target, ImmutableArray.Create(index), resultType)
    }

    /// Initializes a new instance of the (cref:BoundIndexExpression) class.
    /// @param syntax Originating syntax.
    /// @param target Indexed target.
    /// @param indices Index expressions.
    /// @param resultType Element type.
    init(
        syntax SyntaxNode?,
        target BoundExpression,
        indices ImmutableArray[BoundExpression],
        resultType TypeSymbol
    ) : base(syntax) {
        Target = target
        Indices = indices
        _type = resultType
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.IndexExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _type TypeSymbol

    override prop Type TypeSymbol -> _type

    /// Gets the target expression.
    prop Target BoundExpression {
        get;
    }

    /// Gets the index expression.
    prop Index BoundExpression -> Indices[0]

    /// Gets index expressions.
    prop Indices ImmutableArray[BoundExpression] {
        get;
    }

    /// Gets a value indicating whether this element load reads real,
    /// addressable array storage (issue #3292). Fixed arrays (`[N]T`),
    /// slices (`[]T`, ADR-0016: CLR-array-backed), and imported CLR
    /// single-dimensional arrays all store their elements in a heap array
    /// whose element address is expressible in IL (`ldelema`), so a
    /// struct member write through the element can mutate it in place. Map
    /// elements ((cref:MapTypeSymbol) — the Dictionary indexer
    /// returns a copy) and string elements (`get_Chars`) have no
    /// element address and stay non-addressable.
    prop IsArrayBackedElementAccess bool -> (
        Target.Type is ArrayTypeSymbol or SliceTypeSymbol or RectangularArrayTypeSymbol
    ) ||
        (
        !(Target.Type is MapTypeSymbol) &&
            Target.Type != TypeSymbol.String &&
            Target
            .Type
            ?.ClrType is {IsArray: true} clrArray &&
            clrArray.GetArrayRank() == 1
    )
}
