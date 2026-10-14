// <copyright file="ManagedReferenceOrigins.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

internal shared class ManagedReferenceOrigins {
    internal func Rejection(expression BoundExpression) string? {
        if (expression.Type is ByRefTypeSymbol or PointerTypeSymbol or FunctionPointerTypeSymbol) ||
            TypeSymbol.IsByRefLike(expression.Type) {
            return "byref, pointer, and ref-like storage cannot be retained"
        }
        return switch expression {
            case boundVariableExpression is BoundVariableExpression when boundVariableExpression.Variable is ParameterSymbol &&
                boundVariableExpression
                .Variable
                .IsReceiverParameter == true: "borrowed this is not compiler-owned storage"
            case boundVariableExpression is BoundVariableExpression when boundVariableExpression.Variable is ParameterSymbol &&
                boundVariableExpression
                .Variable
                .RefKind != RefKind.None: "incoming ref/in/out storage has no retained owner"
            case BoundVariableExpression{Variable: LocalVariableSymbol local} when ExplicitlyScoped(
                local
            ): "scoped storage cannot be retained"
            case BoundVariableExpression{
                Variable: LocalVariableSymbol{RefKind: not RefKind.None} local
            }: if local.ManagedReferenceOrigin is {} origin {
                Rejection(origin)
            } else {
                "the borrowed alias has no proven owner"
            }
            case boundVariableExpression is BoundVariableExpression when boundVariableExpression.Variable is LocalVariableSymbol: default(
                string?
            )
            case BoundFieldAccessExpression{Receiver: {} receiver} field when !field
                .Field
                .IsStatic: if field
                .Field
                .ExplicitOffset != nil {
                "explicit-layout fields are not supported"
            } else {
                ReceiverRejection(receiver)
            }
            case BoundClrPropertyAccessExpression{
                Receiver: {} receiver,
                Member: FieldInfo{IsStatic: false} field
            }: if field
                .DeclaringType
                ?.IsExplicitLayout == true {
                "explicit-layout fields are not supported"
            } else {
                ReceiverRejection(receiver)
            }
            case index is BoundIndexExpression when index.IsArrayBackedElementAccess &&
                index
                .Indices
                .Length == 1 &&
                !(index.Target.Type is RectangularArrayTypeSymbol): default(string?)
            case block is BoundBlockExpression: Rejection(block.Expression)
            case BoundDereferenceExpression{Operand: BoundImportedInstanceCallExpression call} when IsHandleBorrow(
                call
            ): if IsScopedHandle(call.Receiver) {
                "scoped handles cannot escape their scope"
            } else {
                default(string?)
            }
            case dereference is BoundDereferenceExpression: PointerRejection(dereference.Operand)
            default: "this origin has no supported stable owner (static, temporary, property, or unknown borrowed storage)"
        }
    }

    internal func IsHandleBorrow(call BoundImportedInstanceCallExpression) bool -> call
        .Method
        .Name == "Borrow" &&
        ManagedReferenceTypes.TryGetElement(call.Receiver.Type, out _, out _) && ManagedReferenceTypes.IsCompatible(
        call.Receiver.Type.ClrType
    )

    internal func IsScopedHandle(variable VariableSymbol) bool -> variable is LocalVariableSymbol local &&
        (
        local.HoldsScopedManagedReference ||
            (
            HasFunctionLocalValueScope(local) && ManagedReferenceTypes.TryGetElement(
                if local.Type is NullableTypeSymbol nullable {
                    nullable.UnderlyingType
                } else {
                    local.Type
                },
                out _,
                out _
            )
        )
    )

    // Classify the value being retained, not every input evaluated to produce
    // it. A null assertion preserves handle identity; reading its pointee does not.
    internal func IsScopedHandle(expression BoundExpression) bool -> IsScopedResult(
        expression,
        ImmutableDictionary[VariableSymbol, bool].Empty
    )

    internal func IsScopedResult(
        expression BoundExpression,
        captures ImmutableDictionary[VariableSymbol, bool]
    ) bool -> switch expression {
        case variable is BoundVariableExpression: if captures.TryGetValue(variable.Variable, out var scoped) {
            scoped
        } else {
            IsScopedHandle(variable.Variable)
        }
        case conversion is BoundConversionExpression: IsScopedResult(conversion.Expression, captures)
        case conversion is BoundAsExpression: IsScopedResult(conversion.Expression, captures)
        case BoundUnaryExpression{Op: {Kind: BoundUnaryOperatorKind.NullAssertion}} assertion: IsScopedResult(
            assertion.Operand,
            captures
        )
        case BoundBinaryExpression{Op: {Kind: BoundBinaryOperatorKind.NullCoalesce}} coalesce: IsScopedResult(
            coalesce.Left,
            captures
        ) ||
            IsScopedResult(coalesce.Right, captures)
        case block is BoundBlockExpression: IsScopedResult(block.Expression, captures)
        case conditional is BoundConditionalExpression: IsScopedResult(conditional.WhenTrue, captures) ||
            IsScopedResult(conditional.WhenFalse, captures)
        case selection is BoundSwitchExpression: selection.Arms.Any(
            (arm BoundSwitchExpressionArm) -> IsScopedResult(arm.Result, captures)
        )
        case tuple is BoundTupleLiteralExpression: tuple.Elements.Any(
            (element BoundExpression) -> IsScopedResult(element, captures)
        )
        case access is BoundNullConditionalAccessExpression: IsScopedResult(
            access.WhenNotNull,
            captures.SetItem(access.Capture, IsScopedResult(access.Receiver, captures))
        )
        case call is BoundImportedInstanceCallExpression when ManagedReferenceTypes.TryGetElement(
            call.Type,
            out _,
            out _
        ): IsScopedResult(call.Receiver, captures)
        default: false
    }

    internal func PrepareAliases(location BoundExpression, references ReferenceResolver) BoundExpression {
        switch location {
            case BoundDereferenceExpression{
                Operand: BoundVariableExpression{Variable: LocalVariableSymbol{ManagedReferenceOrigin: not nil} pointer}
            } {
                return PrepareAlias(pointer, location.Syntax, references)
            }
            case BoundVariableExpression{Variable: LocalVariableSymbol{RefKind: not RefKind.None} alias} {
                return PrepareAlias(alias, location.Syntax, references)
            }
            case BoundFieldAccessExpression{Receiver: {} receiver} field when !Binder.IsReferenceTypeForConstraint(
                receiver.Type
            ) {
                return BoundFieldAccessExpression(
                    field.Syntax,
                    PrepareAliases(receiver, references),
                    field.StructType,
                    field.Field,
                    field.SubstitutedType,
                    field.NarrowedType
                )
            }
            case BoundClrPropertyAccessExpression{Receiver: {} receiver, Member: FieldInfo} field when !Binder
                .IsReferenceTypeForConstraint(receiver.Type) {
                return BoundClrPropertyAccessExpression(
                    field.Syntax,
                    PrepareAliases(receiver, references),
                    field.Member,
                    field.Type,
                    field.StaticContainerType
                )
            }
            case block is BoundBlockExpression {
                return BoundBlockExpression(
                    block.Syntax,
                    block.Statements,
                    PrepareAliases(block.Expression, references)
                )
            }
            default {
                return location
            }
        }
    }

    internal func PrepareAlias(
        alias LocalVariableSymbol,
        syntax SyntaxNode?,
        references ReferenceResolver
    ) BoundExpression {
        if alias.ManagedReferenceStorage == nil {
            let origin = Invariant.Required(
                alias.ManagedReferenceOrigin,
                "origin checking rejected unknown borrowed aliases",
                expression: "alias.ManagedReferenceOrigin"
            )
            ManagedReferenceTypes.TryResolveDefinition(
                references,
                alias.RefKind == RefKind.RefReadOnly,
                out var definition
            )
            let type = ManagedReferenceTypes.Construct(
                Invariant.Required(
                    definition,
                    "the persistent address binder validated the runtime",
                    expression: "definition"
                ),
                origin.Type,
                references
            )
            alias.ManagedReferenceStorage = LocalVariableSymbol("<>retained_" + alias.Name, false, type)
            alias.ManagedReferenceStorageOrigin = PrepareAliases(origin, references)
        }
        return BoundDereferenceExpression(
            syntax,
            ManagedReferenceTypes.Borrow(BoundVariableExpression(syntax, alias.ManagedReferenceStorage!!))
        )
    }

    internal func CollectRoots(location BoundExpression, roots ISet[VariableSymbol]) {
        switch location {
            case BoundVariableExpression{Variable: LocalVariableSymbol{RefKind: not RefKind.None} alias} {
                if alias.ManagedReferenceOrigin is {} origin {
                    CollectRoots(origin, roots)
                }
            }
            case BoundVariableExpression{Variable: LocalVariableSymbol local} {
                roots.Add(local)
            }
            case BoundFieldAccessExpression{Receiver: {} receiver} when !Binder.IsReferenceTypeForConstraint(
                receiver.Type
            ) {
                CollectRoots(receiver, roots)
            }
            case BoundClrPropertyAccessExpression{
                Receiver: {} receiver,
                Member: FieldInfo
            } when !Binder.IsReferenceTypeForConstraint(receiver.Type) {
                CollectRoots(receiver, roots)
            }
            case block is BoundBlockExpression {
                CollectRoots(block.Expression, roots)
            }
            case BoundDereferenceExpression{Operand: BoundAddressOfExpression address} {
                CollectRoots(address.Operand, roots)
            }
        }
    }

    private func ExplicitlyScoped(local LocalVariableSymbol) bool -> if local is ParameterSymbol {
        local.IsScoped
    } else {
        (local.DeclaringSyntax is VariableDeclarationSyntax and {ScopedModifier: not nil})
    }

    private func HasFunctionLocalValueScope(local LocalVariableSymbol) bool -> if local is ParameterSymbol parameter {
        parameter.GetEffectiveValueScope() == ParameterValueScope.FunctionLocal
    } else {
        local.IsScoped
    }

    private func ReceiverRejection(receiver BoundExpression) string? -> if Binder.IsReferenceTypeForConstraint(
        receiver.Type
    ) {
        default(string?)
    } else {
        Rejection(receiver)
    }

    private func PointerRejection(pointer BoundExpression) string? -> switch pointer {
        case BoundVariableExpression{
            Variable: LocalVariableSymbol{IsReadOnly: true, ManagedReferenceOrigin: {} origin} local
        }: if ExplicitlyScoped(local) {
            "scoped borrowed storage cannot be retained"
        } else {
            Rejection(origin)
        }
        case block is BoundBlockExpression: PointerRejection(block.Expression)
        case index is BoundClrIndexExpression when NativeSliceTypes.TryGetElement(
            index.Target.Type,
            out _,
            out _
        ): default(string?)
        case address is BoundAddressOfExpression: Rejection(address.Operand)
        default: "the borrowed result has no recoverable owner; copying its value would not preserve its location"
    }
}
