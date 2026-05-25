// <copyright file="BoundStateMachineBuilderMoveNext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Marker bound expression for the <c>builder.MoveNext&lt;TSM&gt;(ref TSM)</c>
/// call used by async iterators. Requires a MethodSpec because the SM type is
/// a synthesized TypeDef. The emitter handles this node by constructing the
/// MethodSpec manually.
/// </summary>
#pragma warning disable CS1591
public sealed class BoundStateMachineBuilderMoveNext : BoundExpression
{
    public BoundStateMachineBuilderMoveNext(FieldSymbol builderField, VariableSymbol thisParameter, StructSymbol smClass)
    {
        BuilderField = builderField;
        ThisParameter = thisParameter;
        SmClass = smClass;
    }

    public override BoundNodeKind Kind => BoundNodeKind.StateMachineBuilderMoveNext;

    public override TypeSymbol Type => TypeSymbol.Void;

    public FieldSymbol BuilderField { get; }

    public VariableSymbol ThisParameter { get; }

    public StructSymbol SmClass { get; }
}
