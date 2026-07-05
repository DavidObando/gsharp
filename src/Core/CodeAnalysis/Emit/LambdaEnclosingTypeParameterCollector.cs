// <copyright file="LambdaEnclosingTypeParameterCollector.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Issue #2118: walks a non-capturing lambda body and gathers every
/// <see cref="TypeParameterSymbol"/> it references (through expression types,
/// declared-local types, type arguments, <c>is</c>/pattern target types, and
/// <c>typeof</c>/<c>sizeof</c> operands). The lambda itself declares no type
/// parameters, so any type parameter reachable from its body is necessarily an
/// enclosing one that must be promoted onto the synthesized static method as a
/// generic method type parameter for the emitted IL to verify. Mirrors the node
/// coverage of <c>LambdaBinder.EnclosingTypeParameterReferenceWalker</c> but
/// accumulates ALL references instead of stopping at the first.
/// </summary>
internal sealed class LambdaEnclosingTypeParameterCollector : BoundTreeWalker
{
    private readonly List<TypeParameterSymbol> sink;

    private LambdaEnclosingTypeParameterCollector(List<TypeParameterSymbol> sink)
    {
        this.sink = sink;
    }

    /// <summary>
    /// Collects every type parameter referenced anywhere in <paramref name="body"/>
    /// into <paramref name="sink"/> (order/duplicates are the caller's concern;
    /// <see cref="SynthesizedClosureReifier.CollectOrdered"/> deduplicates and
    /// canonicalizes).
    /// </summary>
    /// <param name="body">The bound lambda body to walk.</param>
    /// <param name="sink">The accumulator list.</param>
    public static void Collect(BoundStatement body, List<TypeParameterSymbol> sink)
    {
        if (body == null)
        {
            return;
        }

        new LambdaEnclosingTypeParameterCollector(sink).VisitStatement(body);
    }

    public override void VisitExpression(BoundExpression node)
    {
        if (node == null)
        {
            return;
        }

        TypeSymbol.CollectReferencedTypeParameters(node.Type, this.sink);
        switch (node)
        {
            case BoundCallExpression call:
                this.CheckTypeArguments(call.MethodTypeArguments);
                break;
            case BoundUserInstanceCallExpression userInstanceCall:
                this.CheckTypeArguments(userInstanceCall.MethodTypeArguments);
                break;
            case BoundImportedCallExpression importedCall:
                this.CheckTypeArguments(importedCall.TypeArgumentSymbols);
                break;
            case BoundImportedInstanceCallExpression importedInstanceCall:
                this.CheckTypeArguments(importedInstanceCall.TypeArgumentSymbols);
                TypeSymbol.CollectReferencedTypeParameters(importedInstanceCall.ConstrainedReceiverTypeParameter, this.sink);
                TypeSymbol.CollectReferencedTypeParameters(importedInstanceCall.ConstrainedInterfaceType, this.sink);
                break;
            case BoundIsExpression isExpression:
                TypeSymbol.CollectReferencedTypeParameters(isExpression.TargetType, this.sink);
                break;
            case BoundTypeOfExpression typeOfExpression:
                TypeSymbol.CollectReferencedTypeParameters(typeOfExpression.OperandType, this.sink);
                break;
            case BoundSizeOfExpression sizeOfExpression:
                TypeSymbol.CollectReferencedTypeParameters(sizeOfExpression.MeasuredType, this.sink);
                break;
            case BoundConstrainedStaticCallExpression constrainedStaticCall:
                TypeSymbol.CollectReferencedTypeParameters(constrainedStaticCall.TypeParameter, this.sink);
                break;
        }

        base.VisitExpression(node);
    }

    public override void VisitPattern(BoundPattern node)
    {
        if (node == null)
        {
            return;
        }

        TypeSymbol.CollectReferencedTypeParameters(node.Type, this.sink);
        if (node is BoundTypePattern typePattern)
        {
            TypeSymbol.CollectReferencedTypeParameters(typePattern.TargetType, this.sink);
        }

        base.VisitPattern(node);
    }

    protected override void VisitVariableDeclaration(BoundVariableDeclaration node)
    {
        TypeSymbol.CollectReferencedTypeParameters(node.Variable.Type, this.sink);
        base.VisitVariableDeclaration(node);
    }

    private void CheckTypeArguments(System.Collections.Immutable.ImmutableArray<TypeSymbol> typeArguments)
    {
        if (typeArguments.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var typeArgument in typeArguments)
        {
            TypeSymbol.CollectReferencedTypeParameters(typeArgument, this.sink);
        }
    }
}
