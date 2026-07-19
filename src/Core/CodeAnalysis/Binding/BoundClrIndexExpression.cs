// <copyright file="BoundClrIndexExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;
using System.Reflection;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Reads a value through a CLR indexer (Phase 4 exit). Example:
/// <c>d["key"]</c> where <c>d</c> is a <c>Dictionary[string, int]</c>.
/// Interpreter-only — the evaluator calls <c>Indexer.GetValue(target, args)</c>.
/// </summary>
public sealed class BoundClrIndexExpression : BoundExpression
{
    public BoundClrIndexExpression(
        SyntaxNode syntax,
        BoundExpression target,
        PropertyInfo indexer,
        ImmutableArray<BoundExpression> arguments,
        TypeSymbol resultType,
        TypeParameterSymbol constrainedReceiverTypeParameter = null,
        TypeSymbol constrainedInterfaceType = null)
        : base(syntax)
    {
        Target = target;
        Indexer = indexer;
        Arguments = arguments;
        Type = resultType;
        ConstrainedReceiverTypeParameter = constrainedReceiverTypeParameter;
        ConstrainedInterfaceType = constrainedInterfaceType;
    }

    public BoundExpression Target { get; }

    public PropertyInfo Indexer { get; }

    public ImmutableArray<BoundExpression> Arguments { get; }

    public TypeParameterSymbol ConstrainedReceiverTypeParameter { get; }

    public TypeSymbol ConstrainedInterfaceType { get; }

    public bool IsConstrainedTypeParameterAccess => ConstrainedReceiverTypeParameter != null;

    public override TypeSymbol Type { get; }

    public override BoundNodeKind Kind => BoundNodeKind.ClrIndexExpression;
}
