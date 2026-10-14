// <copyright file="MethodGroupDiagnostics.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import System.Reflection

/// Reports method groups that escaped without a delegate target.
internal shared class MethodGroupDiagnostics {
    private class Walker : BoundTreeWalker {
        private let diagnostics DiagnosticBag
        private var callArgumentDepth int32

        init(diagnostics DiagnosticBag) {
            this.diagnostics = diagnostics
        }

        protected override func VisitCallExpression(node BoundCallExpression) -> VisitCallArguments(node.Arguments)

        protected override func VisitImportedCallExpression(node BoundImportedCallExpression) -> VisitCallArguments(
            node.Arguments
        )

        protected override func VisitImportedInstanceCallExpression(node BoundImportedInstanceCallExpression) {
            VisitExpression(node.Receiver)
            VisitCallArguments(node.Arguments)
        }

        protected override func VisitConstrainedStaticCallExpression(
            node BoundConstrainedStaticCallExpression
        ) -> VisitCallArguments(node.Arguments)

        protected override func VisitConversionExpression(node BoundConversionExpression) {
            if node.Expression is BoundMethodGroupExpression userGroup {
                VisitExpression(userGroup.Receiver)
            } else if node.Expression is BoundClrMethodGroupExpression clrGroup {
                VisitExpression(clrGroup.Receiver)
            } else {
                base.VisitConversionExpression(node)
            }
        }

        protected override func VisitConstructorCallExpression(
            node BoundConstructorCallExpression
        ) -> VisitCallArguments(node.Arguments)

        protected override func VisitConstructorChainingExpression(
            node BoundConstructorChainingExpression
        ) -> VisitCallArguments(node.Arguments)

        protected override func VisitUserInstanceCallExpression(node BoundUserInstanceCallExpression) {
            VisitExpression(node.Receiver)
            VisitCallArguments(node.Arguments)
        }

        protected override func VisitBaseInterfaceCallExpression(node BoundBaseInterfaceCallExpression) {
            VisitExpression(node.Receiver)
            VisitCallArguments(node.Arguments)
        }

        protected override func VisitBaseClassCallExpression(node BoundBaseClassCallExpression) {
            VisitExpression(node.Receiver)
            VisitCallArguments(node.Arguments)
        }

        protected override func VisitIndirectCallExpression(node BoundIndirectCallExpression) {
            VisitExpression(node.Target)
            VisitCallArguments(node.Arguments)
        }

        protected override func VisitClrConstructorCallExpression(
            node BoundClrConstructorCallExpression
        ) -> VisitCallArguments(node.Arguments)

        protected override func VisitClrStaticCallExpression(node BoundClrStaticCallExpression) -> VisitCallArguments(
            node.Arguments
        )

        protected override func VisitClrIndexExpression(node BoundClrIndexExpression) {
            VisitExpression(node.Target)
            VisitCallArguments(node.Arguments)
        }

        protected override func VisitClrIndexAssignmentExpression(node BoundClrIndexAssignmentExpression) {
            VisitExpression(node.TargetExpression)
            VisitCallArguments(node.Arguments)
            VisitExpression(node.Value)
        }

        protected override func VisitClrMethodGroupExpression(node BoundClrMethodGroupExpression) {
            if this.callArgumentDepth == 0 && node.ResolvedMethod == nil {
                MethodGroupDiagnostics.ReportRequiresTarget(
                    this.diagnostics,
                    node,
                    node.Syntax?.Location ?? default(TextLocation)
                )
            }
            base.VisitClrMethodGroupExpression(node)
        }

        protected override func VisitMethodGroupExpression(node BoundMethodGroupExpression) {
            if this.callArgumentDepth == 0 && !MethodGroupDiagnostics.HasDelegateTarget(node) {
                MethodGroupDiagnostics.ReportRequiresTarget(
                    this.diagnostics,
                    node,
                    node.Syntax?.Location ?? default(TextLocation)
                )
            }
            base.VisitMethodGroupExpression(node)
        }

        private func VisitCallArguments(arguments ImmutableArray[BoundExpression]) {
            for argument in arguments {
                this.callArgumentDepth++
                try {
                    VisitExpression(argument)
                } finally {
                    this.callArgumentDepth--
                }
            }
        }
    }

    func RequiresTarget(expression BoundExpression) bool -> expression is BoundMethodGroupExpression &&
        expression.FunctionType == nil ||
        expression is BoundClrMethodGroupExpression &&
        expression.ResolvedMethod == nil

    func HasDelegateTarget(expression BoundExpression) bool {
        if expression is BoundClrMethodGroupExpression clrGroup {
            return clrGroup.ResolvedMethod != nil
        }
        return expression is BoundMethodGroupExpression userGroup && userGroup.HasTargetDelegateType
    }

    func ReportRequiresTarget(
        diagnostics DiagnosticBag,
        expression BoundExpression,
        fallbackLocation TextLocation
    ) BoundErrorExpression {
        let (kind, name) = Describe(expression)
        diagnostics.ReportMethodGroupRequiresTarget(GetNameLocation(expression.Syntax, fallbackLocation), kind, name)
        return BoundErrorExpression(nil)
    }

    func ReportUnresolved(root BoundNode, diagnostics DiagnosticBag) -> MethodGroupDiagnostics.Walker(diagnostics)
        .Visit(root)

    private func Describe(expression BoundExpression)(Kind string, Name string) {
        if expression is BoundClrMethodGroupExpression clrGroup {
            let kind = if clrGroup.Receiver == nil {
                "imported static method group"
            } else {
                (
                    if clrGroup.Candidates.Any((candidate MethodInfo) -> candidate.IsStatic) {
                        "imported extension method group"
                    } else {
                        "imported instance method group"
                    }
                )
            }
            return (kind, clrGroup.MethodName)
        }
        let userGroup = cast[BoundMethodGroupExpression](expression)
        let userKind = if userGroup.Candidates.Any((candidate FunctionSymbol) -> candidate.IsExtension) {
            "user extension method group"
        } else {
            (
                if userGroup.Receiver != nil {
                    "user instance method group"
                } else {
                    (
                        if userGroup.StaticOwnerType != nil || userGroup.Candidates.Any(
                            (candidate FunctionSymbol) -> candidate.IsStatic
                        ) {
                            "user static method group"
                        } else {
                            "user method group"
                        }
                    )
                }
            )
        }
        let userName = userGroup.Function?.Name ?? userGroup.Candidates.FirstOrDefault()?.Name ?? "<method group>"
        return (userKind, userName)
    }

    private func GetNameLocation(syntax SyntaxNode?, fallbackLocation TextLocation) TextLocation {
        var syntax = syntax
        while syntax is ParenthesizedExpressionSyntax parenthesized {
            syntax = parenthesized.Expression
        }
        while syntax is AccessorExpressionSyntax accessor {
            syntax = accessor.RightPart
        }
        return switch syntax {
            case name is NameExpressionSyntax: name.IdentifierToken.Location
            case generic is GenericNameExpressionSyntax: generic.Identifier.Location
            default: fallbackLocation
        }
    }
}
