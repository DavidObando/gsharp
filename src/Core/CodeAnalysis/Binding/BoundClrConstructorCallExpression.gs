// <copyright file="BoundClrConstructorCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable
import System.Reflection

/// Constructs a CLR class instance via a resolved (cref:ConstructorInfo)
/// (Phase 4 exit). Covers both non-generic imports (`StringBuilder()`) and
/// closed generic imports (`List[int]()`, `Dictionary[string, int]()`).
/// Interpreter-only: the evaluator calls `Constructor.Invoke(args)`.
class BoundClrConstructorCallExpression : BoundExpression {
    init(
        syntax SyntaxNode?,
        clrType Type,
        constructor ConstructorInfo,
        arguments ImmutableArray[BoundExpression],
        resultType TypeSymbol,
        argumentRefKinds ImmutableArray[RefKind] = default(ImmutableArray[RefKind])
    ) : base(syntax) {
        ClrType = clrType
        Constructor = constructor
        Arguments = arguments
        _type = resultType
        ArgumentRefKinds = if argumentRefKinds.IsDefault {
            default(ImmutableArray[RefKind])
        } else {
            argumentRefKinds
        }
    }

    prop ClrType Type {
        get;
    }

    prop Constructor ConstructorInfo {
        get;
    }

    prop Arguments ImmutableArray[BoundExpression] {
        get;
    }

    prop ArgumentRefKinds ImmutableArray[RefKind] {
        get;
    }

    private var _type TypeSymbol
    override prop Type TypeSymbol -> _type
    override prop Kind BoundNodeKind -> BoundNodeKind.ClrConstructorCallExpression
}
