// <copyright file="BoundConstructorCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// Constructs a class or inline-struct instance via its Kotlin-style primary constructor:
/// `ClassName(arg1, arg2)` (Phase 3.B.3 sub-step 2). The arguments
/// correspond 1:1 with (cref:StructSymbol.PrimaryConstructorParameters)
/// and are assigned to the same-named fields of the new instance.
/// @remarks ADR-0063 §9: when the receiving class declares an overload family of
/// `init(...)` constructors, (cref:SelectedConstructor) identifies
/// the specific overload picked by call-site overload resolution. Primary-ctor
/// and parameterless paths leave it `null`.
class BoundConstructorCallExpression : BoundExpression {
    convenience init(syntax SyntaxNode?, structType StructSymbol, arguments ImmutableArray[BoundExpression]) {
        init(syntax, structType, arguments, nil)
    }

    init(
        syntax SyntaxNode?,
        structType StructSymbol,
        arguments ImmutableArray[BoundExpression],
        selectedConstructor ConstructorSymbol?
    ) : base(syntax) {
        StructType = structType
        Arguments = arguments
        SelectedConstructor = selectedConstructor
    }

    prop StructType StructSymbol {
        get;
    }

    prop Arguments ImmutableArray[BoundExpression] {
        get;
    }

    /// Gets the chosen explicit `init(...)` overload, per ADR-0063 §9, or `null` when not applicable.
    prop SelectedConstructor ConstructorSymbol? {
        get;
    }

    override prop Type TypeSymbol -> StructType
    override prop Kind BoundNodeKind -> BoundNodeKind.ConstructorCallExpression
}
