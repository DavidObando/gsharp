// <copyright file="BoundStateMachineBuilderMoveNext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Marker bound expression for the `builder.MoveNext<TSM>(ref TSM)`
/// call used by async iterators. Requires a MethodSpec because the SM type is
/// a synthesized TypeDef. The emitter handles this node by constructing the
/// MethodSpec manually.
class BoundStateMachineBuilderMoveNext : BoundExpression {
    init(syntax SyntaxNode?, builderField FieldSymbol, thisParameter VariableSymbol, smClass StructSymbol) : base(
        syntax
    ) {
        BuilderField = builderField
        ThisParameter = thisParameter
        SmClass = smClass
    }

    override prop Kind BoundNodeKind -> BoundNodeKind.StateMachineBuilderMoveNext
    override prop Type TypeSymbol -> TypeSymbol.Void

    prop BuilderField FieldSymbol {
        get;
    }

    prop ThisParameter VariableSymbol {
        get;
    }

    prop SmClass StructSymbol {
        get;
    }
}
