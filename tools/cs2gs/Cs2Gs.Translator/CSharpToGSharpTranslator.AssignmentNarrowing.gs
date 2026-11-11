// <copyright file="CSharpToGSharpTranslator.AssignmentNarrowing.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System.Collections.Generic
import System.Linq

partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        private var assignmentNarrowingQueries Dictionary[
            (ExpressionSyntax, SyntaxNode, ISymbol, SyntaxNode, bool),
            bool
        ]?

        // Issue #5936: gsc records assignment postconditions, not Roslyn's nullable flow state or declaration initializers.
        private func IsGSharpAssignmentNarrowedLocal(
            expression ExpressionSyntax,
            effectiveTarget SyntaxNode,
            symbol ISymbol?,
            $scope SyntaxNode,
            requireRuntimeNonNullProof bool
        ) bool {
            let type = this.GetDeclaredValueType(expression)
            if symbol == nil {
                return false
            }
            if type == nil {
                return false
            }
            if type.IsReferenceType != true ||
                (
                type.NullableAnnotation != NullableAnnotation.Annotated && !this.IsTranslatorWidenedDeclaration(symbol)
            ) {
                return false
            }
            // Share completed queries only within one analysis pass. Emission state can change before the next pass.
            let rootQuery = this.assignmentNarrowingQueries == nil
            let queries = this.assignmentNarrowingQueries ??
                Dictionary[(ExpressionSyntax, SyntaxNode, ISymbol, SyntaxNode, bool), bool]()
            this.assignmentNarrowingQueries = queries
            let key = (expression, effectiveTarget, symbol, $scope, requireRuntimeNonNullProof)
            try {
                if queries.TryGetValue(key, out var cached) {
                    return cached
                }
                let result = this.ComputeGSharpAssignmentNarrowedLocal(
                    expression,
                    effectiveTarget,
                    symbol,
                    $scope,
                    requireRuntimeNonNullProof
                )
                queries[key] = result
                return result
            } finally {
                if rootQuery {
                    this.assignmentNarrowingQueries = nil
                }
            }
        }

        private func ComputeGSharpAssignmentNarrowedLocal(
            expression ExpressionSyntax,
            effectiveTarget SyntaxNode,
            symbol ISymbol,
            $scope SyntaxNode,
            requireRuntimeNonNullProof bool
        ) bool {
            var proof SyntaxNode? = nil
            for step in this.GetStatementSteps(effectiveTarget, $scope) {
                let statements IEnumerable[StatementSyntax] = switch step.Owner {
                    case block is BlockSyntax: block.Statements
                    case section is SwitchSectionSyntax: section.Statements
                    case unit is CompilationUnitSyntax: unit
                        .Members
                        .OfType[GlobalStatementSyntax]()
                        .Select((global GlobalStatementSyntax) -> global.Statement)
                    default: Enumerable.Empty[StatementSyntax]()
                }
                for statement in statements {
                    if statement.SpanStart >= step.Statement.SpanStart {
                        break
                    }
                    proof = this.GetGSharpAssignmentNarrowingProof(
                        statement,
                        symbol,
                        expression,
                        $scope,
                        proof,
                        requireRuntimeNonNullProof
                    )
                }
                if step.Statement is ForStatementSyntax forLoop {
                    for initializer in forLoop.Initializers {
                        if initializer.Span.End <= effectiveTarget.SpanStart {
                            proof = this.GetGSharpAssignmentNarrowingProof(
                                initializer,
                                symbol,
                                expression,
                                $scope,
                                proof,
                                requireRuntimeNonNullProof
                            )
                        }
                    }
                }
            }
            return proof != nil && this.AssignmentNarrowingSurvivesToRead(
                symbol,
                proof,
                expression,
                effectiveTarget,
                $scope
            )
        }

        private func GetGSharpAssignmentNarrowingProof(
            statement SyntaxNode,
            symbol ISymbol,
            use ExpressionSyntax,
            $scope SyntaxNode,
            inherited SyntaxNode?,
            requireRuntimeNonNullProof bool
        ) SyntaxNode? {
            if statement is LocalFunctionStatementSyntax {
                return inherited
            }
            if statement is LabeledStatementSyntax labeled {
                let incoming = if inherited != nil && this.AssignmentNarrowingSurvivesToRead(
                    symbol,
                    inherited,
                    use,
                    labeled,
                    $scope
                ) {
                    inherited
                } else {
                    default(SyntaxNode?)
                }
                return this.GetGSharpAssignmentNarrowingProof(
                    labeled.Statement,
                    symbol,
                    use,
                    $scope,
                    incoming,
                    requireRuntimeNonNullProof
                )
            }
            if statement is BlockSyntax block {
                var proof = inherited
                for child in block.Statements {
                    proof = this.GetGSharpAssignmentNarrowingProof(
                        child,
                        symbol,
                        use,
                        $scope,
                        proof,
                        requireRuntimeNonNullProof
                    )
                }
                return proof
            }
            if statement is IfStatementSyntax conditional {
                let entry = if inherited != nil && !this.SymbolIsWrittenBetween(
                    symbol,
                    inherited,
                    use,
                    conditional.Condition
                ) &&
                    !this.ClosureAssignedLocalLosesNarrowing(symbol, inherited, use, conditional.Condition) {
                    inherited
                } else {
                    default(SyntaxNode?)
                }
                let thenProof = this.GetGSharpAssignmentNarrowingProof(
                    conditional.Statement,
                    symbol,
                    use,
                    $scope,
                    if this.IsNonNullCheckOf(conditional.Condition, symbol) {
                        conditional.Condition
                    } else {
                        entry
                    },
                    requireRuntimeNonNullProof
                )
                let elseEntry = if this.IsNullCheckOf(conditional.Condition, symbol) {
                    cast[SyntaxNode](conditional.Condition)
                } else {
                    entry
                }
                let elseProof = if conditional.Else == nil {
                    elseEntry
                } else {
                    this.GetGSharpAssignmentNarrowingProof(
                        conditional.Else!!.Statement,
                        symbol,
                        use,
                        $scope,
                        elseEntry,
                        requireRuntimeNonNullProof
                    )
                }
                let thenExits = AlwaysExitsViaReturnOrThrow(conditional.Statement)
                let elseExits = conditional.Else != nil && AlwaysExitsViaReturnOrThrow(conditional.Else!!.Statement)
                return if (thenProof != nil || thenExits) &&
                    (elseProof != nil || elseExits) &&
                    (thenProof == nil || !this.JumpBypassesAssignmentNarrowing(symbol, thenProof, use, $scope)) &&
                    (elseProof == nil || !this.JumpBypassesAssignmentNarrowing(symbol, elseProof, use, $scope)) &&
                    !(thenExits && elseExits) {
                    cast[SyntaxNode](conditional)
                } else {
                    default(SyntaxNode?)
                }
            }
            let assignment = switch statement {
                case expressionStatement is ExpressionStatementSyntax: expressionStatement.Expression as AssignmentExpressionSyntax
                case assigned is AssignmentExpressionSyntax: assigned
                default: default(AssignmentExpressionSyntax?)
            }
            if assignment != nil &&
                (
                assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) || assignment.IsKind(
                    SyntaxKind.CoalesceAssignmentExpression
                )
            ) {
                if this.BindsTo(assignment.Left, symbol) {
                    if assignment.IsKind(SyntaxKind.CoalesceAssignmentExpression) &&
                        inherited != nil &&
                        this.AssignmentNarrowingSurvivesToRead(
                        symbol,
                        inherited,
                        assignment.Left,
                        assignment.Left,
                        $scope
                    ) &&
                        !this
                        .AssignmentRegionInvalidatesNarrowing(
                        symbol,
                        assignment.Right,
                        assignment.Right.SpanStart,
                        assignment.Right.Span.End
                    ) {
                        return statement
                    }
                    let coalescing = assignment.IsKind(SyntaxKind.CoalesceAssignmentExpression)
                    let staticProof = if coalescing {
                        this.CoalesceAssignmentResultIsStaticallyNonNull(assignment)
                    } else {
                        !this.AssignmentHasNullableTargetTypedRhs(assignment) && this.GSharpAssignmentRhsProvesNonNull(
                            assignment.Right,
                            allowPlatform: true
                        )
                    }
                    let value ExpressionSyntax = if coalescing {
                        assignment
                    } else {
                        assignment.Right
                    }
                    return if staticProof &&
                        (!requireRuntimeNonNullProof || this.GSharpValueHasRuntimeNonNullProof(value)) {
                        cast[SyntaxNode](statement)
                    } else {
                        default(SyntaxNode?)
                    }
                }
                if assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) &&
                    Unparenthesize(assignment.Right) is AssignmentExpressionSyntax nested {
                    let entry = if inherited != nil && !this.AssignmentRegionInvalidatesNarrowing(
                        symbol,
                        assignment.Left,
                        assignment.Left.SpanStart,
                        assignment.Left.Span.End
                    ) {
                        inherited
                    } else {
                        default(SyntaxNode?)
                    }
                    let proof = this.GetGSharpAssignmentNarrowingProof(
                        nested,
                        symbol,
                        use,
                        $scope,
                        entry,
                        requireRuntimeNonNullProof
                    )
                    return if proof != nil && this.AssignmentNarrowingSurvivesToRead(
                        symbol,
                        proof,
                        use,
                        use,
                        statement
                    ) {
                        cast[SyntaxNode](statement)
                    } else {
                        default(SyntaxNode?)
                    }
                }
            }
            // Reuse guard invalidation for writes, escaped closures, by-reference storage and enclosing filters.
            return if inherited != nil && this.AssignmentNarrowingSurvivesToRead(
                symbol,
                inherited,
                use,
                use,
                statement
            ) {
                inherited
            } else {
                default(SyntaxNode?)
            }
        }

        private func AssignmentNarrowingSurvivesToRead(
            symbol ISymbol,
            proof SyntaxNode,
            use ExpressionSyntax,
            effectiveTarget SyntaxNode,
            $scope SyntaxNode
        ) bool {
            if this.SymbolIsWrittenBetween(symbol, proof, effectiveTarget, $scope) ||
                this.ClosureAssignedLocalLosesNarrowing(symbol, proof, use, $scope) || this.HasLoopCarriedWrite(
                use,
                symbol,
                $scope,
                proof
            ) {
                return false
            }
            for loop in proof.Ancestors().OfType[ForStatementSyntax]() {
                if !loop.Initializers.Any((initializer ExpressionSyntax) -> initializer.Span.Contains(proof.Span)) ||
                    !loop
                    .Span
                    .Contains(effectiveTarget.Span) {
                    continue
                }
                // A for-initializer runs once. It cannot restore a fact removed at the loop's region entry.
                if this.AssignmentRegionInvalidatesNarrowing(
                    symbol,
                    loop,
                    loop.Initializers.Last().Span.End,
                    loop.Span.End
                ) {
                    return false
                }
            }
            return !this.JumpBypassesAssignmentNarrowing(symbol, proof, effectiveTarget, $scope)
        }

        private func JumpBypassesAssignmentNarrowing(
            symbol ISymbol,
            proof SyntaxNode,
            use SyntaxNode,
            $scope SyntaxNode
        ) bool {
            // A jump can bypass the proof or return to a read after another iteration changed the variable.
            let index = this.GetScopeGotoIndex($scope)
            for entry in index.Jumps {
                if entry.Target is {} target &&
                    target.SpanStart >= proof
                    .Span
                    .End &&
                    target.SpanStart <= use
                    .SpanStart {
                    if entry.Jump.SpanStart < proof.SpanStart {
                        return true
                    }
                    if entry
                        .Jump
                        .SpanStart > use.SpanStart &&
                        index.BackwardSpan is {} span &&
                        this.AssignmentRegionInvalidatesNarrowing(symbol, $scope, span.Start, span.End) {
                        return true
                    }
                }
            }
            return false
        }

        private func AssignmentRegionInvalidatesNarrowing(
            symbol ISymbol,
            $scope SyntaxNode,
            start int32,
            end int32
        ) bool {
            let closureAssigned = this.IsClosureAssignedVariable(symbol)
            let byReference = this.IsByReferenceVariable(symbol)
            return $scope.DescendantNodesAndSelf(
                (node SyntaxNode) -> !this.IsClosureBoundary(node) && !this.IsDroppedStatementOrLoopClause(node)
            )
                .Any(
                (node SyntaxNode) -> node.SpanStart >= start &&
                    node
                    .Span
                    .End <= end &&
                    (
                    this.SyntaxNodeWritesSymbol(node, symbol) ||
                        (closureAssigned && this.NodeMayRunEscapedClosure(node)) ||
                        (
                        byReference &&
                            (this.NodeRunsStaticTypeInitializer(node) || this.NodeMayWriteReferenceStorage(node))
                    )
                )
            )
        }

        // Chained stores complete conversions, setters, and reference-storage effects after their inner assignment.
        private func AssignmentStoreCompletesAfterProof(
            node SyntaxNode,
            proof SyntaxNode,
            includeReferenceStorageWrites bool = false
        ) bool ->
        node is AssignmentExpressionSyntax assignment &&
            assignment
            .Right
            .Span
            .Contains(proof.Span) &&
            (
            this
                .context
                .GetSymbolInfo(assignment.Left)
                .Symbol is IPropertySymbol ||
                this
                .context
                .SemanticModel
                .GetConversion(assignment.Right)
                .IsUserDefined ||
                this.NodeRunsStaticTypeInitializer(assignment.Left) ||
                (includeReferenceStorageWrites && this.NodeMayWriteReferenceStorage(assignment))
        )

        private func AssignmentHasNullableTargetTypedRhs(assignment AssignmentExpressionSyntax) bool {
            if !assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) {
                return false
            }
            if assignment.Right is not ConditionalExpressionSyntax && assignment.Right is not SwitchExpressionSyntax {
                return false
            }
            let target = this.context.GetSymbolInfo(assignment.Left).Symbol
            let type = this.GetAssignmentTargetType(assignment.Left, target)
            // gsc target-types bare conditionals and switches, but binds parenthesized values without the assignment target.
            return type?.NullableAnnotation == NullableAnnotation.Annotated || this.IsTranslatorWidenedDeclaration(
                target
            ) ||
                this.PatternLocalUsesNullableStorage(assignment.Left)
        }

        private func GSharpAssignmentRhsProvesNonNull(
            value ExpressionSyntax,
            allowPlatform bool,
            recoverNullableArms bool = false
        ) bool {
            if this.context.SemanticModel.GetConversion(value).IsUserDefined {
                return false
            }
            if this.GSharpValueHasNonNullType(value, allowPlatform) || this.GSharpNestedAssignmentProvesNonNull(value) {
                return true
            }
            // gsc's RhsArmsProveNonNil recovers coalescing postconditions, not plain assignment result types.
            let operands = if recoverNullableArms {
                this.ComposedValueOperands(
                    Unparenthesize(value) ?? value,
                    includeConvertedNonNullCoalesceAssignment: true
                )
            } else {
                default(List[ExpressionSyntax]?)
            }
            return operands != nil && operands.Count > 0 && operands.All(
                (operand ExpressionSyntax) -> this.GSharpAssignmentRhsProvesNonNull(
                    operand,
                    allowPlatform: false,
                    recoverNullableArms: true
                )
            )
        }

        private func GSharpNestedAssignmentProvesNonNull(value ExpressionSyntax) bool {
            if Unparenthesize(value) is not AssignmentExpressionSyntax assigned || !assigned.IsKind(
                SyntaxKind.SimpleAssignmentExpression
            ) ||
                this.AssignmentHasNullableTargetTypedRhs(assigned) {
                return false
            }
            let target = this.context.GetSymbolInfo(assigned.Left).Symbol
            // Match gsc's BoundAssignmentExpression and source BoundFieldAssignmentExpression recovery.
            let recoverable = target is ILocalSymbol or
                IParameterSymbol ||
                (
                target is IFieldSymbol field && this.IsSourceSymbol(field) && field.ContainingType?.IsTupleType != true
            )
            return recoverable && this.GSharpAssignmentRhsProvesNonNull(assigned.Right, allowPlatform: false)
        }

        private func GSharpValueHasNonNullType(value ExpressionSyntax, allowPlatform bool) bool {
            let unwrapped = Unparenthesize(value) ?? value
            // gsc classifies the RHS type before an implicit user conversion, not the operator's return contract.
            if this.context.SemanticModel.GetConversion(value).IsUserDefined {
                return false
            }
            if unwrapped is AssignmentExpressionSyntax assigned && assigned.IsKind(
                SyntaxKind.SimpleAssignmentExpression
            ) {
                return this.AssignmentResultHasNonNullStaticType(assigned) ||
                    (allowPlatform && this.ReadsPlatformTypedImportTopLevel(assigned.Left))
            }
            if unwrapped is AssignmentExpressionSyntax coalescing && coalescing.IsKind(
                SyntaxKind.CoalesceAssignmentExpression
            ) {
                return this.CoalesceAssignmentResultIsStaticallyNonNull(coalescing)
            }
            if unwrapped is PostfixUnaryExpressionSyntax suppression && suppression.IsKind(
                SyntaxKind.SuppressNullableWarningExpression
            ) {
                let (targetType, targetSymbol) = this.FindNullForgivingTarget(suppression)
                // A nullable sink erases C#'s suppression. It does not emit the runtime check that could narrow G#.
                return if this.NullForgivingTargetAcceptsNil(targetType, targetSymbol) ||
                    this
                    .GSharpExpressionIsStaticallyNonNull(suppression.Operand) {
                    this.GSharpValueHasNonNullType(suppression.Operand, allowPlatform)
                } else {
                    this.GSharpExpressionIsStaticallyNonNull(suppression)
                }
            }
            if unwrapped is BinaryExpressionSyntax coalesce && coalesce.IsKind(SyntaxKind.CoalesceExpression) {
                // A platform fallback gives `??` a bare result, unless a literal nil selects that fallback directly.
                return this.GSharpValueHasNonNullType(
                    coalesce.Right,
                    allowPlatform || !IsNullOrSuppressedNull(coalesce.Left)
                )
            }
            if this.ComposedValueOperands(unwrapped) is {} operands {
                return operands.Count > 0 && operands.All(
                    (operand ExpressionSyntax) -> this.GSharpValueHasNonNullType(operand, allowPlatform)
                )
            }
            return this.GSharpExpressionIsStaticallyNonNull(unwrapped) ||
                (allowPlatform && this.ReadsPlatformTypedImportTopLevel(unwrapped))
        }

        private func GSharpValueHasRuntimeNonNullProof(value ExpressionSyntax) bool {
            let unwrapped = Unparenthesize(value) ?? value
            if this.context.SemanticModel.GetConversion(value).IsUserDefined {
                return false
            }
            if unwrapped is AssignmentExpressionSyntax assigned {
                return (
                    assigned.IsKind(SyntaxKind.CoalesceAssignmentExpression) && this.GSharpValueHasRuntimeNonNullProof(
                        assigned.Left
                    )
                ) ||
                    this.GSharpValueHasRuntimeNonNullProof(assigned.Right)
            }
            if unwrapped is BinaryExpressionSyntax coalesce && coalesce.IsKind(SyntaxKind.CoalesceExpression) {
                return this.GSharpValueHasRuntimeNonNullProof(coalesce.Left) || this.GSharpValueHasRuntimeNonNullProof(
                    coalesce.Right
                )
            }
            if unwrapped is PostfixUnaryExpressionSyntax suppression && suppression.IsKind(
                SyntaxKind.SuppressNullableWarningExpression
            ) {
                let (targetType, targetSymbol) = this.FindNullForgivingTarget(suppression)
                return if this.NullForgivingTargetAcceptsNil(targetType, targetSymbol) ||
                    this
                    .GSharpExpressionIsStaticallyNonNull(suppression.Operand) {
                    this.GSharpValueHasRuntimeNonNullProof(suppression.Operand)
                } else {
                    !IsNullOrSuppressedNull(suppression.Operand)
                }
            }
            if this.ComposedValueOperands(unwrapped, includeConvertedNonNullCoalesceAssignment: true) is {} operands {
                return operands.Count > 0 && operands.All(
                    (operand ExpressionSyntax) -> this.GSharpValueHasRuntimeNonNullProof(operand)
                )
            }
            if this.context.GetTypeInfo(unwrapped).Type is {IsValueType: true} type && IsNonNullableValueType(type) {
                return true
            }
            // A non-null contract or checked reference cast can still return nil. Conditional indexing must test it.
            return (
                unwrapped is LiteralExpressionSyntax && !IsNullOrSuppressedNull(unwrapped) && !unwrapped.IsKind(
                    SyntaxKind.DefaultLiteralExpression
                )
            ) ||
                unwrapped is ObjectCreationExpressionSyntax ||
                unwrapped is ImplicitObjectCreationExpressionSyntax ||
                unwrapped is ArrayCreationExpressionSyntax ||
                unwrapped is ImplicitArrayCreationExpressionSyntax ||
                unwrapped is AnonymousObjectCreationExpressionSyntax ||
                unwrapped is InterpolatedStringExpressionSyntax ||
                unwrapped is TypeOfExpressionSyntax ||
                unwrapped is ThrowExpressionSyntax ||
                this.IsGSharpFlowNarrowedLocal(
                unwrapped,
                requireRoslynFlowNotNull: false,
                requireRuntimeNonNullProof: true
            )
        }
    }
}
