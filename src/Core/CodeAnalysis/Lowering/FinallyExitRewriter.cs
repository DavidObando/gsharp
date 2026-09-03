// <copyright file="FinallyExitRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Lowering;

/// <summary>
/// Lifts a finally body out of its CLR handler when it contains a branch that
/// exits the handler. CLR forbids <c>leave</c> from finally, so exits from the
/// protected body are funneled through the lifted body and dispatched after it.
/// </summary>
internal static class FinallyExitRewriter
{
    /// <summary>Rewrites finally handlers that contain escaping branches.</summary>
    /// <param name="body">The lowered function body.</param>
    /// <returns>The rewritten body.</returns>
    public static BoundBlockStatement Rewrite(BoundBlockStatement body)
        => (BoundBlockStatement)new Rewriter().RewriteStatement(body);

    private readonly struct DispatchArm
    {
        public DispatchArm(int discriminator, BoundLabel target)
        {
            Discriminator = discriminator;
            Target = target;
        }

        public int Discriminator { get; }

        public BoundLabel Target { get; }
    }

    private sealed class ExitPlan
    {
        private readonly Dictionary<BoundLabel, int> discriminators = [];
        private readonly List<DispatchArm> arms = [];
        private int nextDiscriminator = 1;

        public ExitPlan(int ordinal)
        {
            PendingBranch = new LocalVariableSymbol(
                $"<>finally_branch_{ordinal}",
                isReadOnly: false,
                TypeSymbol.Int32);
            TailLabel = new BoundLabel($"<>finally_tail_{ordinal}");
        }

        public LocalVariableSymbol PendingBranch { get; }

        public BoundLabel TailLabel { get; }

        public IReadOnlyList<DispatchArm> Arms => arms;

        public int GetDiscriminator(BoundLabel target)
        {
            if (!discriminators.TryGetValue(target, out var discriminator))
            {
                discriminator = nextDiscriminator++;
                discriminators[target] = discriminator;
                arms.Add(new DispatchArm(discriminator, target));
            }

            return discriminator;
        }
    }

    private sealed class ExitFunneler : BoundTreeRewriter
    {
        private readonly ExitPlan plan;
        private readonly ProtectedRegionBranchAnalysis branches;
        private int skipOrdinal;

        public ExitFunneler(ExitPlan plan, ProtectedRegionBranchAnalysis branches)
        {
            this.plan = plan;
            this.branches = branches;
        }

        protected override BoundStatement RewriteGotoStatement(BoundGotoStatement node)
        {
            if (branches.ContainsLabel(node.Label))
            {
                return node;
            }

            return new BoundBlockStatement(
                null,
                ImmutableArray.Create<BoundStatement>(
                    AssignBranch(plan.GetDiscriminator(node.Label)),
                    new BoundGotoStatement(null, plan.TailLabel)));
        }

        protected override BoundStatement RewriteConditionalGotoStatement(BoundConditionalGotoStatement node)
        {
            if (branches.ContainsLabel(node.Label))
            {
                return node;
            }

            var skip = new BoundLabel("<>finally_exit_skip_" + skipOrdinal++);
            return new BoundBlockStatement(
                null,
                ImmutableArray.Create<BoundStatement>(
                    new BoundConditionalGotoStatement(
                        null,
                        skip,
                        node.Condition,
                        jumpIfTrue: !node.JumpIfTrue),
                    AssignBranch(plan.GetDiscriminator(node.Label)),
                    new BoundGotoStatement(null, plan.TailLabel),
                    new BoundLabelStatement(null, skip)));
        }

        private BoundStatement AssignBranch(int discriminator)
            => new BoundExpressionStatement(
                null,
                new BoundAssignmentExpression(
                    null,
                    plan.PendingBranch,
                    new BoundLiteralExpression(null, discriminator)));
    }

    private sealed class Rewriter : BoundTreeRewriter
    {
        private int ordinal;

        protected override BoundStatement RewriteTryStatement(BoundTryStatement node)
        {
            var rewritten = (BoundTryStatement)base.RewriteTryStatement(node);
            if (rewritten.FinallyBlock == null)
            {
                return rewritten;
            }

            var finallyBranches = ProtectedRegionBranchAnalysis.Create(rewritten.FinallyBlock);
            if (!finallyBranches.HasEscapingBranch)
            {
                return rewritten;
            }

            var currentOrdinal = ordinal++;
            var plan = new ExitPlan(currentOrdinal);
            BoundLabel NewLabel() => new($"<>finally_skip_{currentOrdinal}_{ordinal++}");

            var tryBody = new ExitFunneler(
                plan,
                ProtectedRegionBranchAnalysis.Create(rewritten.TryBlock)).RewriteStatement(rewritten.TryBlock);
            var catches = ImmutableArray.CreateBuilder<BoundCatchClause>(rewritten.CatchClauses.Length);
            foreach (var clause in rewritten.CatchClauses)
            {
                var catchBody = new ExitFunneler(
                    plan,
                    ProtectedRegionBranchAnalysis.Create(clause.Body)).RewriteStatement(clause.Body);
                catches.Add(clause.WithBody(catchBody));
            }

            var exceptionType = TypeSymbol.FromClrType(typeof(Exception));
            var pendingException = new LocalVariableSymbol(
                $"<>finally_exception_{currentOrdinal}",
                isReadOnly: false,
                NullableTypeSymbol.Get(exceptionType));
            var catchVariable = new LocalVariableSymbol(
                $"<>finally_catch_{currentOrdinal}",
                isReadOnly: true,
                exceptionType);
            var captureException = new BoundExpressionStatement(
                null,
                new BoundAssignmentExpression(
                    null,
                    pendingException,
                    new BoundVariableExpression(null, catchVariable)));

            var innerStatement = catches.Count == 0
                ? tryBody
                : new BoundTryStatement(null, tryBody, catches.ToImmutable(), finallyBlock: null);
            var exceptionCaptureTry = new BoundTryStatement(
                null,
                new BoundBlockStatement(null, ImmutableArray.Create(innerStatement)),
                ImmutableArray.Create(
                    new BoundCatchClause(
                        exceptionType,
                        catchVariable,
                        new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(captureException)))),
                finallyBlock: null);

            var statements = ImmutableArray.CreateBuilder<BoundStatement>();
            statements.Add(new BoundVariableDeclaration(
                null,
                plan.PendingBranch,
                new BoundLiteralExpression(null, 0)));
            statements.Add(new BoundVariableDeclaration(
                null,
                pendingException,
                new BoundLiteralExpression(null, null, TypeSymbol.Null)));
            statements.Add(exceptionCaptureTry);
            statements.Add(new BoundLabelStatement(null, plan.TailLabel));
            AddStatements(statements, rewritten.FinallyBlock);

            var rethrowEnd = NewLabel();
            statements.Add(new BoundConditionalGotoStatement(
                null,
                rethrowEnd,
                new BoundBinaryExpression(
                    null,
                    new BoundVariableExpression(null, pendingException),
                    Invariant.Required(
                        BoundBinaryOperator.Bind(
                            SyntaxKind.EqualsEqualsToken,
                            pendingException.Type,
                            TypeSymbol.Null),
                        "pending exception locals support nil equality"),
                    new BoundLiteralExpression(null, null, TypeSymbol.Null)),
                jumpIfTrue: true));
            statements.Add(BuildExceptionDispatchThrow(
                new BoundVariableExpression(null, pendingException)));
            statements.Add(new BoundLabelStatement(null, rethrowEnd));

            foreach (var arm in plan.Arms)
            {
                var skip = NewLabel();
                statements.Add(new BoundConditionalGotoStatement(
                    null,
                    skip,
                    new BoundBinaryExpression(
                        null,
                        new BoundVariableExpression(null, plan.PendingBranch),
                        Invariant.Required(
                            BoundBinaryOperator.Bind(
                                SyntaxKind.EqualsEqualsToken,
                                TypeSymbol.Int32,
                                TypeSymbol.Int32),
                            "int32 equality operator exists for finally dispatch"),
                        new BoundLiteralExpression(null, arm.Discriminator)),
                    jumpIfTrue: false));
                statements.Add(new BoundGotoStatement(null, arm.Target));
                statements.Add(new BoundLabelStatement(null, skip));
            }

            return new BoundBlockStatement(null, statements.ToImmutable());
        }

        private static void AddStatements(
            ImmutableArray<BoundStatement>.Builder statements,
            BoundStatement statement)
        {
            if (statement is BoundBlockStatement block)
            {
                statements.AddRange(block.Statements);
            }
            else
            {
                statements.Add(statement);
            }
        }

        private static BoundStatement BuildExceptionDispatchThrow(BoundExpression exception)
        {
            var ediType = typeof(System.Runtime.ExceptionServices.ExceptionDispatchInfo);
            var captureMethod = Invariant.Required(
                ediType.GetMethod(
                    nameof(System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture),
                    new[] { typeof(Exception) }),
                "ExceptionDispatchInfo.Capture(Exception) is looked up on the host runtime's own type, not on the target framework's references");
            var throwMethod = Invariant.Required(
                ediType.GetMethod(
                    nameof(System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw),
                    Type.EmptyTypes),
                "ExceptionDispatchInfo.Throw() is looked up on the host runtime's own type, not on the target framework's references");
            var ediClass = new ImportedClassSymbol(ediType, declaration: null);
            var captureFunction = new ImportedFunctionSymbol(
                captureMethod.Name,
                ediClass,
                captureMethod,
                declaration: null);
            var captureCall = new BoundImportedCallExpression(
                null,
                captureFunction,
                ImmutableArray.Create(exception));
            return new BoundExpressionStatement(
                null,
                new BoundImportedInstanceCallExpression(
                    null,
                    captureCall,
                    throwMethod,
                    TypeSymbol.Void,
                    ImmutableArray<BoundExpression>.Empty));
        }
    }
}
