// <copyright file="ExpressionBinder.Submissions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Reflection
import System.Threading

/// Interactive-submission member reads and global writes on (cref:ExpressionBinder) (ADR-0156 Phase 2, ADR-0212 slice S8).
internal partial class ExpressionBinder {
    internal prop SubmissionScope BoundScope -> $scope

    /// Classification of a member-write receiver whose chain bottoms out at a prior interactive
    /// submission's top-level global (an addressable static field on that submission's `<Program>`
    /// container). `None` for every other shape, so non-REPL binding behavior is unchanged.
    private enum SubmissionWriteReceiverKind {
        None,
        Addressable,
        ReadOnlyRoot,
        NotAddressable
    }

    internal func TryBindSubmissionStaticMember(
        syntax NameExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        let name = syntax.IdentifierToken.ValueText
        if !SubmissionBinding.TryFindMemberContainer($scope, name, out var programType) {
            return false
        }
        let classSymbol = ImportedClassSymbol(programType, syntax, references: $scope.References)
        result = BindAccessorStep(receiver: nil, classSymbol, syntax)
        if result is BoundClrPropertyAccessExpression{Receiver: nil, Member: FieldInfo globalField} fieldRead &&
            SubmissionBinding
            .TryFindGlobalVariable($scope, name, out _, out var declaredGlobal) {
            result = BoundClrPropertyAccessExpression(
                fieldRead.Syntax,
                receiver: nil,
                fieldRead.Member,
                SubmissionGlobalTypeProjection.ReverseProject(
                    fieldRead.Type,
                    globalField.FieldType,
                    declaredGlobal?.Type,
                    $scope.References!!
                ),
                fieldRead.StaticContainerType,
                isAddressableStaticField: true,
                isReadOnlySubmissionGlobal: declaredGlobal?.IsReadOnly == true
            )
        }
        if result is BoundClrMethodGroupExpression{ResolvedMethod: nil} submissionGroup &&
            submissionGroup
            .Candidates
            .Length == 1 &&
            TryGetNaturalClrMethodGroupType(submissionGroup, out var naturalFunctionType) {
            result = conversions.BindConversion(syntax.Location, submissionGroup, naturalFunctionType)
        }
        return true
    }

    internal func TryBindSubmissionStaticFieldWrite(
        name string,
        valueSyntax ExpressionSyntax,
        operatorLocation TextLocation,
        out result BoundExpression?
    ) bool {
        result = nil
        if !SubmissionBinding.TryFindWritableGlobal(
            $scope,
            name,
            out var resolvedProgramType,
            out var resolvedDeclared
        ) {
            return false
        }
        let classSymbol = ImportedClassSymbol(resolvedProgramType, declaration: nil, references: $scope.References)
        if !classSymbol.TryLookupMember(name, ne: nil, out var member) ||
            !TryGetWritableClrMember(member, out _, out var targetSymbol, out _) {
            Diagnostics.ReportCannotAssign(operatorLocation, name)
            result = BoundErrorExpression(nil)
            return true
        }
        if resolvedDeclared.IsReadOnly {
            Diagnostics.ReportCannotAssign(operatorLocation, name)
        }
        if member is FieldInfo globalField {
            targetSymbol = SubmissionGlobalTypeProjection.ReverseProject(
                targetSymbol!!,
                globalField.FieldType,
                resolvedDeclared.Type,
                $scope.References!!
            )
        }
        let value = BindAssignmentRhs(valueSyntax, targetSymbol)
        let converted = conversions.BindConversion(valueSyntax.Location, value, targetSymbol)
        result = BoundClrPropertyAssignmentExpression(
            nil,
            receiver: nil,
            member!!,
            converted,
            targetSymbol!!,
            staticContainerType: nil
        )
        return true
    }

    internal func TryBindSubmissionStaticFieldCompound(
        name string,
        bareName NameExpressionSyntax,
        syntax EventSubscriptionExpressionSyntax,
        out result BoundExpression?
    ) bool {
        result = nil
        if !SubmissionBinding.TryFindWritableGlobal(
            $scope,
            name,
            out var resolvedProgramType,
            out var resolvedDeclared
        ) {
            return false
        }
        let classSymbol = ImportedClassSymbol(resolvedProgramType, declaration: nil, references: $scope.References)
        if !classSymbol.TryLookupMember(name, ne: nil, out var member) ||
            !TryGetWritableClrMember(member, out _, out var targetSymbol, out _) {
            Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name)
            result = BoundErrorExpression(nil)
            return true
        }
        if resolvedDeclared.IsReadOnly {
            Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name)
        }
        if !TryBindSubmissionStaticMember(bareName, out var boundLeft) {
            return false
        }
        let compoundTarget = boundLeft!!
        var leftExpr = compoundTarget
        let previousValue = CapturePostfixCompoundValue(
            syntax.ReturnsPreviousValue,
            syntax,
            &leftExpr,
            out var previousDeclaration
        )
        let boundRhs = BindExpression(syntax.Value)
        SyntaxFacts.TryGetCompoundAssignmentBaseOperator(syntax.OperatorToken.Kind, out var baseOpSyntaxKind)
        let userCompound BoundExpression? = TryBindUserCompoundAssignmentOperator(
            syntax.OperatorToken.Kind,
            compoundTarget,
            boundRhs,
            syntax.Value.Location
        )
        if userCompound != nil {
            result = FinishUserCompoundIncrement(
                syntax,
                compoundTarget,
                userCompound,
                previousDeclaration,
                previousValue
            )
            return true
        }
        let binaryResult BoundExpression? = TryBindCompoundBinaryOperation(
            baseOpSyntaxKind,
            leftExpr,
            boundRhs,
            syntax.Value.Location
        )
        if binaryResult == nil {
            Diagnostics.ReportUndefinedBinaryOperator(
                syntax.OperatorToken.Location,
                syntax.OperatorToken.Text,
                leftExpr.Type,
                boundRhs.Type
            )
            result = BoundErrorExpression(nil)
            return true
        }
        let converted = conversions.BindConversion(syntax.Value.Location, binaryResult, targetSymbol)
        let assignment = BoundClrPropertyAssignmentExpression(
            nil,
            receiver: nil,
            member!!,
            converted,
            targetSymbol!!,
            staticContainerType: nil
        )
        result = FinishPostfixCompoundAssignment(syntax, previousDeclaration, previousValue, assignment)
        return true
    }

    internal func TryBindSubmissionGlobalIndexAssignment(
        syntax IndexAssignmentExpressionSyntax,
        out result BoundExpression?
    ) bool {
        result = nil
        let name = syntax.TargetIdentifier.ValueText
        if !SubmissionBinding.TryFindWritableGlobal($scope, name, out _, out _) {
            return false
        }
        if $scope.TryLookupSymbol(name) != nil {
            return false
        }
        let nameSyntax = NameExpressionSyntax(syntax.SyntaxTree, syntax.TargetIdentifier)
        if !TryBindSubmissionStaticMember(nameSyntax, out var receiver) ||
            receiver is BoundErrorExpression ||
            receiver!!.Type == TypeSymbol.Error {
            return false
        }
        let tempName = "<idxAsn${Interlocked.Increment(&binderCtx.SyntheticLocalCounter)}>"
        let tempVar = LocalVariableSymbol(tempName, isReadOnly: true, receiver!!.Type)
        $scope.TryDeclareVariable(tempVar)
        let declaration = BoundVariableDeclaration(syntax, tempVar, receiver)
        let assignment = BindIndexedAssignmentToVariable(
            tempVar,
            syntax.Index,
            syntax.Value,
            syntax.TargetIdentifier.Location
        )
        if assignment is BoundErrorExpression {
            result = assignment
            return true
        }
        result = BoundBlockExpression(syntax, ImmutableArray.Create[BoundStatement](declaration), assignment)
        return true
    }

    internal func TryBindSubmissionGlobalMemberAssignment(
        syntax FieldAssignmentExpressionSyntax,
        out result BoundExpression?
    ) bool {
        result = nil
        let name = syntax.Receiver.Text
        if !SubmissionBinding.TryFindWritableGlobal(
            $scope,
            name,
            out var resolvedProgramType,
            out var resolvedDeclared
        ) {
            return false
        }
        if BindVariableReference(
            name,
            syntax.Receiver.Location,
            suppressNotAVariable: true,
            suppressUndefinedVariable: true
        ) != nil {
            return false
        }
        let container = ImportedClassSymbol(resolvedProgramType, declaration: nil, references: $scope.References)
        if !container.TryLookupMember(name, ne: nil, out var globalMember) ||
            globalMember is not FieldInfo globalField {
            return false
        }
        let globalType = ClrNullability.GetFieldTypeSymbol(globalField)
        if globalType?.ClrType == nil {
            return false
        }
        let receiver = BoundClrPropertyAccessExpression(
            nil,
            receiver: nil,
            globalField,
            globalType,
            isAddressableStaticField: true,
            isReadOnlySubmissionGlobal: resolvedDeclared.IsReadOnly
        )
        let clrReceiverType = globalType.ClrType
        let memberName = syntax.FieldIdentifier.ValueText
        var instanceMember MemberInfo? = SafeGetVisibleInstanceProperty(clrReceiverType!!, memberName)
        if instanceMember is PropertyInfo indexedProperty && indexedProperty.GetIndexParameters().Length != 0 {
            instanceMember = nil
        }
        instanceMember ??= SafeGetVisibleInstanceField(clrReceiverType!!, memberName)
        if instanceMember == nil {
            Diagnostics.ReportUnableToFindMember(syntax.FieldIdentifier.Location, memberName)
            result = BoundErrorExpression(nil)
            return true
        }
        if !TryGetWritableClrMember(instanceMember, globalType, out _, out var targetSymbol, out _) {
            Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, memberName)
            result = BoundErrorExpression(nil)
            return true
        }
        if resolvedDeclared.IsReadOnly && !ReceiverTypeIsReference(globalType) {
            Diagnostics.ReportCannotAssign(syntax.EqualsToken.Location, name)
        }
        let value = BindAssignmentRhs(syntax.Value, targetSymbol)
        let converted = conversions.BindConversion(syntax.Value.Location, value, targetSymbol)
        result = BoundClrPropertyAssignmentExpression(
            nil,
            receiver,
            instanceMember,
            converted,
            targetSymbol!!,
            staticContainerType: nil
        )
        return true
    }

    internal func ReportSubmissionGlobalMemberWriteBlocked(
        receiver BoundExpression,
        memberName string,
        location TextLocation
    ) bool {
        switch ClassifySubmissionGlobalWriteReceiver(receiver) {
            case SubmissionWriteReceiverKind.ReadOnlyRoot {
                Diagnostics.ReportCannotAssign(location, memberName)
                return false
            }
            case SubmissionWriteReceiverKind.NotAddressable {
                Diagnostics.ReportFieldAssignmentThroughStructTemporary(location, memberName, receiver.Type)
                return true
            }
            default {
                return false
            }
        }
    }

    shared {
        private func ClassifySubmissionGlobalWriteReceiver(receiver BoundExpression?) SubmissionWriteReceiverKind {
            if receiver == nil || ReceiverTypeIsReference(receiver.Type) {
                return SubmissionWriteReceiverKind.None
            }
            if TryGetElementAccessTarget(receiver, out var elementCollection) &&
                elementCollection is {} resolvedElementCollection {
                if !ChainHasSubmissionGlobalRoot(resolvedElementCollection) {
                    return SubmissionWriteReceiverKind.None
                }
                return if IsAddressableElementLoad(receiver) {
                    SubmissionWriteReceiverKind.Addressable
                } else {
                    SubmissionWriteReceiverKind.NotAddressable
                }
            }
            var access BoundClrPropertyAccessExpression? = receiver as BoundClrPropertyAccessExpression
            if access == nil {
                return SubmissionWriteReceiverKind.None
            }
            var sawComputedLink = false
            while true {
                if access.Receiver == nil {
                    if !access.IsAddressableStaticField {
                        return SubmissionWriteReceiverKind.None
                    }
                    if access.IsReadOnlySubmissionGlobal {
                        return SubmissionWriteReceiverKind.ReadOnlyRoot
                    }
                    return if sawComputedLink {
                        SubmissionWriteReceiverKind.NotAddressable
                    } else {
                        SubmissionWriteReceiverKind.Addressable
                    }
                }
                if !(access.Member is FieldInfo) {
                    sawComputedLink = true
                }
                if ReceiverTypeIsReference(access.Receiver.Type) {
                    if access.Receiver is BoundClrPropertyAccessExpression referenceLink &&
                        ChainHasSubmissionGlobalRoot(referenceLink) {
                        return if sawComputedLink {
                            SubmissionWriteReceiverKind.NotAddressable
                        } else {
                            SubmissionWriteReceiverKind.Addressable
                        }
                    }
                    return SubmissionWriteReceiverKind.None
                }
                if TryGetElementAccessTarget(access.Receiver!!, out var linkCollection) &&
                    linkCollection is {} resolvedLinkCollection {
                    if !ChainHasSubmissionGlobalRoot(resolvedLinkCollection) {
                        return SubmissionWriteReceiverKind.None
                    }
                    return if !sawComputedLink && IsAddressableElementLoad(access.Receiver!!) {
                        SubmissionWriteReceiverKind.Addressable
                    } else {
                        SubmissionWriteReceiverKind.NotAddressable
                    }
                }
                if access.Receiver is not BoundClrPropertyAccessExpression inner {
                    return SubmissionWriteReceiverKind.None
                }
                access = inner
            }
        }

        private func TryGetElementAccessTarget(expression BoundExpression, out collection BoundExpression?) bool {
            switch expression {
                case index is BoundIndexExpression {
                    collection = index.Target
                    return true
                }
                case clrIndex is BoundClrIndexExpression {
                    collection = clrIndex.Target
                    return true
                }
                default {
                    collection = nil
                    return false
                }
            }
        }

        private func IsAddressableElementLoad(expression BoundExpression) bool -> expression is BoundIndexExpression &&
            expression.IsArrayBackedElementAccess == true

        private func ChainHasSubmissionGlobalRoot(expression BoundExpression) bool {
            var expression = expression
            while true {
                switch expression {
                    case BoundClrPropertyAccessExpression{Receiver: nil} root {
                        return root.IsAddressableStaticField
                    }
                    case link is BoundClrPropertyAccessExpression {
                        expression = link.Receiver!!
                        continue
                    }
                    case index is BoundIndexExpression {
                        expression = index.Target
                        continue
                    }
                    case clrIndex is BoundClrIndexExpression {
                        expression = clrIndex.Target
                        continue
                    }
                    default {
                        return false
                    }
                }
            }
        }
    }
}
