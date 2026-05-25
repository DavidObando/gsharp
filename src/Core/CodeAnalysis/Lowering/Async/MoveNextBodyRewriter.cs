// <copyright file="MoveNextBodyRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Rewrites the lowered user body into the canonical <c>MoveNext</c> skeleton
/// (spec §6). Replaces every <see cref="BoundAwaitExpression"/> with the §6.4
/// per-await suspension sequence, replaces <c>return</c> statements with the
/// §6.5 funneled form, and rewrites hoisted locals/parameters to field accesses
/// on the state-machine struct.
/// </summary>
/// <remarks>
/// The output is a <see cref="BoundBlockStatement"/> that the existing
/// <c>BodyEmitter</c> in <c>ReflectionMetadataEmitter</c> can lower directly
/// to IL. No <see cref="BoundAwaitExpression"/> nodes survive. The only
/// synthesized node type that requires special emitter support is
/// <see cref="BoundStateMachineAwaitOnCompleted"/>, which carries the data
/// needed to emit the <c>AwaitOnCompleted</c>/<c>AwaitUnsafeOnCompleted</c>
/// MethodSpec against the synthesized state-machine TypeDef.
/// </remarks>
public static class MoveNextBodyRewriter
{
    /// <summary>
    /// Builds the full MoveNext body for the given async state-machine plan.
    /// </summary>
    /// <param name="plan">The async state machine plan.</param>
    /// <returns>The rewritten MoveNext body as a <see cref="BoundBlockStatement"/>.</returns>
    public static MoveNextBody Build(AsyncStateMachinePlan plan)
    {
        if (plan == null)
        {
            throw new ArgumentNullException(nameof(plan));
        }

        var ctx = new RewriteContext(plan);
        return ctx.BuildBody();
    }

    /// <summary>
    /// Result of building the MoveNext body. Contains the body plus metadata
    /// needed by the emitter (e.g., the locals that need IL slots).
    /// </summary>
    public sealed class MoveNextBody
    {
        /// <summary>Initializes a new instance of the <see cref="MoveNextBody"/> class.</summary>
        /// <param name="body">The rewritten MoveNext block statement.</param>
        /// <param name="locals">All locals declared in the body that need IL slots.</param>
        /// <param name="thisParameter">The synthesized parameter representing <c>this</c> (arg0).</param>
        public MoveNextBody(BoundBlockStatement body, ImmutableArray<LocalVariableSymbol> locals, ParameterSymbol thisParameter)
        {
            Body = body;
            Locals = locals;
            ThisParameter = thisParameter;
        }

        /// <summary>Gets the rewritten MoveNext block statement.</summary>
        public BoundBlockStatement Body { get; }

        /// <summary>Gets all locals declared in the body that need IL slots.</summary>
        public ImmutableArray<LocalVariableSymbol> Locals { get; }

        /// <summary>Gets the synthesized parameter representing <c>this</c> (arg0).</summary>
        public ParameterSymbol ThisParameter { get; }
    }

    private sealed class RewriteContext
    {
        private readonly AsyncStateMachinePlan plan;
        private readonly ParameterSymbol thisParameter;
        private readonly StructSymbol structType;
        private readonly Dictionary<BoundAwaitExpression, AwaitResumePoint> awaitResumeMap;
        private readonly LocalVariableSymbol cachedStateLocal;
        private readonly LocalVariableSymbol retValLocal;
        private readonly List<LocalVariableSymbol> allLocals = new List<LocalVariableSymbol>();

        public RewriteContext(AsyncStateMachinePlan plan)
        {
            this.plan = plan;
            this.structType = plan.FieldMap.StructType;

            // MoveNext's `this` is arg0 (managed pointer to the struct).
            this.thisParameter = new ParameterSymbol("<>sm_this", plan.FieldMap.StructType);

            this.awaitResumeMap = new Dictionary<BoundAwaitExpression, AwaitResumePoint>();
            foreach (var rp in plan.MoveNextPlan.AwaitResumePoints)
            {
                this.awaitResumeMap[rp.AwaitExpression] = rp;
            }

            this.cachedStateLocal = new LocalVariableSymbol("<>cachedState", isReadOnly: false, TypeSymbol.Int);
            allLocals.Add(cachedStateLocal);

            var builderInfo = plan.StateMachine.BuilderInfo;
            if (builderInfo.ResultType != null && builderInfo.ResultType != typeof(void))
            {
                this.retValLocal = new LocalVariableSymbol(
                    "<>retVal", isReadOnly: false, TypeSymbol.FromClrType(builderInfo.ResultType));
                allLocals.Add(retValLocal);
            }
        }

        public MoveNextBody BuildBody()
        {
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();

            // int cachedState = this.<>1__state;
            statements.Add(new BoundVariableDeclaration(cachedStateLocal, ReadField(plan.FieldMap.StateField)));

            // T retVal = default; (only for Task<T>)
            if (retValLocal != null)
            {
                var defaultVal = retValLocal.Type == TypeSymbol.Int
                    ? (BoundExpression)new BoundLiteralExpression(0)
                    : retValLocal.Type == TypeSymbol.Bool
                        ? new BoundLiteralExpression(false)
                        : new BoundLiteralExpression(null);
                statements.Add(new BoundVariableDeclaration(retValLocal, defaultVal));
            }

            // Build the try-body: state dispatch + user body + SetResult path.
            // Everything that targets exprReturnLabel must be INSIDE the try
            // because br cannot leave a protected region.
            var tryBodyStatements = ImmutableArray.CreateBuilder<BoundStatement>();
            EmitStateDispatch(tryBodyStatements);

            // Rewritten user body.
            var rewriter = new InnerRewriter(this);
            var rewrittenBody = rewriter.RewriteStatement(plan.LoweredBody);
            if (rewrittenBody is BoundBlockStatement block)
            {
                tryBodyStatements.AddRange(block.Statements);
            }
            else
            {
                tryBodyStatements.Add(rewrittenBody);
            }

            // exprReturnLabel: (inside try — target of return-funneling gotos)
            tryBodyStatements.Add(new BoundLabelStatement(plan.MoveNextPlan.ExpressionReturnLabel));

            // this.<>1__state = -2;
            tryBodyStatements.Add(Stmt(WriteField(plan.FieldMap.StateField, Literal(StateMachineStates.FinishedState))));

            // this.<>t__builder.SetResult([retVal]);
            tryBodyStatements.Add(Stmt(EmitBuilderSetResult()));

            // exitLabel: (inside try — suspension paths jump here to leave)
            tryBodyStatements.Add(new BoundLabelStatement(plan.MoveNextPlan.ExitLabel));

            var tryBody = new BoundBlockStatement(tryBodyStatements.ToImmutable());

            // catch (Exception ex) { this.<>1__state = -2; builder.SetException(ex); }
            var exLocal = new LocalVariableSymbol("<>ex", isReadOnly: false, TypeSymbol.FromClrType(typeof(Exception)));
            allLocals.Add(exLocal);
            var catchBody = BuildCatchBody(exLocal);
            var catchClause = new BoundCatchClause(TypeSymbol.FromClrType(typeof(Exception)), exLocal, catchBody);
            var tryStatement = new BoundTryStatement(tryBody, ImmutableArray.Create(catchClause), finallyBlock: null);
            statements.Add(tryStatement);

            // return; (after try/catch — reached via leave from both paths)
            statements.Add(new BoundReturnStatement(null));

            return new MoveNextBody(
                new BoundBlockStatement(statements.ToImmutable()),
                allLocals.ToImmutableArray(),
                thisParameter);
        }

        private void EmitStateDispatch(ImmutableArray<BoundStatement>.Builder statements)
        {
            statements.Add(new BoundLabelStatement(plan.MoveNextPlan.DispatchLabel));

            if (plan.MoveNextPlan.AwaitResumePoints.IsEmpty)
            {
                return;
            }

            foreach (var rp in plan.MoveNextPlan.AwaitResumePoints)
            {
                var condition = new BoundBinaryExpression(
                    new BoundVariableExpression(cachedStateLocal),
                    BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int, TypeSymbol.Int),
                    Literal(rp.State));
                statements.Add(new BoundConditionalGotoStatement(rp.ResumeLabel, condition, jumpIfTrue: true));
            }
        }

        private BoundBlockStatement BuildCatchBody(LocalVariableSymbol exLocal)
        {
            var stmts = ImmutableArray.CreateBuilder<BoundStatement>();

            // this.<>1__state = -2;
            stmts.Add(Stmt(WriteField(plan.FieldMap.StateField, Literal(StateMachineStates.FinishedState))));

            // this.<>t__builder.SetException(ex);
            var builderInfo = plan.StateMachine.BuilderInfo;
            var builderAccess = new BoundFieldAccessExpression(
                new BoundVariableExpression(thisParameter), structType, plan.FieldMap.BuilderField);
            var builderAddr = new BoundAddressOfExpression(builderAccess);
            var setExceptionCall = new BoundImportedInstanceCallExpression(
                builderAddr,
                builderInfo.SetExceptionMethod,
                TypeSymbol.Void,
                ImmutableArray.Create<BoundExpression>(new BoundVariableExpression(exLocal)));
            stmts.Add(Stmt(setExceptionCall));

            return new BoundBlockStatement(stmts.ToImmutable());
        }

        private BoundExpression EmitBuilderSetResult()
        {
            var builderInfo = plan.StateMachine.BuilderInfo;
            var builderAccess = new BoundFieldAccessExpression(
                new BoundVariableExpression(thisParameter), structType, plan.FieldMap.BuilderField);
            var builderAddr = new BoundAddressOfExpression(builderAccess);

            ImmutableArray<BoundExpression> args;
            if (retValLocal != null)
            {
                args = ImmutableArray.Create<BoundExpression>(new BoundVariableExpression(retValLocal));
            }
            else
            {
                args = ImmutableArray<BoundExpression>.Empty;
            }

            return new BoundImportedInstanceCallExpression(
                builderAddr,
                builderInfo.SetResultMethod,
                TypeSymbol.Void,
                args);
        }

        private BoundExpression ReadField(FieldSymbol field)
        {
            return new BoundFieldAccessExpression(
                new BoundVariableExpression(thisParameter), structType, field);
        }

        private BoundExpression WriteField(FieldSymbol field, BoundExpression value)
        {
            return new BoundFieldAssignmentExpression(thisParameter, structType, field, value);
        }

        private static BoundExpression Literal(int value)
        {
            return new BoundLiteralExpression(value);
        }

        private static BoundExpressionStatement Stmt(BoundExpression expr)
        {
            return new BoundExpressionStatement(expr);
        }

        /// <summary>
        /// Walks the user body, replacing awaits, returns, and hoisted locals.
        /// </summary>
        private sealed class InnerRewriter : BoundTreeRewriter
        {
            private readonly RewriteContext ctx;

            public InnerRewriter(RewriteContext ctx)
            {
                this.ctx = ctx;
            }

            protected override BoundStatement RewriteReturnStatement(BoundReturnStatement node)
            {
                var stmts = ImmutableArray.CreateBuilder<BoundStatement>();

                if (node.Expression != null && ctx.retValLocal != null)
                {
                    var rewrittenExpr = RewriteExpression(node.Expression);
                    stmts.Add(new BoundExpressionStatement(
                        new BoundAssignmentExpression(ctx.retValLocal, rewrittenExpr)));
                }

                stmts.Add(new BoundGotoStatement(ctx.plan.MoveNextPlan.ExpressionReturnLabel));
                return new BoundBlockStatement(stmts.ToImmutable());
            }

            protected override BoundStatement RewriteExpressionStatement(BoundExpressionStatement node)
            {
                if (node.Expression is BoundAwaitExpression awaitExpr)
                {
                    return EmitPerAwaitSequence(awaitExpr, resultTarget: null);
                }

                // Check if the expression is an assignment whose RHS is an await.
                if (node.Expression is BoundAssignmentExpression assign && assign.Expression is BoundAwaitExpression assignAwait)
                {
                    return EmitPerAwaitSequence(assignAwait, resultTarget: assign.Variable);
                }

                return base.RewriteExpressionStatement(node);
            }

            protected override BoundStatement RewriteVariableDeclaration(BoundVariableDeclaration node)
            {
                if (node.Initializer is BoundAwaitExpression awaitExpr)
                {
                    return EmitPerAwaitSequence(awaitExpr, resultTarget: node.Variable);
                }

                var rewrittenInit = node.Initializer != null ? RewriteExpression(node.Initializer) : null;

                if (TryGetHoistedField(node.Variable, out var field))
                {
                    if (rewrittenInit != null)
                    {
                        return Stmt(ctx.WriteField(field, rewrittenInit));
                    }

                    return new BoundBlockStatement(ImmutableArray<BoundStatement>.Empty);
                }

                if (rewrittenInit != node.Initializer)
                {
                    return new BoundVariableDeclaration(node.Variable, rewrittenInit);
                }

                return node;
            }

            protected override BoundExpression RewriteVariableExpression(BoundVariableExpression node)
            {
                if (TryGetHoistedField(node.Variable, out var field))
                {
                    return ctx.ReadField(field);
                }

                return node;
            }

            protected override BoundExpression RewriteAssignmentExpression(BoundAssignmentExpression node)
            {
                var rewrittenValue = RewriteExpression(node.Expression);

                if (TryGetHoistedField(node.Variable, out var field))
                {
                    return ctx.WriteField(field, rewrittenValue);
                }

                if (rewrittenValue != node.Expression)
                {
                    return new BoundAssignmentExpression(node.Variable, rewrittenValue);
                }

                return node;
            }

            protected override BoundExpression RewriteFieldAssignmentExpression(BoundFieldAssignmentExpression node)
            {
                var rewrittenValue = RewriteExpression(node.Value);

                // If the receiver is the hoisted `this` (instance method on a closure),
                // we cannot represent a nested field store with the current node shape.
                // For read-only capture access this path won't be hit; defer full
                // write-through support for captured vars in async lambdas.
                if (rewrittenValue != node.Value)
                {
                    return new BoundFieldAssignmentExpression(node.Receiver, node.StructType, node.Field, rewrittenValue);
                }

                return node;
            }

            protected override BoundStatement RewriteTryStatement(BoundTryStatement node)
            {
                // The emitter stores the caught exception into a LOCAL slot via
                // EmitStoreVariable(clause.Variable). If the clause variable is
                // hoisted to a field (because it's referenced elsewhere in the
                // async body), the body's field-based reads would see the default
                // value (null) instead of the caught exception. Fix: inject a
                // local→field copy at the start of each catch body for hoisted
                // catch variables.
                var result = (BoundTryStatement)base.RewriteTryStatement(node);

                var needsPatch = false;
                foreach (var clause in result.CatchClauses)
                {
                    if (TryGetHoistedField(clause.Variable, out _))
                    {
                        needsPatch = true;
                        break;
                    }
                }

                if (!needsPatch)
                {
                    return result;
                }

                var newClauses = ImmutableArray.CreateBuilder<BoundCatchClause>();
                foreach (var clause in result.CatchClauses)
                {
                    if (TryGetHoistedField(clause.Variable, out var field))
                    {
                        // Prepend: this.<field> = clause.Variable (load from local slot)
                        var copyToField = Stmt(ctx.WriteField(
                            field,
                            new BoundVariableExpression(clause.Variable)));
                        var stmts = ImmutableArray.CreateBuilder<BoundStatement>();
                        stmts.Add(copyToField);
                        if (clause.Body is BoundBlockStatement block)
                        {
                            stmts.AddRange(block.Statements);
                        }
                        else
                        {
                            stmts.Add(clause.Body);
                        }

                        newClauses.Add(new BoundCatchClause(
                            clause.ExceptionType,
                            clause.Variable,
                            new BoundBlockStatement(stmts.ToImmutable())));
                    }
                    else
                    {
                        newClauses.Add(clause);
                    }
                }

                return new BoundTryStatement(
                    result.TryBlock,
                    newClauses.ToImmutable(),
                    result.FinallyBlock);
            }

            protected override BoundExpression RewriteAwaitExpression(BoundAwaitExpression node)
            {
                // If we reach here, the await is embedded as a sub-expression
                // in a context we haven't caught at the statement level. The
                // precheck should gate this, but as a safety net return the node.
                return node;
            }

            private BoundBlockStatement EmitPerAwaitSequence(BoundAwaitExpression awaitExpr, VariableSymbol resultTarget)
            {
                if (!ctx.awaitResumeMap.TryGetValue(awaitExpr, out var resumePoint))
                {
                    throw new InvalidOperationException("Await expression has no assigned resume state.");
                }

                var shape = AwaitableShape.Resolve(awaitExpr.Expression?.Type?.ClrType);
                if (shape == null)
                {
                    throw new InvalidOperationException(
                        $"Cannot resolve awaitable shape for type '{awaitExpr.Expression?.Type?.Name}'.");
                }

                var awaiterClrType = shape.AwaiterType;
                var awaiterTypeSymbol = TypeSymbol.FromClrType(awaiterClrType);
                var awaiterLocal = new LocalVariableSymbol(
                    "<>awaiter_" + resumePoint.State, isReadOnly: false, awaiterTypeSymbol);
                ctx.allLocals.Add(awaiterLocal);

                // Get the pooled awaiter field.
                var awaiterField = ctx.plan.StateMachine.GetAwaiterPoolField(awaiterClrType);
                if (awaiterField == null)
                {
                    throw new InvalidOperationException(
                        $"No awaiter pool field for type '{awaiterClrType.FullName}'.");
                }

                var stmts = ImmutableArray.CreateBuilder<BoundStatement>();

                // TAwaiter awaiter = <expr>.GetAwaiter();
                var rewrittenOperand = RewriteExpression(awaitExpr.Expression);
                BoundExpression getAwaiterReceiver;
                var awaitableClrType = awaitExpr.Expression?.Type?.ClrType;
                if (awaitableClrType != null && awaitableClrType.IsValueType)
                {
                    // Value-type awaitables require a managed pointer (byref) for the
                    // instance GetAwaiter() call. Spill to a temp local and take address.
                    var awaitableTypeSymbol = TypeSymbol.FromClrType(awaitableClrType);
                    var tempLocal = new LocalVariableSymbol(
                        "<>awaitable_" + resumePoint.State, isReadOnly: false, awaitableTypeSymbol);
                    ctx.allLocals.Add(tempLocal);
                    stmts.Add(new BoundVariableDeclaration(tempLocal, rewrittenOperand));
                    getAwaiterReceiver = new BoundAddressOfExpression(new BoundVariableExpression(tempLocal));
                }
                else
                {
                    getAwaiterReceiver = rewrittenOperand;
                }

                var getAwaiterCall = new BoundImportedInstanceCallExpression(
                    getAwaiterReceiver,
                    shape.GetAwaiterMethod,
                    awaiterTypeSymbol,
                    ImmutableArray<BoundExpression>.Empty);
                stmts.Add(new BoundVariableDeclaration(awaiterLocal, getAwaiterCall));

                // if (awaiter.IsCompleted) goto resumeAfter;
                var isCompletedGetter = shape.IsCompletedProperty.GetGetMethod();
                BoundExpression isCompletedReceiver;
                if (awaiterClrType.IsValueType)
                {
                    isCompletedReceiver = new BoundAddressOfExpression(new BoundVariableExpression(awaiterLocal));
                }
                else
                {
                    isCompletedReceiver = new BoundVariableExpression(awaiterLocal);
                }

                var isCompletedCall = new BoundImportedInstanceCallExpression(
                    isCompletedReceiver,
                    isCompletedGetter,
                    TypeSymbol.Bool,
                    ImmutableArray<BoundExpression>.Empty);
                stmts.Add(new BoundConditionalGotoStatement(
                    resumePoint.ResumeAfterLabel, isCompletedCall, jumpIfTrue: true));

                // === Suspension path ===
                // [AwaitYieldPoint] — hidden sequence point marker before state save.
                stmts.Add(new BoundAwaitSequencePoint(BoundNodeKind.AwaitYieldPoint, resumePoint.State));

                // this.<>1__state = K;
                stmts.Add(Stmt(ctx.WriteField(ctx.plan.FieldMap.StateField, Literal(resumePoint.State))));

                // cachedState = K;
                stmts.Add(Stmt(new BoundAssignmentExpression(ctx.cachedStateLocal, Literal(resumePoint.State))));

                // this.<>u__N = awaiter;
                BoundExpression awaiterToStore = new BoundVariableExpression(awaiterLocal);
                if (!awaiterClrType.IsValueType)
                {
                    // Reference awaiters stored as-is (field is object, implicit upcast).
                }

                stmts.Add(Stmt(ctx.WriteField(awaiterField, awaiterToStore)));

                // builder.AwaitUnsafe/OnCompleted<TAwaiter, TSM>(ref awaiter, ref this);
                // Use the special marker node.
                var awaitOnCompletedMarker = new BoundStateMachineAwaitOnCompleted(
                    awaiterLocal, awaiterClrType, shape.ImplementsCriticalNotifyCompletion);
                stmts.Add(Stmt(awaitOnCompletedMarker));

                // goto exitLabel;
                stmts.Add(new BoundGotoStatement(ctx.plan.MoveNextPlan.ExitLabel));

                // stateK_resume:
                stmts.Add(new BoundLabelStatement(resumePoint.ResumeLabel));

                // [AwaitResumePoint] — hidden sequence point marker after resume dispatch.
                stmts.Add(new BoundAwaitSequencePoint(BoundNodeKind.AwaitResumePoint, resumePoint.State));

                // awaiter = (TAwaiter)this.<>u__N;
                BoundExpression reloadedAwaiter = ctx.ReadField(awaiterField);
                if (!awaiterClrType.IsValueType)
                {
                    reloadedAwaiter = new BoundConversionExpression(awaiterTypeSymbol, reloadedAwaiter);
                }

                stmts.Add(Stmt(new BoundAssignmentExpression(awaiterLocal, reloadedAwaiter)));

                // this.<>u__N = default;
                // Clears the awaiter field to release GC roots. For reference types
                // this emits ldnull;stfld. For value types the emitter uses the
                // optimized ldflda+initobj path via BoundDefaultExpression.
                stmts.Add(Stmt(ctx.WriteField(awaiterField, new BoundDefaultExpression(awaiterTypeSymbol))));

                // this.<>1__state = -1;
                stmts.Add(Stmt(ctx.WriteField(ctx.plan.FieldMap.StateField, Literal(StateMachineStates.NotStartedOrRunningState))));

                // cachedState = -1;
                stmts.Add(Stmt(new BoundAssignmentExpression(ctx.cachedStateLocal, Literal(StateMachineStates.NotStartedOrRunningState))));

                // stateK_resume_after:
                stmts.Add(new BoundLabelStatement(resumePoint.ResumeAfterLabel));

                // result = awaiter.GetResult();
                BoundExpression getResultReceiver;
                if (awaiterClrType.IsValueType)
                {
                    getResultReceiver = new BoundAddressOfExpression(new BoundVariableExpression(awaiterLocal));
                }
                else
                {
                    getResultReceiver = new BoundVariableExpression(awaiterLocal);
                }

                var resultType = awaitExpr.Type ?? TypeSymbol.Void;
                var getResultCall = new BoundImportedInstanceCallExpression(
                    getResultReceiver,
                    shape.GetResultMethod,
                    resultType,
                    ImmutableArray<BoundExpression>.Empty);

                bool hasResult = resultType != TypeSymbol.Void && resultType.ClrType != typeof(void);

                if (resultTarget != null && hasResult)
                {
                    if (TryGetHoistedField(resultTarget, out var targetField))
                    {
                        stmts.Add(Stmt(ctx.WriteField(targetField, getResultCall)));
                    }
                    else
                    {
                        stmts.Add(new BoundVariableDeclaration(resultTarget, getResultCall));
                    }
                }
                else
                {
                    // Discard result (or void GetResult).
                    stmts.Add(Stmt(getResultCall));
                }

                return new BoundBlockStatement(stmts.ToImmutable());
            }

            private bool TryGetHoistedField(VariableSymbol variable, out FieldSymbol field)
            {
                field = null;
                if (variable is ParameterSymbol param)
                {
                    // Check if this is the `this` parameter of an instance method.
                    // The `this` reference is hoisted to the special ThisField.
                    if (ctx.plan.FieldMap.ThisField != null &&
                        ReferenceEquals(param, ctx.plan.KickoffMethod.ThisParameter))
                    {
                        field = ctx.plan.FieldMap.ThisField;
                        return true;
                    }

                    try
                    {
                        field = ctx.plan.FieldMap.GetParameterField(param);
                        return true;
                    }
                    catch (KeyNotFoundException)
                    {
                        return false;
                    }
                }

                if (variable is LocalVariableSymbol)
                {
                    try
                    {
                        field = ctx.plan.FieldMap.GetLocalField(variable);
                        return true;
                    }
                    catch (KeyNotFoundException)
                    {
                        return false;
                    }
                }

                return false;
            }
        }
    }
}
