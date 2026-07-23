// <copyright file="AsyncIteratorMoveNextBodyBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable CS1591
#pragma warning disable SA1028
#pragma warning disable SA1116
#pragma warning disable SA1117
#pragma warning disable SA1611
#pragma warning disable SA1615

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Lowering.Iterators;

/// <summary>
/// Builds the <c>MoveNext()</c> body for an async iterator state machine.
/// Handles both yield (state assignment + SetResult(true) on promise + return)
/// and await (suspension via AwaitOnCompleted, resume via state dispatch).
/// </summary>
public static class AsyncIteratorMoveNextBodyBuilder
{
    /// <summary>
    /// Builds the MoveNext body for an async iterator.
    /// </summary>
    public static BoundBlockStatement Build(
        AsyncIteratorPlan plan,
        StructSymbol smClass,
        ParameterSymbol thisParameter,
        FieldSymbol stateField,
        FieldSymbol currentField,
        FieldSymbol promiseField,
        FieldSymbol disposeModeField,
        FieldSymbol disposeExceptionField,
        FieldSymbol builderField,
        Dictionary<VariableSymbol, FieldSymbol> fieldMap,
        Dictionary<Type, FieldSymbol> awaiterPoolFields)
    {
        var ctx = new BuildContext(
            plan, smClass, thisParameter, stateField, currentField,
            promiseField, disposeModeField, disposeExceptionField,
            builderField, fieldMap, awaiterPoolFields);
        return ctx.BuildBody();
    }

    private sealed class BuildContext
    {
        private readonly AsyncIteratorPlan plan;
        private readonly StructSymbol smClass;
        private readonly ParameterSymbol thisParameter;
        private readonly FieldSymbol stateField;
        private readonly FieldSymbol currentField;
        private readonly FieldSymbol promiseField;
        private readonly FieldSymbol disposeModeField;
        private readonly FieldSymbol disposeExceptionField;
        private readonly FieldSymbol builderField;
        private readonly Dictionary<VariableSymbol, FieldSymbol> fieldMap;
        private readonly Dictionary<Type, FieldSymbol> awaiterPoolFields;
        private readonly TryDispatchPlan awaitTryDispatch;
        private readonly IteratorTryDispatchPlan yieldTryDispatch;

        // Labels for yield resume points
        private readonly Dictionary<int, BoundLabel> yieldResumeLabels = new();

        // Labels for await resume points
        private readonly Dictionary<int, BoundLabel> awaitResumeLabels = new();
        private readonly Dictionary<int, BoundLabel> awaitResumeAfterLabels = new();

        private readonly BoundLabel exitLabel = new BoundLabel("<>ai_exit");
        private readonly BoundLabel endOfBodyLabel = new BoundLabel("<>ai_end");

        public BuildContext(
            AsyncIteratorPlan plan,
            StructSymbol smClass,
            ParameterSymbol thisParameter,
            FieldSymbol stateField,
            FieldSymbol currentField,
            FieldSymbol promiseField,
            FieldSymbol disposeModeField,
            FieldSymbol disposeExceptionField,
            FieldSymbol builderField,
            Dictionary<VariableSymbol, FieldSymbol> fieldMap,
            Dictionary<Type, FieldSymbol> awaiterPoolFields)
        {
            this.plan = plan;
            this.smClass = smClass;
            this.thisParameter = thisParameter;
            this.stateField = stateField;
            this.currentField = currentField;
            this.promiseField = promiseField;
            this.disposeModeField = disposeModeField;
            this.disposeExceptionField = disposeExceptionField;
            this.builderField = builderField;
            this.fieldMap = fieldMap;
            this.awaiterPoolFields = awaiterPoolFields;

            // Create resume labels for awaits (non-negative states).
            var awaitResumeMap = new Dictionary<BoundAwaitExpression, AwaitResumePoint>();
            foreach (var kvp in plan.AwaitStates.OrderBy(p => p.Value))
            {
                awaitResumeLabels[kvp.Value] = new BoundLabel($"<>ai_awaitResume_{kvp.Value}");
                awaitResumeAfterLabels[kvp.Value] = new BoundLabel($"<>ai_awaitAfter_{kvp.Value}");
                awaitResumeMap[kvp.Key] = new AwaitResumePoint(
                    kvp.Key,
                    kvp.Value,
                    awaitResumeLabels[kvp.Value],
                    awaitResumeAfterLabels[kvp.Value]);
            }

            awaitTryDispatch = TryDispatchPlanner.Plan(plan.LoweredBody, awaitResumeMap);
            yieldTryDispatch = IteratorTryDispatchPlanner.Plan(plan.LoweredBody, plan.YieldStates);

            foreach (var kvp in plan.YieldStates.OrderBy(p => p.Value))
            {
                yieldResumeLabels[kvp.Value] = yieldTryDispatch.GetResumeLabel(kvp.Value)
                    ?? new BoundLabel($"<>ai_yieldResume_{kvp.Value}");
            }
        }

        public BoundBlockStatement BuildBody()
        {
            var stmts = ImmutableArray.CreateBuilder<BoundStatement>();

            // try {
            //   state dispatch
            //   user body (with yield + await rewritten)
            //   end: state = -2; promise.SetResult(false);
            // } catch (Exception ex) {
            //   state = -2; promise.SetException(ex);
            // }
            var tryBody = BuildTryBody();

            var exLocal = new LocalVariableSymbol("<>ex", isReadOnly: false, TypeSymbol.FromClrType(typeof(Exception)));
            var catchBody = BuildCatchBody(exLocal);

            var catchClause = new BoundCatchClause(TypeSymbol.FromClrType(typeof(Exception)), exLocal, catchBody);
            var tryStmt = new BoundTryStatement(null, tryBody, ImmutableArray.Create(catchClause), finallyBlock: null);
            stmts.Add(tryStmt);

            // return; (after try/catch)
            stmts.Add(new BoundReturnStatement(null, null));

            return IteratorProtectedRegionBranchRewriter.Rewrite(
                new BoundBlockStatement(null, stmts.ToImmutable()));
        }

        private BoundBlockStatement BuildTryBody()
        {
            var stmts = ImmutableArray.CreateBuilder<BoundStatement>();

            // State dispatch: check state and jump to resume labels.
            EmitStateDispatch(stmts);

            stmts.Add(new BoundConditionalGotoStatement(
                null,
                endOfBodyLabel,
                ReadField(disposeModeField),
                jumpIfTrue: true));

            // Rewritten user body.
            var rewriter = new InnerRewriter(this);
            var rewrittenBody = rewriter.RewriteStatement(plan.LoweredBody);
            if (rewrittenBody is BoundBlockStatement block)
            {
                stmts.AddRange(block.Statements);
            }
            else
            {
                stmts.Add(rewrittenBody);
            }

            // End of body: state = -2; promise.SetResult(false);
            stmts.Add(new BoundLabelStatement(null, endOfBodyLabel));
            stmts.Add(Stmt(WriteField(stateField, Literal(StateMachineStates.FinishedState))));
            stmts.Add(Stmt(EmitPromiseSetResult(false)));

            // Exit label (for suspension return paths).
            stmts.Add(new BoundLabelStatement(null, exitLabel));

            return new BoundBlockStatement(null, stmts.ToImmutable());
        }

        private void EmitStateDispatch(ImmutableArray<BoundStatement>.Builder stmts)
        {
            var stateRead = ReadField(stateField);

            // For each yield resume state (negative): if state == K goto yieldResumeK
            foreach (var kvp in plan.YieldStates.OrderBy(p => p.Value))
            {
                var state = kvp.Value;
                stmts.Add(new BoundConditionalGotoStatement(
                    null,
                    yieldTryDispatch.GetOuterDispatchTarget(state) ?? yieldResumeLabels[state],
                    new BoundBinaryExpression(
                        null,
                        stateRead,
                        BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                        Literal(state)),
                    jumpIfTrue: true));
            }

            // For each await resume state (non-negative): if state == K goto awaitResumeK
            foreach (var kvp in plan.AwaitStates.OrderBy(p => p.Value))
            {
                var state = kvp.Value;
                stmts.Add(new BoundConditionalGotoStatement(
                    null,
                    awaitTryDispatch.GetOuterDispatchTarget(state) ?? awaitResumeLabels[state],
                    new BoundBinaryExpression(
                        null,
                        ReadField(stateField),
                        BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                        Literal(state)),
                    jumpIfTrue: true));
            }
        }

        private BoundBlockStatement BuildCatchBody(LocalVariableSymbol exLocal)
        {
            var stmts = ImmutableArray.CreateBuilder<BoundStatement>();

            // state = -2;
            stmts.Add(Stmt(WriteField(stateField, Literal(StateMachineStates.FinishedState))));

            var exceptionType = TypeSymbol.FromClrType(typeof(Exception));
            var isDisposeException = new BoundBinaryExpression(
                null,
                new BoundVariableExpression(null, exLocal),
                BoundBinaryOperator.MakeReferenceEquality(
                    SyntaxKind.EqualsEqualsToken,
                    exceptionType,
                    exceptionType),
                ReadField(disposeExceptionField));
            var completingDispose = new BoundBinaryExpression(
                null,
                ReadField(disposeModeField),
                BoundBinaryOperator.Bind(
                    SyntaxKind.AmpersandAmpersandToken,
                    TypeSymbol.Bool,
                    TypeSymbol.Bool),
                isDisposeException);

            var promiseFieldType = typeof(System.Threading.Tasks.Sources.ManualResetValueTaskSourceCore<bool>);
            var setExceptionMethod = promiseFieldType.GetMethod("SetException", new[] { typeof(Exception) });
            var promiseAddr = new BoundAddressOfExpression(
                null,
                new BoundFieldAccessExpression(null, new BoundVariableExpression(null, thisParameter), smClass, promiseField));
            var call = new BoundImportedInstanceCallExpression(
                null,
                promiseAddr,
                setExceptionMethod,
                TypeSymbol.Void,
                ImmutableArray.Create<BoundExpression>(new BoundVariableExpression(null, exLocal)));
            stmts.Add(new BoundIfStatement(
                null,
                completingDispose,
                Stmt(EmitPromiseSetResult(false)),
                Stmt(call)));

            return new BoundBlockStatement(null, stmts.ToImmutable());
        }

        private BoundExpression EmitPromiseSetResult(bool value)
        {
            var promiseFieldType = typeof(System.Threading.Tasks.Sources.ManualResetValueTaskSourceCore<bool>);
            var setResultMethod = promiseFieldType.GetMethod("SetResult", new[] { typeof(bool) });
            var promiseAddr = new BoundAddressOfExpression(
                null,
                new BoundFieldAccessExpression(null, new BoundVariableExpression(null, thisParameter), smClass, promiseField));
            return new BoundImportedInstanceCallExpression(
                null,
                promiseAddr,
                setResultMethod,
                TypeSymbol.Void,
                ImmutableArray.Create<BoundExpression>(new BoundLiteralExpression(null, value)));
        }

        private BoundExpression ReadField(FieldSymbol field)
        {
            return new BoundFieldAccessExpression(null, new BoundVariableExpression(null, thisParameter), smClass, field);
        }

        private BoundExpression WriteField(FieldSymbol field, BoundExpression value)
        {
            return new BoundFieldAssignmentExpression(null, thisParameter, smClass, field, value);
        }

        private static BoundExpression Literal(int value) => new BoundLiteralExpression(null, value);

        private static BoundExpressionStatement Stmt(BoundExpression expr) => new BoundExpressionStatement(null, expr);

        /// <summary>
        /// Walks the user body, replacing yields, awaits, variable accesses (hoisted to fields),
        /// and returns.
        /// </summary>
        private sealed class InnerRewriter : HoistedFieldRewriter
        {
            private readonly BuildContext ctx;
            private int yieldIndex;

            public InnerRewriter(BuildContext ctx)
                : base(ctx.smClass, ctx.thisParameter, ctx.fieldMap)
            {
                this.ctx = ctx;
            }

            protected override BoundStatement RewriteVariableDeclaration(BoundVariableDeclaration node)
            {
                if (node.Initializer is BoundAwaitExpression awaitExpr)
                {
                    return EmitPerAwaitSequence(awaitExpr, node.Variable);
                }

                var rewrittenInit = node.Initializer != null ? RewriteExpression(node.Initializer) : null;
                if (ctx.fieldMap.TryGetValue(node.Variable, out var field))
                {
                    if (rewrittenInit != null)
                    {
                        return Stmt(ctx.WriteField(field, rewrittenInit));
                    }

                    return new BoundBlockStatement(null, ImmutableArray<BoundStatement>.Empty);
                }

                if (rewrittenInit != node.Initializer)
                {
                    return new BoundVariableDeclaration(null, node.Variable, rewrittenInit);
                }

                return node;
            }

            protected override BoundStatement RewriteYieldStatement(BoundYieldStatement node)
            {
                yieldIndex++;
                var yieldState = ctx.plan.YieldStates.Values.OrderBy(v => v).Reverse().ElementAt(yieldIndex - 1);

                // Find the matching BoundYieldStatement in the plan.
                BoundYieldStatement matchedYield = null;
                foreach (var kvp in ctx.plan.YieldStates)
                {
                    if (kvp.Value == yieldState && ReferenceEquals(kvp.Key, node))
                    {
                        matchedYield = kvp.Key;
                        break;
                    }
                }

                // Fallback: use ordered iteration matching.
                if (matchedYield == null)
                {
                    int idx = 0;
                    foreach (var kvp in ctx.plan.YieldStates.OrderBy(kv => kv.Value).Reverse())
                    {
                        idx++;
                        if (idx == yieldIndex)
                        {
                            yieldState = kvp.Value;
                            break;
                        }
                    }
                }

                var stmts = ImmutableArray.CreateBuilder<BoundStatement>();
                var rewrittenExpr = RewriteExpression(node.Expression);

                // this.<>2__current = expr;
                stmts.Add(Stmt(ctx.WriteField(ctx.currentField, rewrittenExpr)));

                // this.<>1__state = yieldState;
                stmts.Add(Stmt(ctx.WriteField(ctx.stateField, Literal(yieldState))));

                // this.<>v__promiseOfValueOrEnd.SetResult(true);
                stmts.Add(Stmt(ctx.EmitPromiseSetResult(true)));

                // return;
                stmts.Add(new BoundGotoStatement(null, ctx.exitLabel));

                // yieldResumeK:
                stmts.Add(new BoundLabelStatement(null, ctx.yieldResumeLabels[yieldState]));

                // this.<>1__state = -1;
                stmts.Add(Stmt(ctx.WriteField(ctx.stateField, Literal(StateMachineStates.NotStartedOrRunningState))));

                var disposeException = new BoundClrConstructorCallExpression(
                    null,
                    typeof(Exception),
                    typeof(Exception).GetConstructor(Type.EmptyTypes),
                    ImmutableArray<BoundExpression>.Empty,
                    TypeSymbol.FromClrType(typeof(Exception)));
                var throwDispose = new BoundBlockStatement(
                    null,
                    ImmutableArray.Create<BoundStatement>(
                        Stmt(ctx.WriteField(ctx.disposeExceptionField, disposeException)),
                        new BoundThrowStatement(null, ctx.ReadField(ctx.disposeExceptionField))));
                stmts.Add(new BoundIfStatement(
                    null,
                    ctx.ReadField(ctx.disposeModeField),
                    throwDispose,
                    elseStatement: null));

                return new BoundBlockStatement(null, stmts.ToImmutable());
            }

            protected override BoundStatement RewriteExpressionStatement(BoundExpressionStatement node)
            {
                if (node.Expression is BoundAwaitExpression awaitExpr)
                {
                    return EmitPerAwaitSequence(awaitExpr, resultTarget: null);
                }

                if (node.Expression is BoundAssignmentExpression assign && assign.Expression is BoundAwaitExpression assignAwait)
                {
                    return EmitPerAwaitSequence(assignAwait, resultTarget: assign.Variable);
                }

                return base.RewriteExpressionStatement(node);
            }

            protected override BoundStatement RewriteTryStatement(BoundTryStatement node)
            {
                // Issue #2662: the newly exposed await-for awaits and yields
                // can resume inside protected regions. Route them through the
                // same outside-entry/inside-dispatch topology as ordinary
                // async methods and synchronous iterators.
                var result = (BoundTryStatement)base.RewriteTryStatement(node);
                var awaitEntries = ctx.awaitTryDispatch.GetInternalDispatchEntries(node);
                var yieldEntries = ctx.yieldTryDispatch.GetInternalDispatchEntries(node);
                var awaitEntryLabel = ctx.awaitTryDispatch.GetEntryLabel(node);
                var yieldEntryLabel = ctx.yieldTryDispatch.GetEntryLabel(node);

                if (awaitEntries.IsDefaultOrEmpty
                    && yieldEntries.IsDefaultOrEmpty
                    && awaitEntryLabel == null
                    && yieldEntryLabel == null)
                {
                    return result;
                }

                var tryStatements = ImmutableArray.CreateBuilder<BoundStatement>();
                foreach (var entry in awaitEntries)
                {
                    tryStatements.Add(DispatchTo(entry.State, entry.Target));
                }

                foreach (var entry in yieldEntries)
                {
                    tryStatements.Add(DispatchTo(entry.State, entry.Target));
                }

                if (result.TryBlock is BoundBlockStatement block)
                {
                    tryStatements.AddRange(block.Statements);
                }
                else
                {
                    tryStatements.Add(result.TryBlock);
                }

                var rebuilt = new BoundTryStatement(
                    null,
                    new BoundBlockStatement(null, tryStatements.ToImmutable()),
                    result.CatchClauses,
                    GuardFinally(result.FinallyBlock, awaitEntries, yieldEntries));

                if (awaitEntryLabel == null && yieldEntryLabel == null)
                {
                    return rebuilt;
                }

                var statements = ImmutableArray.CreateBuilder<BoundStatement>();
                if (awaitEntryLabel != null)
                {
                    statements.Add(new BoundLabelStatement(null, awaitEntryLabel));
                }

                if (yieldEntryLabel != null && !ReferenceEquals(yieldEntryLabel, awaitEntryLabel))
                {
                    statements.Add(new BoundLabelStatement(null, yieldEntryLabel));
                }

                statements.Add(rebuilt);
                return new BoundBlockStatement(null, statements.ToImmutable());
            }

            protected override BoundExpression RewriteAwaitExpression(BoundAwaitExpression node)
            {
                // If we reach here, await is nested. Should have been lifted by spiller.
                return node;
            }

            protected override BoundStatement RewriteReturnStatement(BoundReturnStatement node)
            {
                // In an async iterator, `return` means end iteration.
                return new BoundGotoStatement(null, ctx.endOfBodyLabel);
            }

            private BoundStatement GuardFinally(
                BoundStatement finallyBlock,
                ImmutableArray<TryDispatchEntry> awaitEntries,
                ImmutableArray<IteratorTryDispatchEntry> yieldEntries)
            {
                if (finallyBlock == null)
                {
                    return null;
                }

                BoundExpression suspended = null;
                foreach (var entry in awaitEntries)
                {
                    suspended = AddSuspendedState(suspended, entry.State);
                }

                foreach (var entry in yieldEntries)
                {
                    suspended = AddSuspendedState(suspended, entry.State);
                }

                if (suspended == null)
                {
                    return finallyBlock;
                }

                var notSuspended = new BoundUnaryExpression(
                    null,
                    BoundUnaryOperator.Bind(SyntaxKind.BangToken, TypeSymbol.Bool),
                    suspended);
                return new BoundBlockStatement(
                    null,
                    ImmutableArray.Create<BoundStatement>(
                        new BoundIfStatement(null, notSuspended, finallyBlock, elseStatement: null)));
            }

            private BoundExpression AddSuspendedState(BoundExpression condition, int state)
            {
                var equalsState = new BoundBinaryExpression(
                    null,
                    ctx.ReadField(ctx.stateField),
                    BoundBinaryOperator.Bind(
                        SyntaxKind.EqualsEqualsToken,
                        TypeSymbol.Int32,
                        TypeSymbol.Int32),
                    Literal(state));
                return condition == null
                    ? equalsState
                    : new BoundBinaryExpression(
                        null,
                        condition,
                        BoundBinaryOperator.Bind(
                            SyntaxKind.PipePipeToken,
                            TypeSymbol.Bool,
                            TypeSymbol.Bool),
                        equalsState);
            }

            private BoundConditionalGotoStatement DispatchTo(int state, BoundLabel target)
            {
                var condition = new BoundBinaryExpression(
                    null,
                    ctx.ReadField(ctx.stateField),
                    BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                    Literal(state));
                return new BoundConditionalGotoStatement(null, target, condition, jumpIfTrue: true);
            }

            private BoundBlockStatement EmitPerAwaitSequence(BoundAwaitExpression awaitExpr, VariableSymbol resultTarget)
            {
                if (!ctx.plan.AwaitStates.TryGetValue(awaitExpr, out var awaitState))
                {
                    throw new InvalidOperationException("Await expression has no assigned state.");
                }

                var shape = AwaitableShape.Resolve(awaitExpr.Expression?.Type?.ClrType);
                if (shape == null)
                {
                    throw new InvalidOperationException(
                        $"Cannot resolve awaitable shape for type '{awaitExpr.Expression?.Type?.Name}'.");
                }

                var awaiterClrType = shape.AwaiterType;
                var awaiterTypeSymbol = TypeSymbol.FromClrType(awaiterClrType);

                // Get the pooled awaiter field.
                var poolKey = awaiterClrType.IsValueType ? awaiterClrType : typeof(object);
                if (!ctx.awaiterPoolFields.TryGetValue(poolKey, out var awaiterField))
                {
                    throw new InvalidOperationException($"No awaiter pool field for type '{awaiterClrType.FullName}'.");
                }

                var resumeLabel = ctx.awaitResumeLabels[awaitState];
                var resumeAfterLabel = ctx.awaitResumeAfterLabels[awaitState];

                var stmts = ImmutableArray.CreateBuilder<BoundStatement>();

                // TAwaiter awaiter = <expr>.GetAwaiter();
                var rewrittenOperand = RewriteExpression(awaitExpr.Expression);
                BoundExpression getAwaiterReceiver;
                var awaitableClrType = awaitExpr.Expression?.Type?.ClrType;
                if (awaitableClrType != null && awaitableClrType.IsValueType)
                {
                    var awaitableTypeSymbol = TypeSymbol.FromClrType(awaitableClrType);
                    var tempLocal = new LocalVariableSymbol(
                        "<>awaitable_" + awaitState, isReadOnly: false, awaitableTypeSymbol);
                    stmts.Add(new BoundVariableDeclaration(null, tempLocal, rewrittenOperand));
                    getAwaiterReceiver = new BoundAddressOfExpression(null, new BoundVariableExpression(null, tempLocal));
                }
                else
                {
                    getAwaiterReceiver = rewrittenOperand;
                }

                var getAwaiterCall = new BoundImportedInstanceCallExpression(
                    null,
                    getAwaiterReceiver,
                    shape.GetAwaiterMethod,
                    awaiterTypeSymbol,
                    ImmutableArray<BoundExpression>.Empty);

                var awaiterLocal = new LocalVariableSymbol(
                    "<>awaiter_" + awaitState, isReadOnly: false, awaiterTypeSymbol);
                stmts.Add(new BoundVariableDeclaration(null, awaiterLocal, getAwaiterCall));

                // if (awaiter.IsCompleted) goto resumeAfter;
                var isCompletedGetter = shape.IsCompletedProperty.GetGetMethod();
                BoundExpression isCompletedReceiver;
                if (awaiterClrType.IsValueType)
                {
                    isCompletedReceiver = new BoundAddressOfExpression(null, new BoundVariableExpression(null, awaiterLocal));
                }
                else
                {
                    isCompletedReceiver = new BoundVariableExpression(null, awaiterLocal);
                }

                var isCompletedCall = new BoundImportedInstanceCallExpression(
                    null,
                    isCompletedReceiver,
                    isCompletedGetter,
                    TypeSymbol.Bool,
                    ImmutableArray<BoundExpression>.Empty);
                stmts.Add(new BoundConditionalGotoStatement(null, resumeAfterLabel, isCompletedCall, jumpIfTrue: true));

                // === Suspension path ===
                // [AwaitYieldPoint] — hidden sequence point marker before state save.
                stmts.Add(new BoundAwaitSequencePoint(null, BoundNodeKind.AwaitYieldPoint, awaitState));

                // this.<>1__state = awaitState;
                stmts.Add(Stmt(ctx.WriteField(ctx.stateField, Literal(awaitState))));

                // this.<>u__N = awaiter;
                stmts.Add(Stmt(ctx.WriteField(awaiterField, new BoundVariableExpression(null, awaiterLocal))));

                // builder.AwaitUnsafe/OnCompleted(ref awaiter, ref this);
                var awaitOnCompletedMarker = new BoundStateMachineAwaitOnCompleted(
                    null,
                    awaiterLocal,
                    awaiterClrType,
                    TypeSymbol.FromClrType(awaiterClrType),
                    shape.ImplementsCriticalNotifyCompletion);
                stmts.Add(Stmt(awaitOnCompletedMarker));

                // goto exit;
                stmts.Add(new BoundGotoStatement(null, ctx.exitLabel));

                // resumeLabel:
                stmts.Add(new BoundLabelStatement(null, resumeLabel));

                // [AwaitResumePoint] — hidden sequence point marker after resume dispatch.
                stmts.Add(new BoundAwaitSequencePoint(null, BoundNodeKind.AwaitResumePoint, awaitState));

                // awaiter = this.<>u__N;
                BoundExpression reloadedAwaiter = ctx.ReadField(awaiterField);
                if (!awaiterClrType.IsValueType)
                {
                    reloadedAwaiter = new BoundConversionExpression(null, awaiterTypeSymbol, reloadedAwaiter);
                }

                stmts.Add(Stmt(new BoundAssignmentExpression(null, awaiterLocal, reloadedAwaiter)));

                // this.<>u__N = default;
                stmts.Add(Stmt(ctx.WriteField(awaiterField, new BoundDefaultExpression(null, awaiterTypeSymbol))));

                // this.<>1__state = -1;
                stmts.Add(Stmt(ctx.WriteField(ctx.stateField, Literal(StateMachineStates.NotStartedOrRunningState))));

                // resumeAfterLabel:
                stmts.Add(new BoundLabelStatement(null, resumeAfterLabel));

                // result = awaiter.GetResult();
                BoundExpression getResultReceiver;
                if (awaiterClrType.IsValueType)
                {
                    getResultReceiver = new BoundAddressOfExpression(null, new BoundVariableExpression(null, awaiterLocal));
                }
                else
                {
                    getResultReceiver = new BoundVariableExpression(null, awaiterLocal);
                }

                var resultType = awaitExpr.Type ?? TypeSymbol.Void;
                var getResultCall = new BoundImportedInstanceCallExpression(
                    null,
                    getResultReceiver,
                    shape.GetResultMethod,
                    resultType,
                    ImmutableArray<BoundExpression>.Empty);

                bool hasResult = resultType != TypeSymbol.Void && !resultType.ClrType.IsSameAs(typeof(void));

                if (resultTarget != null && hasResult)
                {
                    if (ctx.fieldMap.TryGetValue(resultTarget, out var targetField))
                    {
                        stmts.Add(Stmt(ctx.WriteField(targetField, getResultCall)));
                    }
                    else
                    {
                        stmts.Add(new BoundVariableDeclaration(null, resultTarget, getResultCall));
                    }
                }
                else
                {
                    stmts.Add(Stmt(getResultCall));
                }

                return new BoundBlockStatement(null, stmts.ToImmutable());
            }
        }
    }
}
