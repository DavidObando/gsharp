// <copyright file="ExpressionBinder.ManagedReferences.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

internal partial class ExpressionBinder {
    private func BorrowManagedReference(handle BoundExpression, syntax SyntaxNode) BoundExpression {
        if !ManagedReferenceTypes.IsCompatible(handle.Type.ClrType) {
            Diagnostics.ReportManagedReference(
                syntax.Location,
                "reference the matching Gsharp.Runtime.Values runtime; the managed-reference ABI is incompatible"
            )
            return BoundErrorExpression(syntax)
        }
        return ManagedReferenceTypes.Borrow(handle)
    }

    private func BindManagedReference(syntax CallExpressionSyntax) BoundExpression {
        let readOnly = syntax.ReadOnlyManagedModifier != nil
        if syntax.TypeArgumentList != nil || syntax.Arguments.Count != 1 || syntax.NullableQuestionToken != nil {
            Diagnostics.ReportManagedReference(
                syntax.Location,
                "a persistent address requires exactly one location expression"
            )
            return BoundErrorExpression(syntax)
        }
        let location = BindExpression(syntax.Arguments[0])
        if location is BoundErrorExpression {
            return location
        }
        if !readOnly && RefCapabilities.IsReadOnlyStorage(location) {
            Diagnostics.ReportManagedReference(
                syntax.Arguments[0].Location,
                "readonly storage cannot grant a writable handle"
            )
            return BoundErrorExpression(syntax)
        }
        if ManagedReferenceOrigins.Rejection(location) is {} reason {
            Diagnostics.ReportManagedReference(syntax.Arguments[0].Location, reason)
            return BoundErrorExpression(syntax)
        }
        if !ManagedReferenceTypes.TryResolveDefinition($scope.References!!, readOnly, out var definition) {
            Diagnostics.ReportManagedReference(syntax.Location, "reference the matching Gsharp.Runtime.Values runtime")
            return BoundErrorExpression(syntax)
        }
        return BoundManagedReferenceExpression(
            syntax,
            ManagedReferenceOrigins.PrepareAliases(location, $scope.References!!),
            ManagedReferenceTypes.Construct(definition, location.Type, $scope.References!!),
            readOnly
        )
    }
}
