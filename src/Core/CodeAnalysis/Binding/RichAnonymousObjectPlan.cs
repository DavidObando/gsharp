// <copyright file="RichAnonymousObjectPlan.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed class RichAnonymousObjectPlan
{
    internal RichAnonymousObjectPlan(
        StructSymbol constructedType,
        ImmutableArray<BoundExpression> arguments,
        Dictionary<FunctionSymbol, BoundBlockStatement> methodBodies)
    {
        ConstructedType = constructedType;
        Arguments = arguments;
        MethodBodies = methodBodies;
    }

    internal StructSymbol ConstructedType { get; }

    internal ImmutableArray<BoundExpression> Arguments { get; }

    internal Dictionary<FunctionSymbol, BoundBlockStatement> MethodBodies { get; }
}
