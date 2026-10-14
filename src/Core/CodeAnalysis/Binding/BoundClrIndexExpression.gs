// <copyright file="BoundClrIndexExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Reflection

/// Reads a value through a CLR indexer (Phase 4 exit). Example:
/// `d["key"]` where `d` is a `Dictionary[string, int]`.
/// Interpreter-only — the evaluator calls `Indexer.GetValue(target, args)`.
class BoundClrIndexExpression : BoundExpression {
    init(
        syntax SyntaxNode?,
        target BoundExpression,
        indexer PropertyInfo,
        arguments ImmutableArray[BoundExpression],
        resultType TypeSymbol,
        constrainedReceiverTypeParameter TypeParameterSymbol? = nil,
        constrainedInterfaceType TypeSymbol? = nil
    ) : base(syntax) {
        Target = target
        Indexer = indexer
        Arguments = arguments
        _type = resultType
        ConstrainedReceiverTypeParameter = constrainedReceiverTypeParameter
        ConstrainedInterfaceType = constrainedInterfaceType
    }

    prop Target BoundExpression {
        get;
    }

    prop Indexer PropertyInfo {
        get;
    }

    prop Arguments ImmutableArray[BoundExpression] {
        get;
    }

    prop ConstrainedReceiverTypeParameter TypeParameterSymbol? {
        get;
    }

    prop ConstrainedInterfaceType TypeSymbol? {
        get;
    }

    @MemberNotNullWhen(true, "ConstrainedReceiverTypeParameter")
    prop IsConstrainedTypeParameterAccess bool -> ConstrainedReceiverTypeParameter != nil

    private var _type TypeSymbol
    override prop Type TypeSymbol -> _type
    override prop Kind BoundNodeKind -> BoundNodeKind.ClrIndexExpression
}
