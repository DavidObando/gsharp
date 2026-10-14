// <copyright file="RichAnonymousObjectPlan.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Generic
import System.Collections.Immutable

internal class RichAnonymousObjectPlan {
    internal init(
        constructedType StructSymbol,
        arguments ImmutableArray[BoundExpression],
        methodBodies Dictionary[FunctionSymbol, BoundBlockStatement]
    ) {
        ConstructedType = constructedType
        Arguments = arguments
        MethodBodies = methodBodies
    }

    internal prop ConstructedType StructSymbol {
        get;
    }

    internal prop Arguments ImmutableArray[BoundExpression] {
        get;
    }

    internal prop MethodBodies Dictionary[FunctionSymbol, BoundBlockStatement] {
        get;
    }
}
