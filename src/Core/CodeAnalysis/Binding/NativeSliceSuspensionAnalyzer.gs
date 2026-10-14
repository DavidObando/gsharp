// <copyright file="NativeSliceSuspensionAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic

/// Rejects suspended native element locations until owner/index reconstruction is supported.
internal class NativeSliceSuspensionAnalyzer : BoundTreeWalker {
    private let diagnostics DiagnosticBag
    private let nativeLocations HashSet[VariableSymbol] = HashSet[VariableSymbol]()

    internal init(diagnostics DiagnosticBag) {
        this.diagnostics = diagnostics
    }

    protected override func VisitVariableDeclaration(node BoundVariableDeclaration) {
        if node.Initializer != nil &&
            IsNativeLocation(node.Initializer) &&
            (
            node
                .Variable
                .Type is ByRefTypeSymbol ||
                (node.Variable is LocalVariableSymbol and {RefKind: not RefKind.None})
        ) {
            nativeLocations.Add(node.Variable)
        }
        base.VisitVariableDeclaration(node)
    }

    protected override func VisitFieldAssignmentExpression(node BoundFieldAssignmentExpression) {
        Check(node.ReceiverExpression, node.Value)
        base.VisitFieldAssignmentExpression(node)
    }

    protected override func VisitPropertyAssignmentExpression(node BoundPropertyAssignmentExpression) {
        Check(node.Receiver, node.Value)
        base.VisitPropertyAssignmentExpression(node)
    }

    protected override func VisitClrPropertyAssignmentExpression(node BoundClrPropertyAssignmentExpression) {
        Check(node.Receiver, node.Value)
        base.VisitClrPropertyAssignmentExpression(node)
    }

    protected override func VisitIndirectAssignmentExpression(node BoundIndirectAssignmentExpression) {
        Check(node.Pointer, node.Value)
        base.VisitIndirectAssignmentExpression(node)
    }

    private func Check(location BoundExpression?, value BoundExpression) {
        if location != nil && !Binder.IsReferenceTypeForConstraint(location.Type) &&
            IsNativeLocation(location) &&
            AsyncBoundTreeQueries
            .HasAwait(value) {
            let syntax SyntaxNode? = value.Syntax ?? location.Syntax
            if syntax != nil {
                diagnostics.ReportNativeSliceSuspendingWrite(syntax.Location)
            }
        }
    }

    private func IsNativeLocation(expression BoundExpression) bool -> switch expression {
        case index is BoundClrIndexExpression: NativeSliceTypes.TryGetElement(index.Target.Type, out _, out _)
        case block is BoundBlockExpression: IsNativeLocation(block.Expression)
        case address is BoundAddressOfExpression: IsNativeLocation(address.Operand)
        case dereference is BoundDereferenceExpression: IsNativeLocation(dereference.Operand)
        case BoundFieldAccessExpression{Receiver: {} receiver}: IsNativeLocation(receiver)
        case BoundClrPropertyAccessExpression{Receiver: {} receiver}: IsNativeLocation(receiver)
        case variable is BoundVariableExpression: nativeLocations.Contains(variable.Variable)
        default: false
    }
}
