// <copyright file="BoundStateMachineAwaitOnCompleted.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System

/// Marker bound expression for the `builder.AwaitOnCompleted/AwaitUnsafeOnCompleted`
/// call inside `MoveNext`. This node exists because the call requires a
/// `MethodSpec` whose second type argument is the synthesized state-machine
/// `TypeDef`, which cannot be represented as a CLR (cref:System.Type).
/// The emitter handles this node specifically by constructing the MethodSpec manually.
class BoundStateMachineAwaitOnCompleted : BoundExpression {
    /// Initializes a new instance of the (cref:BoundStateMachineAwaitOnCompleted) class.
    /// @param syntax The originating syntax.
    /// @param awaiterLocal The local variable holding the awaiter.
    /// @param awaiterClrType The CLR type of the awaiter.
    /// @param awaiterTypeSymbol The symbolic type of the awaiter.
    /// @param useCritical Whether to use `AwaitUnsafeOnCompleted` (true) or `AwaitOnCompleted` (false).
    init(
        syntax SyntaxNode?,
        awaiterLocal VariableSymbol,
        awaiterClrType Type,
        awaiterTypeSymbol TypeSymbol,
        useCritical bool
    ) : base(syntax) {
        AwaiterLocal = awaiterLocal ?? throw ArgumentNullException("awaiterLocal")
        AwaiterClrType = awaiterClrType ?? throw ArgumentNullException("awaiterClrType")
        AwaiterTypeSymbol = awaiterTypeSymbol ?? TypeSymbol.FromClrTypeWithoutNullability(
            awaiterClrType,
            NullabilityFreeReason.TypeStructure
        )
        UseCritical = useCritical
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind BoundNodeKind -> BoundNodeKind.StateMachineAwaitOnCompleted

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Type TypeSymbol -> TypeSymbol.Void

    /// Gets the local variable holding the awaiter.
    prop AwaiterLocal VariableSymbol {
        get;
    }

    /// Gets the CLR type of the awaiter.
    prop AwaiterClrType Type {
        get;
    }

    /// Gets the symbolic type of the awaiter.
    prop AwaiterTypeSymbol TypeSymbol {
        get;
    }

    /// Gets a value indicating whether to use `AwaitUnsafeOnCompleted`.
    prop UseCritical bool {
        get;
    }
}
