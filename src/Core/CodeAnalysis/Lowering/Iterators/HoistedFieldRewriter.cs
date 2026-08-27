// <copyright file="HoistedFieldRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable CS1591 // Missing XML comment for publicly visible type or member
#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1612 // Element parameter documentation should match
#pragma warning disable SA1572 // Summary documentation should have paramrefs
#pragma warning disable CS1572 // XML comment has a param tag
#pragma warning disable CS1573 // Parameter has no matching param tag
#pragma warning disable SA1401 // Field should be private (protected fields are shared with subclasses in this file's family)

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering.Iterators;

/// <summary>
/// Shared rewriter that maps hoisted local reads/writes to field accesses on
/// the synthesized state machine, using the supplied <c>this</c> parameter
/// (different per state-machine method). This is the single home for the
/// hoisted-variable-to-field rewriting rules accumulated by issues #618,
/// #641, #655, and #887, used by every MoveNext/Dispose body builder
/// (sync iterator, async iterator) so a fix here applies everywhere at once.
/// </summary>
internal class HoistedFieldRewriter : BoundTreeRewriter
{
    protected readonly StructSymbol smClass;
    protected readonly ParameterSymbol thisParameter;
    protected readonly Dictionary<VariableSymbol, FieldSymbol> fieldMap;

    public HoistedFieldRewriter(
        StructSymbol smClass,
        ParameterSymbol thisParameter,
        Dictionary<VariableSymbol, FieldSymbol> fieldMap)
    {
        this.smClass = smClass;
        this.thisParameter = thisParameter;
        this.fieldMap = fieldMap;
    }

    protected BoundExpression FieldRead(FieldSymbol field) =>
        this.FieldRead(field, narrowedType: null);

    // Issue #3501 (ilverify): a hoisted variable READ may carry an ADR-0069
    // smart-cast narrowing; the replacement field access must keep it so the
    // emitter's narrowing castclass still fires (the field itself stays at
    // the declared type).
    protected BoundExpression FieldRead(FieldSymbol field, TypeSymbol? narrowedType) =>
        new BoundFieldAccessExpression(
            null,
            new BoundVariableExpression(null, this.thisParameter),
            this.smClass,
            field,
            narrowedType);

    protected BoundExpression FieldWrite(FieldSymbol field, BoundExpression value) =>
        new BoundFieldAssignmentExpression(null, this.thisParameter, this.smClass, field, value);

    protected override BoundExpression RewriteVariableExpression(BoundVariableExpression node)
    {
        if (this.fieldMap.TryGetValue(node.Variable, out var field))
        {
            return this.FieldRead(field, node.NarrowedType);
        }

        return node;
    }

    protected override BoundExpression RewriteAssignmentExpression(BoundAssignmentExpression node)
    {
        if (this.fieldMap.TryGetValue(node.Variable, out var field))
        {
            return this.FieldWrite(field, this.RewriteExpression(node.Expression));
        }

        return base.RewriteAssignmentExpression(node);
    }

    // Issue #655: explicitly rewrite field-access expressions whose
    // receiver is a BoundVariableExpression referencing the user-class
    // `this` (hoisted as <>4__this). Ensures the proxy load is applied
    // directly, protecting against regressions.
    protected override BoundExpression RewriteFieldAccessExpression(BoundFieldAccessExpression node)
    {
        if (node.Receiver is BoundVariableExpression varExpr
            && this.fieldMap.TryGetValue(varExpr.Variable, out var proxyField))
        {
            var rewrittenReceiver = this.FieldRead(proxyField);
            return new BoundFieldAccessExpression(
                null,
                rewrittenReceiver,
                BoundNodeForm.DeclaringType(node),
                node.Field,
                node.SubstitutedType,
                node.NarrowedType);
        }

        return base.RewriteFieldAccessExpression(node);
    }

    // Issue #641: rewrite field assignments whose receiver is the
    // user-class `this` (hoisted as <>4__this) to use an expression
    // receiver so the emitter loads the proxy field.
    protected override BoundExpression RewriteFieldAssignmentExpression(BoundFieldAssignmentExpression node)
    {
        var value = this.RewriteExpression(node.Value);
        if (node.Receiver != null && this.fieldMap.TryGetValue(node.Receiver, out var proxyField))
        {
            var receiverExpr = this.FieldRead(proxyField);
            return BoundFieldAssignmentExpression.WithExpressionReceiver(null, receiverExpr, BoundNodeForm.DeclaringType(node), node.Field, value, node.ResultType);
        }

        if (node.ReceiverExpression != null)
        {
            var receiverExpr = this.RewriteExpression(node.ReceiverExpression);
            if (!ReferenceEquals(value, node.Value) || !ReferenceEquals(receiverExpr, node.ReceiverExpression))
            {
                return BoundFieldAssignmentExpression.WithExpressionReceiver(null, receiverExpr, BoundNodeForm.DeclaringType(node), node.Field, value, node.ResultType);
            }
        }
        else if (!ReferenceEquals(value, node.Value))
        {
            // Issue #3333 / #1644: an interface static field write has a null
            // Receiver and StructType, and carries the owning interface in
            // InterfaceType. Rebuilding it through the variable-receiver
            // constructor drops that, and the emitter parents the field at the
            // open-generic TypeDef instead of a TypeSpec. This override must
            // carry the same guard the base BoundTreeRewriter does.
            if (node.InterfaceType != null)
            {
                return new BoundFieldAssignmentExpression(
                    null,
                    node.Field,
                    node.InterfaceType,
                    value,
                    node.ResultType);
            }

            return new BoundFieldAssignmentExpression(
                null,
                node.Receiver,
                BoundNodeForm.DeclaringType(node),
                node.Field,
                value,
                node.ResultType);
        }

        return node;
    }

    protected override BoundStatement RewriteVariableDeclaration(BoundVariableDeclaration node)
    {
        if (this.fieldMap.TryGetValue(node.Variable, out var field))
        {
            return new BoundExpressionStatement(
                null,
                this.FieldWrite(
                    field,
                    this.RewriteExpression(Invariant.Required(node.Initializer, "a variable declaration has an initializer"))));
        }

        return base.RewriteVariableDeclaration(node);
    }

    // Issue #887: an index assignment (`arr[i] = v`, `m[k] = v`) whose
    // target temp is hoisted into a state-machine field can't reference the
    // field through its VariableSymbol target. Switch to the expression
    // target form reading the hoisted field (same fix as closure boxing,
    // issue #618).
    // GSA0005: The rebuild sits inside `node.Target != null`, so this is the
    // variable-target form; TargetExpression is null on this path and the
    // expression-target form falls through to base.
    #pragma warning disable GSA0005
    protected override BoundExpression RewriteIndexAssignmentExpression(BoundIndexAssignmentExpression node)
    {
        if (node.Target != null && this.fieldMap.TryGetValue(node.Target, out var targetField))
        {
            return BoundIndexAssignmentExpression.WithExpressionTarget(
                null,
                this.FieldRead(targetField),
                node.Indices.Select(this.RewriteExpression).ToImmutableArray(),
                this.RewriteExpression(node.Value),
                node.Type);
        }

        return base.RewriteIndexAssignmentExpression(node);
    }
    #pragma warning restore GSA0005

    // Issue #887: same fix for CLR-indexer writes (e.g. `dict["k"] = v` or
    // `psi.Environment["k"] = v`) whose target temp is hoisted into a field.
    // GSA0005: Same as RewriteIndexAssignmentExpression: guarded by `node.Target !=
    // null`, so TargetExpression is null on the path that rebuilds.
    #pragma warning disable GSA0005
    protected override BoundExpression RewriteClrIndexAssignmentExpression(BoundClrIndexAssignmentExpression node)
    {
        if (node.Target != null && this.fieldMap.TryGetValue(node.Target, out var targetField))
        {
            return BoundClrIndexAssignmentExpression.WithExpressionTarget(
                null,
                this.FieldRead(targetField),
                node.Indexer,
                this.RewriteArguments(node.Arguments),
                this.RewriteExpression(node.Value),
                node.Type,
                node.ConstrainedReceiverTypeParameter,
                node.ConstrainedInterfaceType);
        }

        return base.RewriteClrIndexAssignmentExpression(node);
    }
    #pragma warning restore GSA0005

    protected ImmutableArray<BoundExpression> RewriteArguments(ImmutableArray<BoundExpression> arguments)
    {
        var builder = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);
        foreach (var argument in arguments)
        {
            builder.Add(this.RewriteExpression(argument));
        }

        return builder.MoveToImmutable();
    }
}
