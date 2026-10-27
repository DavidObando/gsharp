// <copyright file="BoundExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax

/// Bound expression.
abstract class BoundExpression : BoundNode {
    /// Initializes a new instance of the (cref:BoundExpression) class.
    /// @param syntax The originating syntax.
    protected init(syntax SyntaxNode?) : base(syntax) { }

    /// Gets the bound expression type.
    abstract prop Type TypeSymbol {
        get;
    }

    /// Gets or sets the source operand of a binder-created implicit conversion.
    /// This non-child provenance survives only verified same-operation copies.
    internal prop ImplicitConversionOperand BoundExpression? {
        get;
        set;
    }

    internal func CopyImplicitConversionTo(copy BoundConversionExpression) {
        if this is not BoundConversionExpression conversion || !object.ReferenceEquals(
            ImplicitConversionOperand,
            conversion.Expression
        ) ||
            copy.ImplicitConversionOperand != nil ||
            !object.ReferenceEquals(Syntax, copy.Syntax) || !object.ReferenceEquals(Type, copy.Type) ||
            conversion.IsChecked != copy.IsChecked ||
            !object.ReferenceEquals(conversion.Expression.Type, copy.Expression.Type) ||
            !conversion
            .Expression
            .IsSameSelectedOperationCopy(copy.Expression) {
            return
        }
        copy.ImplicitConversionOperand = copy.Expression
    }

    internal prop LogicalCompletionOperand BoundExpression? {
        get;
        private set;
    }

    internal func RecordLogicalCompletion(operand BoundExpression) {
        let actual BoundExpression? = switch this {
            case awaited is BoundAwaitExpression: awaited.Expression
            case call is BoundImportedCallExpression when call.Arguments.Length == 1: call.Arguments[0]
            default: default(BoundExpression?)
        }
        if LogicalCompletionOperand == nil && object.ReferenceEquals(actual, operand) {
            LogicalCompletionOperand = operand
        }
    }

    internal func CopyLogicalCompletionTo(copy BoundExpression) {
        if LogicalCompletionOperand == nil || !object.ReferenceEquals(Type, copy.Type) {
            return
        }
        if this is BoundAwaitExpression awaited && copy is BoundAwaitExpression completed && object.ReferenceEquals(
            LogicalCompletionOperand,
            awaited.Expression
        ) &&
            awaited
            .Expression
            .IsSameSelectedOperationCopy(completed.Expression) {
            completed.RecordLogicalCompletion(completed.Expression)
        } else if this is BoundImportedCallExpression call &&
            copy is BoundImportedCallExpression completedCall &&
            call
            .Arguments
            .Length == 1 &&
            completedCall
            .Arguments
            .Length == 1 &&
            object.ReferenceEquals(LogicalCompletionOperand, call.Arguments[0]) && object.ReferenceEquals(
            Syntax,
            copy.Syntax
        ) &&
            SameSelectedCall(copy) &&
            call
            .ArgumentRefKinds
            .Equals(completedCall.ArgumentRefKinds) && call.Arguments[0].IsSameSelectedOperationCopy(
            completedCall.Arguments[0]
        ) {
            completedCall.RecordLogicalCompletion(completedCall.Arguments[0])
        }
    }

    private func IsSameSelectedOperationCopy(copy BoundExpression) bool {
        if object.ReferenceEquals(this, copy) {
            return true
        }
        if LogicalCompletionOperand != nil || copy.LogicalCompletionOperand != nil {
            return IsSameLogicalCompletionCopy(copy)
        }
        if Syntax == nil || !object.ReferenceEquals(Syntax, copy.Syntax) {
            return false
        }
        if this is BoundPropertyAccessExpression property && copy is BoundFieldAccessExpression storage {
            return object.ReferenceEquals(property.Type, storage.Type) && object.ReferenceEquals(
                property.StructType,
                storage.StructType
            ) &&
                object.ReferenceEquals(property.InterfaceType, storage.InterfaceType) && object.ReferenceEquals(
                property.Receiver,
                storage.Receiver
            ) &&
                object.ReferenceEquals(
                property.Property,
                TypeMemberModel.PropertyForBackingField(storage.StructType, storage.Field)
            )
        }
        return SameSelectedCall(copy)
    }

    private func IsSameLogicalCompletionCopy(copy BoundExpression) bool {
        if LogicalCompletionOperand == nil || copy.LogicalCompletionOperand == nil || !object.ReferenceEquals(
            Syntax,
            copy.Syntax
        ) ||
            !object.ReferenceEquals(Type, copy.Type) {
            return false
        }
        if this is BoundAwaitExpression awaited && copy is BoundAwaitExpression completed {
            return object.ReferenceEquals(LogicalCompletionOperand, awaited.Expression) && object.ReferenceEquals(
                copy.LogicalCompletionOperand,
                completed.Expression
            ) &&
                object.ReferenceEquals(awaited.AwaiterTypeSymbol, completed.AwaiterTypeSymbol) &&
                awaited
                .Expression
                .IsSameSelectedOperationCopy(completed.Expression)
        }
        if this is BoundImportedCallExpression call &&
            copy is BoundImportedCallExpression completedCall &&
            call
            .Arguments
            .Length == 1 &&
            completedCall
            .Arguments
            .Length == 1 {
            return object.ReferenceEquals(LogicalCompletionOperand, call.Arguments[0]) && object.ReferenceEquals(
                copy.LogicalCompletionOperand,
                completedCall.Arguments[0]
            ) &&
                SameSelectedCall(copy) &&
                call
                .ArgumentRefKinds
                .Equals(completedCall.ArgumentRefKinds) && call.Arguments[0].IsSameSelectedOperationCopy(
                completedCall.Arguments[0]
            )
        }
        return false
    }

    internal prop StaticQualifierType TypeSymbol? {
        get;
        private set;
    }

    internal prop StaticQualifierSyntax ExpressionSyntax? {
        get;
        private set;
    }

    internal prop StaticMemberSyntax ExpressionSyntax? {
        get;
        private set;
    }

    internal prop StaticConstantFieldRead BoundFieldAccessExpression? {
        get;
        private set;
    }

    internal prop StaticConstraintOwner TypeSymbol? {
        get;
        private set;
    }

    internal prop StaticEnumMember EnumMemberSymbol? {
        get;
        private set;
    }

    /// Retains the actual type-receiver decision before inherited syntax anchors
    /// lose its provenance. These references are not bound/syntax tree children.
    internal func RecordStaticQualifier(type TypeSymbol, member ExpressionSyntax) {
        if StaticQualifierType != nil {
            return
        }
        var current SyntaxNode = member
        while true {
            if current.Parent is IndexExpressionSyntax index && object.ReferenceEquals(index.Target, current) {
                current = index
            } else if current.Parent is AccessorExpressionSyntax accessor && object.ReferenceEquals(
                accessor.LeftPart,
                current
            ) {
                current = accessor
            } else {
                break
            }
        }
        if current.Parent is AccessorExpressionSyntax owner && object.ReferenceEquals(owner.RightPart, current) {
            StaticQualifierType = type
            StaticQualifierSyntax = owner.LeftPart
            StaticMemberSyntax = member
            if this is BoundFieldAccessExpression{Field: {IsConst: true}} field {
                StaticConstantFieldRead = field
            }
            if this is BoundConstrainedStaticCallExpression constrained {
                StaticConstraintOwner = constrained.ConstrainedInterfaceType ??
                    constrained
                    .TypeParameter
                    .ConstraintInterfaceType
            }
        }
    }

    internal func RecordStaticEnumQualifier(type EnumSymbol, member ExpressionSyntax, selected EnumMemberSymbol) {
        if this is not BoundLiteralExpression literal || !object.ReferenceEquals(literal.Type, type) ||
            !object.ReferenceEquals(selected.EnumType, type) || !object.Equals(literal.Value, selected.Value) {
            return
        }
        RecordStaticQualifier(type, member)
        if StaticEnumMember == nil && object.ReferenceEquals(StaticQualifierType, type) && object.ReferenceEquals(
            StaticMemberSyntax,
            member
        ) {
            StaticEnumMember = selected
        }
    }

    // A copy of the same call keeps the candidates that overload resolution recorded (ADR-0212 slice S4).
    internal func CopyMemberGroupTo(copy BoundExpression) {
        if this is BoundCallOperationExpression source &&
            copy is BoundCallOperationExpression target &&
            target
            .MemberGroup
            .IsDefault &&
            !source
            .MemberGroup
            .IsDefault &&
            object.ReferenceEquals(source.Syntax, target.Syntax) &&
            source
            .CalledFunction
            .Name == target
            .CalledFunction
            .Name {
            target.MemberGroup = source.MemberGroup
        }
    }

    // Only fresh same-read copies and the compiler's verified constant fold invoke this.
    // Arbitrary virtual replacements do not inherit another read's authority.
    internal func CopyStaticQualifierTo(copy BoundExpression) {
        CopyMemberGroupTo(copy)
        if StaticQualifierType == nil || copy.StaticQualifierType != nil {
            return
        }
        let foldingConstant = this is BoundFieldAccessExpression sourceField &&
            sourceField
            .Field
            .IsConst &&
            object.ReferenceEquals(StaticConstantFieldRead, sourceField) &&
            copy is BoundLiteralExpression literal &&
            object.ReferenceEquals(sourceField.Field.Type, literal.Type) && object.Equals(
            sourceField.Field.ConstantValue,
            literal.Value
        )
        let sameRead = foldingConstant || SameSelectedCall(copy)
        if !sameRead || (!foldingConstant && !object.ReferenceEquals(Syntax, copy.Syntax)) {
            return
        }
        copy.StaticQualifierType = StaticQualifierType
        copy.StaticQualifierSyntax = StaticQualifierSyntax
        copy.StaticMemberSyntax = StaticMemberSyntax
        copy.StaticConstantFieldRead = StaticConstantFieldRead
        copy.StaticConstraintOwner = StaticConstraintOwner
        copy.StaticEnumMember = StaticEnumMember
    }

    private func SameSelectedCall(copy BoundExpression) bool -> switch this {
        case call is BoundCallExpression when copy is BoundCallExpression replacement:
        object.ReferenceEquals(call.Function, replacement.Function) && object.ReferenceEquals(
            call.StaticGenericOwnerType,
            replacement.StaticGenericOwnerType
        ) &&
            object.ReferenceEquals(call.StaticGenericInterfaceOwnerType, replacement.StaticGenericInterfaceOwnerType) &&
            call
            .MethodTypeArguments
            .Equals(replacement.MethodTypeArguments)
        case call is BoundImportedCallExpression when copy is BoundImportedCallExpression replacement:
        object.ReferenceEquals(call.Function, replacement.Function) && object.ReferenceEquals(
            call.StaticContainerType,
            replacement.StaticContainerType
        ) &&
            call
            .TypeArgumentSymbols
            .Equals(replacement.TypeArgumentSymbols)
        case call is BoundConstrainedStaticCallExpression when copy is BoundConstrainedStaticCallExpression replacement:
        object.ReferenceEquals(call.TypeParameter, replacement.TypeParameter) && object.ReferenceEquals(
            call.InterfaceMethod,
            replacement.InterfaceMethod
        ) &&
            object.ReferenceEquals(call.ClrMethod, replacement.ClrMethod) && object.ReferenceEquals(
            call.ConstrainedInterfaceType,
            replacement.ConstrainedInterfaceType
        ) &&
            call
            .TypeArgumentSymbols
            .Equals(replacement.TypeArgumentSymbols)
        case call is BoundImportedInstanceCallExpression when copy is BoundImportedInstanceCallExpression replacement:
        object.ReferenceEquals(call.Method, replacement.Method) && object.ReferenceEquals(
            call.Receiver.Type,
            replacement.Receiver.Type
        ) &&
            object.ReferenceEquals(
            call.ConstrainedReceiverTypeParameter,
            replacement.ConstrainedReceiverTypeParameter
        ) &&
            object.ReferenceEquals(call.ConstrainedInterfaceType, replacement.ConstrainedInterfaceType) &&
            call.IsNonVirtualBaseCall == replacement.IsNonVirtualBaseCall &&
            call
            .TypeArgumentSymbols
            .Equals(replacement.TypeArgumentSymbols) && call.ArgumentRefKinds.Equals(replacement.ArgumentRefKinds)
        case call is BoundUserInstanceCallExpression when copy is BoundUserInstanceCallExpression replacement:
        object.ReferenceEquals(call.Method, replacement.Method) && object.ReferenceEquals(
            call.Receiver.Type,
            replacement.Receiver.Type
        ) &&
            object.ReferenceEquals(
            call.ConstrainedReceiverTypeParameter,
            replacement.ConstrainedReceiverTypeParameter
        ) &&
            object.ReferenceEquals(call.ConstrainedInterfaceType, replacement.ConstrainedInterfaceType) &&
            call
            .MethodTypeArguments
            .Equals(replacement.MethodTypeArguments)
        case call is BoundBaseClassCallExpression when copy is BoundBaseClassCallExpression replacement:
        object.ReferenceEquals(call.BaseClass, replacement.BaseClass) && object.ReferenceEquals(
            call.Method,
            replacement.Method
        ) &&
            object.ReferenceEquals(call.Property, replacement.Property) &&
            call.IsSetterAccessor == replacement.IsSetterAccessor &&
            call
            .MethodTypeArguments
            .Equals(replacement.MethodTypeArguments)
        case call is BoundBaseInterfaceCallExpression when copy is BoundBaseInterfaceCallExpression replacement:
        object.ReferenceEquals(call.Interface, replacement.Interface) && object.ReferenceEquals(
            call.Method,
            replacement.Method
        )
        case call is BoundClrStaticCallExpression when copy is BoundClrStaticCallExpression replacement:
        object.ReferenceEquals(call.Method, replacement.Method) && call.ArgumentRefKinds.Equals(
            replacement.ArgumentRefKinds
        )
        case call is BoundIndirectCallExpression when copy is BoundIndirectCallExpression replacement:
        object.ReferenceEquals(call.FunctionType, replacement.FunctionType) && object.ReferenceEquals(
            call.Target,
            replacement.Target
        ) &&
            call
            .ArgumentRefKinds
            .Equals(replacement.ArgumentRefKinds)
        default: false
    }

    /// Gets the compile-time constant value of this expression — the Roslyn
    /// `ConstantValue` analogue (ADR-0169). `HasValue` is false
    /// when the expression has no compile-time constant; a constant null
    /// literal reports `HasValue` true with a null `Value`.
    open prop ConstantValue OptionalValue -> default(OptionalValue)
}
