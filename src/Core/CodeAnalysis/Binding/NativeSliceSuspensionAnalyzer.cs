// <copyright file="NativeSliceSuspensionAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Rejects suspended native element locations until owner/index reconstruction is supported.</summary>
internal sealed class NativeSliceSuspensionAnalyzer : BoundTreeWalker
{
    private readonly DiagnosticBag diagnostics;
    private readonly HashSet<VariableSymbol> nativeLocations = new();

    internal NativeSliceSuspensionAnalyzer(DiagnosticBag diagnostics) => this.diagnostics = diagnostics;

    protected override void VisitVariableDeclaration(BoundVariableDeclaration node)
    {
        if (node.Initializer != null && IsNativeLocation(node.Initializer)
            && (node.Variable.Type is ByRefTypeSymbol
                || node.Variable is LocalVariableSymbol { RefKind: not RefKind.None }))
        {
            nativeLocations.Add(node.Variable);
        }

        base.VisitVariableDeclaration(node);
    }

    protected override void VisitFieldAssignmentExpression(BoundFieldAssignmentExpression node)
    {
        Check(node.ReceiverExpression, node.Value);
        base.VisitFieldAssignmentExpression(node);
    }

    protected override void VisitPropertyAssignmentExpression(BoundPropertyAssignmentExpression node)
    {
        Check(node.Receiver, node.Value);
        base.VisitPropertyAssignmentExpression(node);
    }

    protected override void VisitClrPropertyAssignmentExpression(BoundClrPropertyAssignmentExpression node)
    {
        Check(node.Receiver, node.Value);
        base.VisitClrPropertyAssignmentExpression(node);
    }

    protected override void VisitIndirectAssignmentExpression(BoundIndirectAssignmentExpression node)
    {
        Check(node.Pointer, node.Value);
        base.VisitIndirectAssignmentExpression(node);
    }

    private void Check(BoundExpression? location, BoundExpression value)
    {
        if (location != null && !Binder.IsReferenceTypeForConstraint(location.Type)
            && IsNativeLocation(location) && AsyncBoundTreeQueries.HasAwait(value))
        {
            var syntax = value.Syntax ?? location.Syntax;
            if (syntax != null)
            {
                diagnostics.ReportNativeSliceSuspendingWrite(syntax.Location);
            }
        }
    }

    private bool IsNativeLocation(BoundExpression expression)
        => expression switch
        {
            BoundClrIndexExpression index => NativeSliceTypes.TryGetElement(index.Target.Type, out _, out _),
            BoundBlockExpression block => IsNativeLocation(block.Expression),
            BoundAddressOfExpression address => IsNativeLocation(address.Operand),
            BoundDereferenceExpression dereference => IsNativeLocation(dereference.Operand),
            BoundFieldAccessExpression { Receiver: { } receiver } => IsNativeLocation(receiver),
            BoundClrPropertyAccessExpression { Receiver: { } receiver } => IsNativeLocation(receiver),
            BoundVariableExpression variable => nativeLocations.Contains(variable.Variable),
            _ => false,
        };
}
