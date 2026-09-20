// <copyright file="ManagedReferenceOrigins.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

internal static class ManagedReferenceOrigins
{
    internal static string? Rejection(BoundExpression expression)
    {
        if (expression.Type is ByRefTypeSymbol or PointerTypeSymbol or FunctionPointerTypeSymbol
            || TypeSymbol.IsByRefLike(expression.Type))
        {
            return "byref, pointer, and ref-like storage cannot be retained";
        }

        return expression switch
        {
            BoundVariableExpression { Variable: ParameterSymbol { IsReceiverParameter: true } } => "borrowed this is not compiler-owned storage",
            BoundVariableExpression { Variable: ParameterSymbol { RefKind: not RefKind.None } } => "incoming ref/in/out storage has no retained owner",
            BoundVariableExpression { Variable: LocalVariableSymbol local } when ExplicitlyScoped(local) => "scoped storage cannot be retained",
            BoundVariableExpression { Variable: LocalVariableSymbol { RefKind: not RefKind.None } local } =>
                local.ManagedReferenceOrigin is { } origin ? Rejection(origin) : "the borrowed alias has no proven owner",
            BoundVariableExpression { Variable: LocalVariableSymbol } => null,
            BoundFieldAccessExpression { Receiver: { } receiver } field when !field.Field.IsStatic =>
                field.Field.ExplicitOffset != null ? "explicit-layout fields are not supported" : ReceiverRejection(receiver),
            BoundClrPropertyAccessExpression { Receiver: { } receiver, Member: FieldInfo { IsStatic: false } field } =>
                field.DeclaringType?.IsExplicitLayout == true ? "explicit-layout fields are not supported" : ReceiverRejection(receiver),
            BoundIndexExpression index when index.IsArrayBackedElementAccess && index.Indices.Length == 1
                && index.Target.Type is not RectangularArrayTypeSymbol => null,
            BoundBlockExpression block => Rejection(block.Expression),
            BoundDereferenceExpression { Operand: BoundImportedInstanceCallExpression call } when IsHandleBorrow(call) =>
                IsScopedHandle(call.Receiver) ? "scoped handles cannot escape their scope" : null,
            BoundDereferenceExpression dereference => PointerRejection(dereference.Operand),
            _ => "this origin has no supported stable owner (static, temporary, property, or unknown borrowed storage)",
        };
    }

    internal static bool IsHandleBorrow(BoundImportedInstanceCallExpression call)
        => call.Method.Name == "Borrow" && ManagedReferenceTypes.TryGetElement(call.Receiver.Type, out _, out _);

    internal static bool IsScopedHandle(BoundExpression expression)
        => expression switch
        {
            BoundVariableExpression { Variable: LocalVariableSymbol { HoldsScopedManagedReference: true } } => true,
            BoundVariableExpression { Variable: LocalVariableSymbol { IsScoped: true } } =>
                ManagedReferenceTypes.TryGetElement(expression.Type is NullableTypeSymbol nullable ? nullable.UnderlyingType : expression.Type, out _, out _),
            BoundConversionExpression conversion => IsScopedHandle(conversion.Expression),
            BoundBlockExpression block => IsScopedHandle(block.Expression),
            BoundConditionalExpression conditional => IsScopedHandle(conditional.WhenTrue) || IsScopedHandle(conditional.WhenFalse),
            BoundImportedInstanceCallExpression call when ManagedReferenceTypes.TryGetElement(call.Type, out _, out _) => IsScopedHandle(call.Receiver),
            _ => false,
        };

    internal static BoundExpression PrepareAliases(BoundExpression location, ReferenceResolver references)
    {
        switch (location)
        {
            case BoundDereferenceExpression { Operand: BoundVariableExpression { Variable: LocalVariableSymbol { ManagedReferenceOrigin: not null } pointer } }:
                return PrepareAlias(pointer, location.Syntax, references);
            case BoundVariableExpression { Variable: LocalVariableSymbol { RefKind: not RefKind.None } alias }:
                return PrepareAlias(alias, location.Syntax, references);
            case BoundFieldAccessExpression { Receiver: { } receiver } field when !Binder.IsReferenceTypeForConstraint(receiver.Type):
                return new BoundFieldAccessExpression(field.Syntax, PrepareAliases(receiver, references), field.StructType, field.Field, field.SubstitutedType, field.NarrowedType);
            case BoundClrPropertyAccessExpression { Receiver: { } receiver, Member: FieldInfo } field when !Binder.IsReferenceTypeForConstraint(receiver.Type):
                return new BoundClrPropertyAccessExpression(field.Syntax, PrepareAliases(receiver, references), field.Member, field.Type, field.StaticContainerType);
            case BoundBlockExpression block:
                return new BoundBlockExpression(block.Syntax, block.Statements, PrepareAliases(block.Expression, references));
            default:
                return location;
        }
    }

    internal static BoundExpression PrepareAlias(LocalVariableSymbol alias, SyntaxNode? syntax, ReferenceResolver references)
    {
        if (alias.ManagedReferenceStorage == null)
        {
            var origin = Invariant.Required(alias.ManagedReferenceOrigin, "origin checking rejected unknown borrowed aliases");
            ManagedReferenceTypes.TryResolveDefinition(references, alias.RefKind == RefKind.RefReadOnly, out var definition);
            var type = ManagedReferenceTypes.Construct(
                Invariant.Required(definition, "the persistent address binder validated the runtime"),
                origin.Type,
                references);
            alias.ManagedReferenceStorage = new LocalVariableSymbol("<>retained_" + alias.Name, false, type);
            alias.ManagedReferenceStorageOrigin = PrepareAliases(origin, references);
        }

        return new BoundDereferenceExpression(syntax, ManagedReferenceTypes.Borrow(
            new BoundVariableExpression(syntax, alias.ManagedReferenceStorage)));
    }

    internal static void CollectRoots(BoundExpression location, ISet<VariableSymbol> roots)
    {
        switch (location)
        {
            case BoundVariableExpression { Variable: LocalVariableSymbol { RefKind: not RefKind.None } alias }:
                if (alias.ManagedReferenceOrigin is { } origin)
                {
                    CollectRoots(origin, roots);
                }

                break;
            case BoundVariableExpression { Variable: LocalVariableSymbol local }:
                roots.Add(local);
                break;
            case BoundFieldAccessExpression { Receiver: { } receiver } when !Binder.IsReferenceTypeForConstraint(receiver.Type):
                CollectRoots(receiver, roots);
                break;
            case BoundClrPropertyAccessExpression { Receiver: { } receiver, Member: FieldInfo } when !Binder.IsReferenceTypeForConstraint(receiver.Type):
                CollectRoots(receiver, roots);
                break;
            case BoundBlockExpression block:
                CollectRoots(block.Expression, roots);
                break;
            case BoundDereferenceExpression { Operand: BoundAddressOfExpression address }:
                CollectRoots(address.Operand, roots);
                break;
        }
    }

    private static bool ExplicitlyScoped(LocalVariableSymbol local)
        => local is ParameterSymbol ? local.IsScoped
            : local.DeclaringSyntax is VariableDeclarationSyntax { ScopedModifier: not null };

    private static string? ReceiverRejection(BoundExpression receiver)
        => Binder.IsReferenceTypeForConstraint(receiver.Type) ? null : Rejection(receiver);

    private static string? PointerRejection(BoundExpression pointer)
        => pointer switch
        {
            BoundVariableExpression { Variable: LocalVariableSymbol { IsReadOnly: true, ManagedReferenceOrigin: { } origin } local } =>
                ExplicitlyScoped(local) ? "scoped borrowed storage cannot be retained" : Rejection(origin),
            BoundBlockExpression block => PointerRejection(block.Expression),
            BoundClrIndexExpression index when NativeSliceTypes.TryGetElement(index.Target.Type, out _, out _) => null,
            BoundAddressOfExpression address => Rejection(address.Operand),
            _ => "the borrowed result has no recoverable owner; copying its value would not preserve its location",
        };
}
