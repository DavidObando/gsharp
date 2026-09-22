// <copyright file="ExpressionBinder.ManagedReferences.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class ExpressionBinder
{
    private BoundExpression BorrowManagedReference(BoundExpression handle, SyntaxNode syntax)
    {
        if (!ManagedReferenceTypes.IsCompatible(handle.Type.ClrType))
        {
            Diagnostics.ReportManagedReference(syntax.Location, "reference the matching Gsharp.Runtime.Values runtime; the managed-reference ABI is incompatible");
            return new BoundErrorExpression(syntax);
        }

        return ManagedReferenceTypes.Borrow(handle);
    }

    private BoundExpression BindManagedReference(CallExpressionSyntax syntax)
    {
        var readOnly = syntax.ReadOnlyManagedModifier != null;
        if (syntax.TypeArgumentList != null || syntax.Arguments.Count != 1 || syntax.NullableQuestionToken != null)
        {
            Diagnostics.ReportManagedReference(syntax.Location, "a persistent address requires exactly one location expression");
            return new BoundErrorExpression(syntax);
        }

        var location = BindExpression(syntax.Arguments[0]);
        if (location is BoundErrorExpression)
        {
            return location;
        }

        if (!readOnly && RefCapabilities.IsReadOnlyStorage(location))
        {
            Diagnostics.ReportManagedReference(syntax.Arguments[0].Location, "readonly storage cannot grant a writable handle");
            return new BoundErrorExpression(syntax);
        }

        if (ManagedReferenceOrigins.Rejection(location) is { } reason)
        {
            Diagnostics.ReportManagedReference(syntax.Arguments[0].Location, reason);
            return new BoundErrorExpression(syntax);
        }

        if (!ManagedReferenceTypes.TryResolveDefinition(scope.References, readOnly, out var definition))
        {
            Diagnostics.ReportManagedReference(syntax.Location, "reference the matching Gsharp.Runtime.Values runtime");
            return new BoundErrorExpression(syntax);
        }

        return new BoundManagedReferenceExpression(
            syntax, ManagedReferenceOrigins.PrepareAliases(location, scope.References), ManagedReferenceTypes.Construct(definition, location.Type, scope.References), readOnly);
    }
}
