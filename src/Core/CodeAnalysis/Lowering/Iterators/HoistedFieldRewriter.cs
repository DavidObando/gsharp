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
        new BoundFieldAccessExpression(null, new BoundVariableExpression(null, this.thisParameter), this.smClass, field);

    protected BoundExpression FieldWrite(FieldSymbol field, BoundExpression value) =>
        new BoundFieldAssignmentExpression(null, this.thisParameter, this.smClass, field, value);

    protected override BoundExpression RewriteVariableExpression(BoundVariableExpression node)
    {
        if (this.fieldMap.TryGetValue(node.Variable, out var field))
        {
            return this.FieldRead(field);
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
            return new BoundFieldAccessExpression(null, rewrittenReceiver, node.StructType, node.Field);
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
            return BoundFieldAssignmentExpression.WithExpressionReceiver(null, receiverExpr, node.StructType, node.Field, value);
        }

        if (node.ReceiverExpression != null)
        {
            var receiverExpr = this.RewriteExpression(node.ReceiverExpression);
            if (!ReferenceEquals(value, node.Value) || !ReferenceEquals(receiverExpr, node.ReceiverExpression))
            {
                return BoundFieldAssignmentExpression.WithExpressionReceiver(null, receiverExpr, node.StructType, node.Field, value);
            }
        }
        else if (!ReferenceEquals(value, node.Value))
        {
            return new BoundFieldAssignmentExpression(null, node.Receiver, node.StructType, node.Field, value);
        }

        return node;
    }

    protected override BoundStatement RewriteVariableDeclaration(BoundVariableDeclaration node)
    {
        if (this.fieldMap.TryGetValue(node.Variable, out var field))
        {
            return new BoundExpressionStatement(null, this.FieldWrite(field, this.RewriteExpression(node.Initializer)));
        }

        return base.RewriteVariableDeclaration(node);
    }

    // Issue #887: an index assignment (`arr[i] = v`, `m[k] = v`) whose
    // target temp is hoisted into a state-machine field can't reference the
    // field through its VariableSymbol target. Switch to the expression
    // target form reading the hoisted field (same fix as closure boxing,
    // issue #618).
    protected override BoundExpression RewriteIndexAssignmentExpression(BoundIndexAssignmentExpression node)
    {
        if (node.Target != null && this.fieldMap.TryGetValue(node.Target, out var targetField))
        {
            return BoundIndexAssignmentExpression.WithExpressionTarget(
                null,
                this.FieldRead(targetField),
                this.RewriteExpression(node.Index),
                this.RewriteExpression(node.Value),
                node.Type);
        }

        return base.RewriteIndexAssignmentExpression(node);
    }

    // Issue #887: same fix for CLR-indexer writes (e.g. `dict["k"] = v` or
    // `psi.Environment["k"] = v`) whose target temp is hoisted into a field.
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
                node.Type);
        }

        return base.RewriteClrIndexAssignmentExpression(node);
    }

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
