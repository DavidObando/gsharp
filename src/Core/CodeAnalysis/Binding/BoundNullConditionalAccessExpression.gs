// <copyright file="BoundNullConditionalAccessExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Phase 3.C.3b / ADR-0001: bound representation of the null-conditional
/// member access operator `?.`.
///
/// The evaluator:
/// 1. evaluates (cref:Receiver) exactly once;
/// 2. if the value is nil, the whole expression evaluates to nil without
/// touching (cref:WhenNotNull);
/// 3. otherwise it assigns the receiver value to (cref:Capture)
/// in the current scope and evaluates (cref:WhenNotNull), whose
/// receiver reference IS (cref:Capture). This guarantees the
/// original receiver expression is evaluated exactly once, even when
/// it has side-effects.
class BoundNullConditionalAccessExpression : BoundExpression {
    /// Initializes a new instance of the
    /// (cref:BoundNullConditionalAccessExpression) class.
    /// @param syntax The originating syntax.
    /// @param receiver The nullable receiver expression.
    /// @param capture The synthetic local that the receiver value
    /// is captured into for the duration of (cref:WhenNotNull).
    /// @param whenNotNull The bound access expression, built with
    /// [`capture`](paramref) standing in for the receiver.
    /// @param type The result type — always a
    /// (cref:NullableTypeSymbol).
    /// @param resultSlot Optional synthetic local that the emitter
    /// uses to materialize `default(Nullable<T>)` when the access
    /// result is a value type. Null for reference-typed results.
    init(
        syntax SyntaxNode?,
        receiver BoundExpression,
        capture VariableSymbol,
        whenNotNull BoundExpression,
        type TypeSymbol,
        resultSlot VariableSymbol? = nil
    ) : base(syntax) {
        Receiver = receiver
        Capture = capture
        WhenNotNull = whenNotNull
        _type = type
        ResultSlot = resultSlot
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.NullConditionalAccessExpression

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _type TypeSymbol

    override prop Type TypeSymbol -> _type

    /// Gets the nullable receiver expression.
    prop Receiver BoundExpression {
        get;
    }

    /// Gets the synthetic capture variable.
    prop Capture VariableSymbol {
        get;
    }

    /// Gets the access expression evaluated when the receiver is non-nil.
    prop WhenNotNull BoundExpression {
        get;
    }

    /// Gets the synthetic temp slot used to materialize `default(Nullable<T>)`
    /// in the nil branch when the access result is a value type. Null when the
    /// result is a reference type (the nil branch then just pushes `ldnull`).
    prop ResultSlot VariableSymbol? {
        get;
    }
}
