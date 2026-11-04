// <copyright file="SubmissionBinding.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Diagnostics.CodeAnalysis

/// Door between the batch binder and interactive submission binding (ADR-0212 slice S8, issue #5312).
/// Every query returns `false` when (cref:BoundScope.SubmissionImports) is `null`.
internal shared class SubmissionBinding {
    internal func ConfigureRootScope(root BoundScope, options SubmissionBindingOptions?) {
        root.SetSubmissionOptions(options)
        root.SetSubmissionImports(options?.Imports)
    }

    internal func SetImports(root BoundScope, imports SubmissionImports?) {
        root.SetSubmissionImports(imports)
    }

    internal func HasTypeName($scope BoundScope, name string) bool -> $scope.SubmissionImports is {} submissions &&
        submissions.TryResolveType($scope.References!!, name, -1, out _)

    internal func TryLookupGenericClass(
        $scope BoundScope,
        name string,
        arity int32,
        @NotNullWhen(true) out type Type?
    ) bool {
        if $scope.SubmissionImports is not{} submissions {
            type = nil
            return false
        }
        return submissions.TryResolveType($scope.References!!, name, arity, out type)
    }

    internal func TryLookupClassByArity(
        $scope BoundScope,
        name string,
        preferredArity int32,
        declaration ExpressionSyntax?,
        @NotNullWhen(true) out importedClass ImportedClassSymbol?
    ) bool {
        importedClass = nil
        if $scope.SubmissionImports is not{} submissions || !submissions.TryResolveType(
            $scope.References!!,
            name,
            preferredArity,
            out var submissionType
        ) ||
            submissionType!!.IsGenericTypeDefinition {
            return false
        }
        importedClass = ImportedClassSymbol(submissionType!!, declaration, references: $scope.References)
        return true
    }

    internal func TryResolveType(
        $scope BoundScope,
        name string,
        preferredArity int32,
        @NotNullWhen(true) out type TypeSymbol?
    ) bool {
        type = nil
        if $scope.SubmissionImports is not{} submissions || !submissions.TryResolveType(
            $scope.References!!,
            name,
            preferredArity,
            out var submissionClrType
        ) {
            return false
        }
        if ImportedTypeSymbol.TryCreateSemanticAggregate(
            submissionClrType,
            $scope.References,
            out var submissionAggregate
        ) {
            type = submissionAggregate
            return true
        }
        type = TypeSymbol.FromClrTypeWithoutNullability(submissionClrType, NullabilityFreeReason.ResolvedTypeName)
        return true
    }

    internal func HasMember($scope BoundScope, name string) bool -> $scope.SubmissionImports is {} submissions &&
        submissions.TryFindMemberContainer($scope.References!!, name, out _)

    internal func TryFindMemberContainer(
        $scope BoundScope,
        name string,
        @NotNullWhen(true) out programType Type?
    ) bool {
        programType = nil
        return $scope.SubmissionImports is {} submissions && submissions.TryFindMemberContainer(
            $scope.References!!,
            name,
            out programType
        ) &&
            programType != nil
    }

    internal func TryFindFunctionContainer(
        $scope BoundScope,
        name string,
        @NotNullWhen(true) out programType Type?
    ) bool {
        programType = nil
        return $scope.SubmissionImports is {} submissions && submissions.TryFindFunctionContainer(
            $scope.References!!,
            name,
            out programType
        ) &&
            programType != nil
    }

    internal func TryFindGlobalVariable(
        $scope BoundScope,
        name string,
        @NotNullWhen(true) out programType Type?,
        @NotNullWhen(true) out declared VariableSymbol?
    ) bool {
        programType = nil
        declared = nil
        return $scope.SubmissionImports is {} submissions && submissions.TryFindGlobalVariable(
            $scope.References!!,
            name,
            out programType,
            out declared
        ) &&
            programType != nil &&
            declared != nil
    }

    internal func TryFindWritableGlobal(
        $scope BoundScope,
        name string,
        @NotNullWhen(true) out programType Type?,
        @NotNullWhen(true) out declared VariableSymbol?
    ) bool -> TryFindGlobalVariable($scope, name, out programType, out declared)

    internal func HasCallableCandidate($scope BoundScope, name string) bool {
        if $scope.SubmissionImports is not{} submissions {
            return false
        }
        if submissions.TryFindFunctionContainer($scope.References!!, name, out _) {
            return true
        }
        return submissions.TryFindGlobalVariable($scope.References!!, name, out _, out var declared) &&
            declared is {} previous &&
            (
            previous.Type is FunctionPointerTypeSymbol || MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(
                previous.Type,
                out _
            )
        )
    }

    internal func TryBindCall(
        resolver OverloadResolver,
        syntax CallExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        if resolver.SubmissionScope.SubmissionImports is not{} submissions {
            result = nil
            return false
        }
        return resolver.TryBindSubmissionCall(syntax, submissions, out result)
    }

    internal func TryBindStaticMember(
        binder ExpressionBinder,
        syntax NameExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        if binder.SubmissionScope.SubmissionImports == nil {
            result = nil
            return false
        }
        return binder.TryBindSubmissionStaticMember(syntax, out result)
    }

    internal func TryBindStaticFieldWrite(
        binder ExpressionBinder,
        name string,
        valueSyntax ExpressionSyntax,
        operatorLocation TextLocation,
        out result BoundExpression?
    ) bool {
        if binder.SubmissionScope.SubmissionImports == nil {
            result = nil
            return false
        }
        return binder.TryBindSubmissionStaticFieldWrite(name, valueSyntax, operatorLocation, out result)
    }

    internal func TryBindStaticFieldCompound(
        binder ExpressionBinder,
        name string,
        bareName NameExpressionSyntax,
        syntax EventSubscriptionExpressionSyntax,
        out result BoundExpression?
    ) bool {
        if binder.SubmissionScope.SubmissionImports == nil {
            result = nil
            return false
        }
        return binder.TryBindSubmissionStaticFieldCompound(name, bareName, syntax, out result)
    }

    internal func TryBindGlobalIndexAssignment(
        binder ExpressionBinder,
        syntax IndexAssignmentExpressionSyntax,
        out result BoundExpression?
    ) bool {
        if binder.SubmissionScope.SubmissionImports == nil {
            result = nil
            return false
        }
        return binder.TryBindSubmissionGlobalIndexAssignment(syntax, out result)
    }

    internal func TryBindGlobalMemberAssignment(
        binder ExpressionBinder,
        syntax FieldAssignmentExpressionSyntax,
        out result BoundExpression?
    ) bool {
        if binder.SubmissionScope.SubmissionImports == nil {
            result = nil
            return false
        }
        return binder.TryBindSubmissionGlobalMemberAssignment(syntax, out result)
    }

    internal func ReportGlobalMemberWriteBlocked(
        binder ExpressionBinder,
        receiver BoundExpression,
        memberName string,
        location TextLocation
    ) bool {
        if binder.SubmissionScope.SubmissionImports == nil {
            return false
        }
        return binder.ReportSubmissionGlobalMemberWriteBlocked(receiver, memberName, location)
    }
}
