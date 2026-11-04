// <copyright file="OverloadResolver.Submissions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding.OverloadResolution

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import System.Diagnostics.CodeAnalysis
import System.Reflection

/// Interactive-submission call resolution on (cref:OverloadResolver) (ADR-0156 Phase 2, ADR-0212 slice S8).
internal partial class OverloadResolver {
    internal prop SubmissionScope BoundScope -> Scope

    internal func TryBindSubmissionCall(
        syntax CallExpressionSyntax,
        submissionImports SubmissionImports,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        if bindImportedClrStaticCall != nil && submissionImports.TryFindFunctionContainer(
            Scope.References!!,
            syntax.Identifier.ValueText,
            out var submissionProgramType
        ) &&
            submissionProgramType != nil {
            result = bindImportedClrStaticCall!!(submissionProgramType, syntax)
            return true
        }
        if TryBindSubmissionDelegateGlobalCall(syntax, submissionImports, out var submissionDelegateCall) {
            result = Invariant.Required(
                submissionDelegateCall,
                "a matched submission delegate global produces a bound invocation",
                expression: "submissionDelegateCall"
            )
            return true
        }
        return false
    }

    private func TryBindSubmissionDelegateGlobalCall(
        syntax CallExpressionSyntax,
        submissionImports SubmissionImports,
        out result BoundExpression?
    ) bool {
        result = nil
        let name = syntax.Identifier.ValueText
        if !submissionImports.TryFindGlobalVariable(Scope.References!!, name, out var programType, out _) {
            return false
        }
        if programType == nil {
            return false
        }
        let field FieldInfo? = programType.GetField(name, BindingFlags.Public | BindingFlags.Static)
        if field == nil || !TryMapClrDelegateToFunctionType(field.FieldType, out var functionType) {
            return false
        }
        let calleeLoad = BoundClrPropertyAccessExpression(
            syntax,
            receiver: nil,
            field,
            Invariant.Required(functionType, "a mapped CLR delegate has a function type", expression: "functionType")
        )
        result = BindIndirectCallExpression(
            syntax,
            calleeLoad,
            name,
            syntax.Identifier.Location,
            nullSafeInvocation: nil
        )
        return true
    }
}
