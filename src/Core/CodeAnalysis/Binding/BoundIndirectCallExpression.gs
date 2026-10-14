// <copyright file="BoundIndirectCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// A call through a function-typed value (Phase 4.7). The (cref:Target)
/// expression evaluates to a closure / function value at runtime; the
/// evaluator invokes it with the bound (cref:Arguments).
class BoundIndirectCallExpression : BoundExpression {
    init(
        syntax SyntaxNode?,
        target BoundExpression,
        functionType FunctionTypeSymbol,
        arguments ImmutableArray[BoundExpression],
        argumentRefKinds ImmutableArray[RefKind] = default(ImmutableArray[RefKind])
    ) : base(syntax) {
        Target = target
        FunctionType = functionType
        Arguments = arguments
        ArgumentRefKinds = argumentRefKinds
    }

    prop Target BoundExpression {
        get;
    }

    prop FunctionType FunctionTypeSymbol {
        get;
    }

    prop Arguments ImmutableArray[BoundExpression] {
        get;
    }

    prop ArgumentRefKinds ImmutableArray[RefKind] {
        get;
    }

    override prop Type TypeSymbol -> FunctionType.ReturnType
    override prop Kind BoundNodeKind -> BoundNodeKind.IndirectCallExpression
}
