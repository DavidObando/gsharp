// <copyright file="BoundConstructorChainingExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// ADR-0065 §2: a `init(args)` self-delegation appearing inside a
/// `convenience init` body. Lowered to a CIL `call .ctor(this, args)`
/// chained-constructor call that delegates to another initializer in the
/// same class. The expression is value-less (type (cref:TypeSymbol.Void))
/// and is normally wrapped in a (cref:BoundExpressionStatement).
class BoundConstructorChainingExpression : BoundExpression {
    init(syntax SyntaxNode?, selectedConstructor ConstructorSymbol, arguments ImmutableArray[BoundExpression]) : base(
        syntax
    ) {
        SelectedConstructor = selectedConstructor
        Arguments = arguments
    }

    /// Gets the chosen sibling constructor overload to chain to.
    prop SelectedConstructor ConstructorSymbol {
        get;
    }

    /// Gets the bound arguments (already permuted to parameter order and converted).
    prop Arguments ImmutableArray[BoundExpression] {
        get;
    }

    override prop Type TypeSymbol -> TypeSymbol.Void
    override prop Kind BoundNodeKind -> BoundNodeKind.ConstructorChainingExpression
}
