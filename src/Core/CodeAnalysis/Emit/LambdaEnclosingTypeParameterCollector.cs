// <copyright file="LambdaEnclosingTypeParameterCollector.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Walks a lambda body and gathers every
/// <see cref="TypeParameterSymbol"/> it references (through expression types,
/// declared-local types, type arguments, <c>is</c>/pattern target types,
/// <c>typeof</c>/<c>sizeof</c> operands, and an implicit static-owner-type
/// reference). Issue #2118 uses the result to promote non-capturing lambdas
/// to generic static methods; issue #2894 uses it to reify capturing display
/// classes. Nested ordinary lambda bodies are included because the outer
/// lambda materializes their constructed display classes. Mirrors the node
/// coverage of <c>LambdaBinder.EnclosingTypeParameterReferenceWalker</c> but
/// accumulates all references instead of stopping at the first.
/// </summary>
internal sealed class LambdaEnclosingTypeParameterCollector : BoundTreeWalker
{
    private readonly List<TypeParameterSymbol> sink;
    private readonly Func<FunctionSymbol, ImmutableArray<TypeParameterSymbol>>? getPromotedExtras;

    private LambdaEnclosingTypeParameterCollector(List<TypeParameterSymbol> sink, Func<FunctionSymbol, ImmutableArray<TypeParameterSymbol>>? getPromotedExtras)
    {
        this.sink = sink;
        this.getPromotedExtras = getPromotedExtras;
    }

    /// <summary>
    /// Collects every type parameter referenced anywhere in <paramref name="body"/>
    /// into <paramref name="sink"/> (order/duplicates are the caller's concern;
    /// <see cref="SynthesizedClosureReifier.CollectOrdered"/> deduplicates and
    /// canonicalizes).
    /// </summary>
    /// <param name="body">The bound lambda body to walk.</param>
    /// <param name="sink">The accumulator list.</param>
    /// <param name="getPromotedExtras">
    /// Issue #4223: optional lookup of a called function's OWN promoted-extra
    /// enclosing type parameters (<c>UserTokenResolver.GetPromotedExtras</c>).
    /// A direct call to a callee that was itself promoted to carry enclosing
    /// type parameters requires the CALLER to supply them at the call site —
    /// a requirement invisible in the call's own argument/return types
    /// whenever the callee uses that parameter only in a body-only position
    /// (e.g. an implicit static-owner-type reference, `typeof`, or a
    /// constraint). Passing this lookup lets the caller discover and promote
    /// itself for the same parameters in turn; omitting it (the default)
    /// preserves the pre-#4223 behavior for a caller that does not need it
    /// (a capturing display class's reification, which runs before any
    /// zero-capture promotion in the same pass and so has nothing to look up
    /// yet).
    /// </param>
    public static void Collect(
        BoundStatement body,
        List<TypeParameterSymbol> sink,
        Func<FunctionSymbol, ImmutableArray<TypeParameterSymbol>>? getPromotedExtras = null)
    {
        if (body == null)
        {
            return;
        }

        new LambdaEnclosingTypeParameterCollector(sink, getPromotedExtras).VisitStatement(body);
    }

    public override void VisitExpression(BoundExpression? node)
    {
        if (node == null)
        {
            return;
        }

        // Issue #4223: a nested GENERIC local function/lambda's own `.Type`
        // (its delegate/function-literal shape) mentions its OWN declared type
        // parameters, not just any enclosing ones it references. Collecting
        // those unfiltered would falsely promote the OUTER literal as if it
        // referenced them too. Filter them out here; the nested literal's own
        // references to a TRULY enclosing parameter are still visited below —
        // only a non-generic nested literal's body is walked directly, but a
        // generic one's own type parameters can never be enclosing ones by
        // construction, so no legitimate reference is lost.
        if (node is BoundFunctionLiteralExpression { Function.IsGeneric: true } ownTPLiteral)
        {
            var filtered = new List<TypeParameterSymbol>();
            TypeSymbol.CollectReferencedTypeParameters(node.Type, filtered);
            foreach (var tp in filtered)
            {
                if (!ownTPLiteral.Function.TypeParameters.Contains(tp))
                {
                    this.sink.Add(tp);
                }
            }
        }
        else
        {
            TypeSymbol.CollectReferencedTypeParameters(node.Type, this.sink);
        }

        switch (node)
        {
            case BoundFunctionLiteralExpression literal when literal.Function?.IsGeneric != true:
                this.VisitStatement(literal.Body);
                break;
            case BoundCallExpression call:
                // Issue #4223: an implicit-receiver call to a `shared` member
                // of the ENCLOSING generic type (`Public()` inside a method of
                // `Holder[Outer]`, resolving to `Holder[Outer].Public()`)
                // references `Outer` only through the call's static owner
                // type — never through a parameter, return, or method
                // type-argument position. Missing this left `Outer` out of
                // the reified set entirely: confirmed by direct repro, the
                // resulting TypeSpec fell back to encoding `Outer` as a
                // dangling `VAR` slot on the promoted (non-generic-owner)
                // top-level host, `System.BadImageFormatException` at load.
                // Mirrors `LambdaBinder.EnclosingTypeParameterReferenceWalker`'s
                // identical `checkOwners` check.
                if (!call.IsConditionalElided)
                {
                    TypeSymbol.CollectReferencedTypeParameters(
                        (TypeSymbol?)call.StaticGenericOwnerType ?? call.StaticGenericInterfaceOwnerType ?? call.Function.StaticOwnerType,
                        this.sink);
                }

                this.CheckTypeArguments(call.MethodTypeArguments);

                // Issue #4223 (transitive case): a direct call to another
                // zero-capture local function that WAS ITSELF promoted to
                // carry extra enclosing type parameters (this walk runs to a
                // fixed point, so an earlier pass may already have promoted
                // the callee) requires THIS function to carry the same
                // parameters too, purely so its own call site has them to
                // pass — the requirement can be entirely invisible in the
                // call's own argument/return types when the callee only uses
                // the parameter in a body-only position. See
                // UserTokenResolver.GetPromotedExtras.
                if (this.getPromotedExtras != null)
                {
                    foreach (var extra in this.getPromotedExtras(call.Function))
                    {
                        this.sink.Add(extra);
                    }
                }

                break;
            case BoundUserInstanceCallExpression userInstanceCall:
                this.CheckTypeArguments(userInstanceCall.MethodTypeArguments);
                break;
            case BoundMethodGroupExpression { Function: { } methodGroupFunction } methodGroup:
                TypeSymbol.CollectReferencedTypeParameters(methodGroup.StaticOwnerType ?? methodGroupFunction.StaticOwnerType, this.sink);
                this.CheckTypeArguments(methodGroup.MethodTypeArguments);
                break;
            case BoundFunctionPointerFromMethodExpression functionPointer:
                TypeSymbol.CollectReferencedTypeParameters(functionPointer.Method.StaticOwnerType, this.sink);
                break;
            case BoundFieldAccessExpression fieldAccess:
                TypeSymbol.CollectReferencedTypeParameters((TypeSymbol?)fieldAccess.StructType ?? fieldAccess.InterfaceType, this.sink);
                break;
            case BoundFieldAssignmentExpression fieldAssignment:
                TypeSymbol.CollectReferencedTypeParameters((TypeSymbol?)fieldAssignment.StructType ?? fieldAssignment.InterfaceType, this.sink);
                break;
            case BoundPropertyAccessExpression propertyAccess:
                TypeSymbol.CollectReferencedTypeParameters((TypeSymbol?)propertyAccess.StructType ?? propertyAccess.InterfaceType, this.sink);
                break;
            case BoundPropertyAssignmentExpression propertyAssignment:
                TypeSymbol.CollectReferencedTypeParameters((TypeSymbol?)propertyAssignment.StructType ?? propertyAssignment.InterfaceType, this.sink);
                break;
            case BoundImportedCallExpression importedCall:
                this.CheckNullableTypeArguments(importedCall.TypeArgumentSymbols);
                break;
            case BoundImportedInstanceCallExpression importedInstanceCall:
                this.CheckNullableTypeArguments(importedInstanceCall.TypeArgumentSymbols);
                if (importedInstanceCall.ConstrainedReceiverTypeParameter is { } receiverTypeParameter)
                {
                    TypeSymbol.CollectReferencedTypeParameters(receiverTypeParameter, this.sink);
                }

                if (importedInstanceCall.ConstrainedInterfaceType is { } interfaceType)
                {
                    TypeSymbol.CollectReferencedTypeParameters(interfaceType, this.sink);
                }

                break;
            case BoundTypeOfExpression typeOfExpression:
                TypeSymbol.CollectReferencedTypeParameters(typeOfExpression.OperandType, this.sink);
                break;
            case BoundSizeOfExpression sizeOfExpression:
                TypeSymbol.CollectReferencedTypeParameters(sizeOfExpression.MeasuredType, this.sink);
                break;
            case BoundConstrainedStaticCallExpression constrainedStaticCall:
                TypeSymbol.CollectReferencedTypeParameters(constrainedStaticCall.TypeParameter, this.sink);
                this.CheckNullableTypeArguments(constrainedStaticCall.TypeArgumentSymbols);
                break;
        }

        base.VisitExpression(node);
    }

    public override void VisitPattern(BoundPattern? node)
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

    private void CheckNullableTypeArguments(System.Collections.Immutable.ImmutableArray<TypeSymbol?> typeArguments)
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
