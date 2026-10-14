// <copyright file="FinallyExitRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Runtime.ExceptionServices

/// Lifts a finally body out of its CLR handler when it contains a branch that
/// exits the handler. CLR forbids `leave` from finally, so exits from the
/// protected body are funneled through the lifted body and dispatched after it.
internal shared class FinallyExitRewriter {
    private struct DispatchArm {
        init(discriminator int32, target BoundLabel) {
            Discriminator = discriminator
            Target = target
        }

        prop Discriminator int32 {
            get;
        }

        prop Target BoundLabel {
            get;
        }
    }

    private class ExitPlan {
        private let discriminators Dictionary[BoundLabel, int32] = Dictionary[BoundLabel, int32]()
        private let arms List[FinallyExitRewriter.DispatchArm] = List[FinallyExitRewriter.DispatchArm]()
        private var nextDiscriminator int32 = 1

        init(ordinal int32) {
            PendingBranch = LocalVariableSymbol("<>finally_branch_$ordinal", isReadOnly: false, TypeSymbol.Int32)
            TailLabel = BoundLabel("<>finally_tail_$ordinal")
        }

        prop PendingBranch LocalVariableSymbol {
            get;
        }

        prop TailLabel BoundLabel {
            get;
        }

        prop Arms IReadOnlyList[FinallyExitRewriter.DispatchArm] -> arms

        func GetDiscriminator(target BoundLabel) int32 {
            if !discriminators.TryGetValue(target, out var discriminator) {
                discriminator = nextDiscriminator
                nextDiscriminator++
                discriminators[target] = discriminator
                arms.Add(FinallyExitRewriter.DispatchArm(discriminator, target))
            }
            return discriminator
        }
    }

    private class ExitFunneler : BoundTreeRewriter {
        private let plan ExitPlan
        private let branches ProtectedRegionBranchAnalysis
        private var skipOrdinal int32

        init(plan ExitPlan, branches ProtectedRegionBranchAnalysis) {
            this.plan = plan
            this.branches = branches
        }

        protected override func RewriteGotoStatement(node BoundGotoStatement) BoundStatement {
            if branches.ContainsLabel(node.Label) {
                return node
            }
            return BoundBlockStatement(
                nil,
                ImmutableArray.Create[BoundStatement](
                    AssignBranch(plan.GetDiscriminator(node.Label)),
                    BoundGotoStatement(nil, plan.TailLabel)
                )
            )
        }

        protected override func RewriteConditionalGotoStatement(node BoundConditionalGotoStatement) BoundStatement {
            if branches.ContainsLabel(node.Label) {
                return node
            }
            let skip = BoundLabel("<>finally_exit_skip_" + skipOrdinal++.ToString())
            return BoundBlockStatement(
                nil,
                ImmutableArray.Create[BoundStatement](
                    BoundConditionalGotoStatement(nil, skip, node.Condition, jumpIfTrue: !node.JumpIfTrue),
                    AssignBranch(plan.GetDiscriminator(node.Label)),
                    BoundGotoStatement(nil, plan.TailLabel),
                    BoundLabelStatement(nil, skip)
                )
            )
        }

        private func AssignBranch(discriminator int32) BoundStatement -> BoundExpressionStatement(
            nil,
            BoundAssignmentExpression(nil, plan.PendingBranch, BoundLiteralExpression(nil, discriminator))
        )
    }

    private class Rewriter : BoundTreeRewriter {
        private var ordinal int32

        protected override func RewriteTryStatement(node BoundTryStatement) BoundStatement {
            let rewritten = cast[BoundTryStatement](base.RewriteTryStatement(node))
            if rewritten.FinallyBlock == nil {
                return rewritten
            }
            let finallyBranches = ProtectedRegionBranchAnalysis.Create(rewritten.FinallyBlock)
            if !finallyBranches.HasEscapingBranch {
                return rewritten
            }
            let currentOrdinal = ordinal++
            let plan = ExitPlan(currentOrdinal)
            let NewLabel = func () BoundLabel {
                return BoundLabel("<>finally_skip_${currentOrdinal}_${ordinal++}")
            }
            let tryBody = FinallyExitRewriter.ExitFunneler(
                plan,
                ProtectedRegionBranchAnalysis.Create(rewritten.TryBlock)
            )
                .RewriteStatement(rewritten.TryBlock)
            let catches = ImmutableArray.CreateBuilder[BoundCatchClause](rewritten.CatchClauses.Length)
            for clause in rewritten.CatchClauses {
                let catchBody = FinallyExitRewriter.ExitFunneler(
                    plan,
                    ProtectedRegionBranchAnalysis.Create(clause.Body)
                )
                    .RewriteStatement(clause.Body)
                catches.Add(clause.WithBody(catchBody))
            }
            let exceptionType = TypeSymbol.FromClrTypeWithoutNullability(
                typeof(Exception),
                NullabilityFreeReason.TypeLiteral
            )
            let pendingException = LocalVariableSymbol(
                "<>finally_exception_$currentOrdinal",
                isReadOnly: false,
                NullableTypeSymbol.Get(exceptionType)
            )
            let catchVariable = LocalVariableSymbol("<>finally_catch_$currentOrdinal", isReadOnly: true, exceptionType)
            let captureException = BoundExpressionStatement(
                nil,
                BoundAssignmentExpression(nil, pendingException, BoundVariableExpression(nil, catchVariable))
            )
            let innerStatement = if catches.Count == 0 {
                tryBody
            } else {
                cast[BoundStatement](BoundTryStatement(nil, tryBody, catches.ToImmutable(), finallyBlock: nil))
            }
            let exceptionCaptureTry = BoundTryStatement(
                nil,
                BoundBlockStatement(nil, ImmutableArray.Create(innerStatement)),
                ImmutableArray.Create(
                    BoundCatchClause(
                        exceptionType,
                        catchVariable,
                        BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](captureException))
                    )
                ),
                finallyBlock: nil
            )
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            statements.Add(BoundVariableDeclaration(nil, plan.PendingBranch, BoundLiteralExpression(nil, 0)))
            statements.Add(
                BoundVariableDeclaration(nil, pendingException, BoundLiteralExpression(nil, nil, TypeSymbol.Null))
            )
            statements.Add(exceptionCaptureTry)
            statements.Add(BoundLabelStatement(nil, plan.TailLabel))
            AddStatements(statements, rewritten.FinallyBlock!!)
            let rethrowEnd = NewLabel()
            statements.Add(
                BoundConditionalGotoStatement(
                    nil,
                    rethrowEnd,
                    BoundBinaryExpression(
                        nil,
                        BoundVariableExpression(nil, pendingException),
                        Invariant.Required(
                            BoundBinaryOperator.Bind(
                                SyntaxKind.EqualsEqualsToken,
                                pendingException.Type,
                                TypeSymbol.Null
                            ),
                            "pending exception locals support nil equality",
                            expression: `BoundBinaryOperator.Bind(
                            SyntaxKind.EqualsEqualsToken,
                            pendingException.Type,
                            TypeSymbol.Null)`
                        ),
                        BoundLiteralExpression(nil, nil, TypeSymbol.Null)
                    ),
                    jumpIfTrue: true
                )
            )
            statements.Add(BuildExceptionDispatchThrow(BoundVariableExpression(nil, pendingException)))
            statements.Add(BoundLabelStatement(nil, rethrowEnd))
            for arm in plan.Arms {
                let skip = NewLabel()
                statements.Add(
                    BoundConditionalGotoStatement(
                        nil,
                        skip,
                        BoundBinaryExpression(
                            nil,
                            BoundVariableExpression(nil, plan.PendingBranch),
                            Invariant.Required(
                                BoundBinaryOperator.Bind(
                                    SyntaxKind.EqualsEqualsToken,
                                    TypeSymbol.Int32,
                                    TypeSymbol.Int32
                                ),
                                "int32 equality operator exists for finally dispatch",
                                expression: `BoundBinaryOperator.Bind(
                                SyntaxKind.EqualsEqualsToken,
                                TypeSymbol.Int32,
                                TypeSymbol.Int32)`
                            ),
                            BoundLiteralExpression(nil, arm.Discriminator)
                        ),
                        jumpIfTrue: false
                    )
                )
                statements.Add(BoundGotoStatement(nil, arm.Target))
                statements.Add(BoundLabelStatement(nil, skip))
            }
            return BoundBlockStatement(nil, statements.ToImmutable())
        }

        shared {
            private func AddStatements(statements ImmutableArray[BoundStatement].Builder, statement BoundStatement) {
                if statement is BoundBlockStatement block {
                    statements.AddRange(block.Statements)
                } else {
                    statements.Add(statement)
                }
            }

            private func BuildExceptionDispatchThrow(exception BoundExpression) BoundStatement {
                let ediType = typeof(ExceptionDispatchInfo)
                let captureMethod = Invariant.Required(
                    ediType.GetMethod("Capture", []Type{typeof(Exception)}),
                    "ExceptionDispatchInfo.Capture(Exception) is looked up on the host runtime's own type, not on the target framework's references",
                    expression: `ediType.GetMethod(
                    nameof(System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture),
                    new[] { typeof(Exception) })`
                )
                let throwMethod = Invariant.Required(
                    ediType.GetMethod("Throw", Type.EmptyTypes),
                    "ExceptionDispatchInfo.Throw() is looked up on the host runtime's own type, not on the target framework's references",
                    expression: `ediType.GetMethod(
                    nameof(System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw),
                    Type.EmptyTypes)`
                )
                let ediClass = ImportedClassSymbol(ediType, declaration: nil)
                let captureFunction = ImportedFunctionSymbol(
                    captureMethod.Name,
                    ediClass,
                    captureMethod,
                    declaration: nil
                )
                let captureCall = BoundImportedCallExpression(nil, captureFunction, ImmutableArray.Create(exception))
                return BoundExpressionStatement(
                    nil,
                    BoundImportedInstanceCallExpression(
                        nil,
                        captureCall,
                        throwMethod,
                        TypeSymbol.Void,
                        ImmutableArray[BoundExpression].Empty
                    )
                )
            }
        }
    }

    /// Rewrites finally handlers that contain escaping branches.
    /// @param body The lowered function body.
    /// @returns The rewritten body.
    func Rewrite(body BoundBlockStatement) BoundBlockStatement -> cast[BoundBlockStatement](
        FinallyExitRewriter.Rewriter().RewriteStatement(body)
    )
}
