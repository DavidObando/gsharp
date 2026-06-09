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

            this.cachedStateLocal = new LocalVariableSymbol("<>cachedState", isReadOnly: false, TypeSymbol.Int32);
            allLocals.Add(cachedStateLocal);

            var builderInfo = plan.StateMachine.BuilderInfo;
            if (builderInfo.ResultType != null && builderInfo.ResultType != typeof(void))
            {
                var resultType = plan.StateMachine.ResultTypeSymbol ?? TypeSymbol.FromClrType(builderInfo.ResultType);
                this.retValLocal = new LocalVariableSymbol(
                    "<>retVal", isReadOnly: false, resultType);
                allLocals.Add(retValLocal);
            }
        }

        public MoveNextBody BuildBody()
        {
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();

            // int cachedState = this.<>1__state;
            statements.Add(new BoundVariableDeclaration(null, cachedStateLocal, ReadField(plan.FieldMap.StateField)));

            // T retVal = default; (only for Task<T>)
            if (retValLocal != null)
            {
                statements.Add(new BoundVariableDeclaration(
                    null,
                    retValLocal,
                    new BoundDefaultExpression(null, retValLocal.Type)));
            }

            // Pre-pass: locate each await within the user's try-statement nesting
            // so we can route the resume dispatch around protected regions.
            // `br` and `brtrue`/`brfalse` cannot enter a CLR protected region;
            // instead we route entry to a label placed immediately before the
            // outermost user try, then have each user-try's internal dispatch
            // route further (to either a resume label or a nested entry label).
            var tryDispatch = TryDispatchPlanner.Plan(plan.LoweredBody, awaitResumeMap);

            // Build the try-body: state dispatch + user body + SetResult path.
            // Everything that targets exprReturnLabel must be INSIDE the try
            // because br cannot leave a protected region.
            var tryBodyStatements = ImmutableArray.CreateBuilder<BoundStatement>();
            EmitStateDispatch(tryBodyStatements, tryDispatch);

            // Rewritten user body.
            var rewriter = new InnerRewriter(this, tryDispatch);
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
            tryBodyStatements.Add(new BoundLabelStatement(null, plan.MoveNextPlan.ExpressionReturnLabel));

            // this.<>1__state = -2;
            tryBodyStatements.Add(Stmt(WriteField(plan.FieldMap.StateField, Literal(StateMachineStates.FinishedState))));

            // this.<>t__builder.SetResult([retVal]);
            tryBodyStatements.Add(Stmt(EmitBuilderSetResult()));

            // exitLabel: (inside try — suspension paths jump here to leave)
            tryBodyStatements.Add(new BoundLabelStatement(null, plan.MoveNextPlan.ExitLabel));

            var tryBody = new BoundBlockStatement(null, tryBodyStatements.ToImmutable());

            // catch (Exception ex) { this.<>1__state = -2; builder.SetException(ex); }
            var exLocal = new LocalVariableSymbol("<>ex", isReadOnly: false, TypeSymbol.FromClrType(typeof(Exception)));
            allLocals.Add(exLocal);
            var catchBody = BuildCatchBody(exLocal);
            var catchClause = new BoundCatchClause(TypeSymbol.FromClrType(typeof(Exception)), exLocal, catchBody);
            var tryStatement = new BoundTryStatement(null, tryBody, ImmutableArray.Create(catchClause), finallyBlock: null);
            statements.Add(tryStatement);

            // return; (after try/catch — reached via leave from both paths)
            statements.Add(new BoundReturnStatement(null, null));

            return new MoveNextBody(
                new BoundBlockStatement(null, statements.ToImmutable()),
                allLocals.ToImmutableArray(),
                thisParameter);
        }

        private void EmitStateDispatch(
            ImmutableArray<BoundStatement>.Builder statements,
            TryDispatchPlan tryDispatch)
        {
            statements.Add(new BoundLabelStatement(null, plan.MoveNextPlan.DispatchLabel));

            if (plan.MoveNextPlan.AwaitResumePoints.IsEmpty)
            {
                return;
            }

            foreach (var rp in plan.MoveNextPlan.AwaitResumePoints)
            {
                // If this await is inside a user try, route to the outermost
                // containing try's entry label (placed just before that try);
                // otherwise jump directly to the resume label.
                var target = tryDispatch.GetOuterDispatchTarget(rp.State) ?? rp.ResumeLabel;
                var condition = new BoundBinaryExpression(
                    null,
                    new BoundVariableExpression(null, cachedStateLocal),
                    BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                    Literal(rp.State));
                statements.Add(new BoundConditionalGotoStatement(null, target, condition, jumpIfTrue: true));
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
                null,
                new BoundVariableExpression(null, thisParameter),
                structType,
                plan.FieldMap.BuilderField);
            var builderAddr = new BoundAddressOfExpression(null, builderAccess);
            var setExceptionCall = new BoundImportedInstanceCallExpression(
                null,
                builderAddr,
                builderInfo.SetExceptionMethod,
                TypeSymbol.Void,
                ImmutableArray.Create<BoundExpression>(new BoundVariableExpression(null, exLocal)));
            stmts.Add(Stmt(setExceptionCall));

            return new BoundBlockStatement(null, stmts.ToImmutable());
        }

        private BoundExpression EmitBuilderSetResult()
        {
            var builderInfo = plan.StateMachine.BuilderInfo;
            var builderAccess = new BoundFieldAccessExpression(
                null,
                new BoundVariableExpression(null, thisParameter),
                structType,
                plan.FieldMap.BuilderField);
            var builderAddr = new BoundAddressOfExpression(null, builderAccess);

            ImmutableArray<BoundExpression> args;
            if (retValLocal != null)
            {
                args = ImmutableArray.Create<BoundExpression>(new BoundVariableExpression(null, retValLocal));
            }
            else
            {
                args = ImmutableArray<BoundExpression>.Empty;
            }

            return new BoundImportedInstanceCallExpression(
                null,
                builderAddr,
                builderInfo.SetResultMethod,
                TypeSymbol.Void,
                args);
        }

        private BoundExpression ReadField(FieldSymbol field)
        {
            return new BoundFieldAccessExpression(
                null,
                new BoundVariableExpression(null, thisParameter),
                structType,
                field);
        }

        private BoundExpression WriteField(FieldSymbol field, BoundExpression value)
        {
            return new BoundFieldAssignmentExpression(null, thisParameter, structType, field, value);
        }

        private static BoundExpression Literal(int value)
        {
            return new BoundLiteralExpression(null, value);
        }

        private static BoundExpressionStatement Stmt(BoundExpression expr)
        {
            return new BoundExpressionStatement(null, expr);
        }

        /// <summary>
        /// Walks the user body, replacing awaits, returns, and hoisted locals.
        /// </summary>
        private sealed class InnerRewriter : BoundTreeRewriter
        {
            private readonly RewriteContext ctx;
            private readonly TryDispatchPlan tryDispatch;
            private int aliasOrdinal;

            public InnerRewriter(RewriteContext ctx, TryDispatchPlan tryDispatch)
            {
                this.ctx = ctx;
                this.tryDispatch = tryDispatch;
            }

            protected override BoundStatement RewriteReturnStatement(BoundReturnStatement node)
            {
                var stmts = ImmutableArray.CreateBuilder<BoundStatement>();

                if (node.Expression != null && ctx.retValLocal != null)
                {
                    var rewrittenExpr = RewriteExpression(node.Expression);
                    stmts.Add(new BoundExpressionStatement(
                        null,
                        new BoundAssignmentExpression(null, ctx.retValLocal, rewrittenExpr)));
                }

                stmts.Add(new BoundGotoStatement(null, ctx.plan.MoveNextPlan.ExpressionReturnLabel));
                return new BoundBlockStatement(null, stmts.ToImmutable());
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

                    return new BoundBlockStatement(null, ImmutableArray<BoundStatement>.Empty);
                }

                if (rewrittenInit != node.Initializer)
                {
                    return new BoundVariableDeclaration(null, node.Variable, rewrittenInit);
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
                    return new BoundAssignmentExpression(null, node.Variable, rewrittenValue);
                }

                return node;
            }

            protected override BoundExpression RewriteFieldAssignmentExpression(BoundFieldAssignmentExpression node)
            {
                var rewrittenValue = RewriteExpression(node.Value);

                // If the receiver is hoisted into a state-machine field, the
                // BoundFieldAssignmentExpression node shape can't reference the
                // field directly (Receiver is VariableSymbol).
                if (node.Receiver != null
                    && TryGetHoistedField(node.Receiver, out var recvField))
                {
                    if (node.StructType.IsClass)
                    {
                        // Class receiver — reference type. Alias the hoisted field
                        // to a fresh local and store through it.
                        var aliasLocal = new LocalVariableSymbol(
                            "<>recv_alias_" + (aliasOrdinal++),
                            isReadOnly: false,
                            node.Receiver.Type);
                        var decl = new BoundVariableDeclaration(null, aliasLocal, ctx.ReadField(recvField));
                        var newAssign = new BoundFieldAssignmentExpression(
                            null,
                            aliasLocal,
                            node.StructType,
                            node.Field,
                            rewrittenValue);
                        return new BoundBlockExpression(
                            null,
                            ImmutableArray.Create<BoundStatement>(decl),
                            newAssign);
                    }
                    else
                    {
                        // Value-type struct receiver. A read into a local would
                        // capture a copy; we must write the mutated copy back into
                        // the hoisted state-machine field for the change to persist.
                        var copyLocal = new LocalVariableSymbol(
                            "<>recv_copy_" + (aliasOrdinal++),
                            isReadOnly: false,
                            node.Receiver.Type);
                        var copyDecl = new BoundVariableDeclaration(null, copyLocal, ctx.ReadField(recvField));
                        var innerAssign = new BoundFieldAssignmentExpression(
                            null,
                            copyLocal,
                            node.StructType,
                            node.Field,
                            rewrittenValue);
                        var writeBack = new BoundExpressionStatement(
                            null,
                            ctx.WriteField(recvField, new BoundVariableExpression(null, copyLocal)));
                        var resultRead = new BoundFieldAccessExpression(
                            null,
                            new BoundVariableExpression(null, copyLocal),
                            node.StructType,
                            node.Field);
                        return new BoundBlockExpression(
                            null,
                            ImmutableArray.Create<BoundStatement>(
                                copyDecl,
                                new BoundExpressionStatement(null, innerAssign),
                                writeBack),
                            resultRead);
                    }
                }

                if (rewrittenValue != node.Value)
                {
                    return new BoundFieldAssignmentExpression(null, node.Receiver, node.StructType, node.Field, rewrittenValue);
                }

                return node;
            }

            protected override BoundExpression RewriteIndexAssignmentExpression(BoundIndexAssignmentExpression node)
            {
                var rewrittenIndex = RewriteExpression(node.Index);
                var rewrittenValue = RewriteExpression(node.Value);

                // If the target (array/slice/map) is hoisted into a state-machine
                // field, the BoundIndexAssignmentExpression shape can't reference
                // the field directly (Target is VariableSymbol). Arrays/slices/maps
                // are reference types, so aliasing the hoisted field into a fresh
                // local lets us perform the index store through that local; the
                // mutation lands on the same underlying array.
                if (TryGetHoistedField(node.Target, out var targetField))
                {
                    var aliasLocal = new LocalVariableSymbol(
                        "<>arr_alias_" + (aliasOrdinal++),
                        isReadOnly: false,
                        node.Target.Type);
                    var decl = new BoundVariableDeclaration(null, aliasLocal, ctx.ReadField(targetField));
                    var newAssign = new BoundIndexAssignmentExpression(
                        null,
                        aliasLocal,
                        rewrittenIndex,
                        rewrittenValue,
                        node.Type);
                    return new BoundBlockExpression(
                        null,
                        ImmutableArray.Create<BoundStatement>(decl),
                        newAssign);
                }

                if (rewrittenIndex != node.Index || rewrittenValue != node.Value)
                {
                    return new BoundIndexAssignmentExpression(null, node.Target, rewrittenIndex, rewrittenValue, node.Type);
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

                // Patch hoisted catch variables.
                var needsCatchPatch = false;
                foreach (var clause in result.CatchClauses)
                {
                    if (TryGetHoistedField(clause.Variable, out _))
                    {
                        needsCatchPatch = true;
                        break;
                    }
                }

                if (needsCatchPatch)
                {
                    var patchedClauses = ImmutableArray.CreateBuilder<BoundCatchClause>();
                    foreach (var clause in result.CatchClauses)
                    {
                        if (TryGetHoistedField(clause.Variable, out var field))
                        {
                            var copyToField = Stmt(ctx.WriteField(
                                field,
                                new BoundVariableExpression(null, clause.Variable)));
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

                            patchedClauses.Add(new BoundCatchClause(
                                clause.ExceptionType,
                                clause.Variable,
                                new BoundBlockStatement(null, stmts.ToImmutable())));
                        }
                        else
                        {
                            patchedClauses.Add(clause);
                        }
                    }

                    result = new BoundTryStatement(
                        null,
                        result.TryBlock,
                        patchedClauses.ToImmutable(),
                        result.FinallyBlock);
                }

                // If this user try contains awaits in its body, prepend a
                // state-dispatch at the top of the try body (legal because
                // dispatch and resume labels are both inside the same
                // protected region) and mark the position immediately before
                // the try with the synthesized entry label that the outer
                // dispatch (or an enclosing try's dispatch) routes to.
                var dispatchEntries = tryDispatch.GetInternalDispatchEntries(node);
                var entryLabel = tryDispatch.GetEntryLabel(node);

                if (dispatchEntries.IsDefaultOrEmpty && entryLabel == null)
                {
                    return result;
                }

                var newTryBodyStmts = ImmutableArray.CreateBuilder<BoundStatement>();
                if (!dispatchEntries.IsDefaultOrEmpty)
                {
                    foreach (var entry in dispatchEntries)
                    {
                        var cond = new BoundBinaryExpression(
                            null,
                            new BoundVariableExpression(null, ctx.cachedStateLocal),
                            BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                            Literal(entry.State));
                        newTryBodyStmts.Add(new BoundConditionalGotoStatement(null, entry.Target, cond, jumpIfTrue: true));
                    }
                }

                if (result.TryBlock is BoundBlockStatement existingBlock)
                {
                    newTryBodyStmts.AddRange(existingBlock.Statements);
                }
                else
                {
                    newTryBodyStmts.Add(result.TryBlock);
                }

                var rebuiltTry = new BoundTryStatement(
                    null,
                    new BoundBlockStatement(null, newTryBodyStmts.ToImmutable()),
                    result.CatchClauses,
                    result.FinallyBlock);

                if (entryLabel == null)
                {
                    return rebuiltTry;
                }

                // Place the entry label immediately before the try (outside it).
                return new BoundBlockStatement(
                    null,
                    ImmutableArray.Create<BoundStatement>(
                    new BoundLabelStatement(null, entryLabel),
                    rebuiltTry));
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
                var awaiterTypeSymbol = awaitExpr.AwaiterTypeSymbol ?? TypeSymbol.FromClrType(awaiterClrType);
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
                stmts.Add(new BoundConditionalGotoStatement(
                    null,
                    resumePoint.ResumeAfterLabel,
                    isCompletedCall,
                    jumpIfTrue: true));

                // === Suspension path ===
                // [AwaitYieldPoint] — hidden sequence point marker before state save.
                stmts.Add(new BoundAwaitSequencePoint(null, BoundNodeKind.AwaitYieldPoint, resumePoint.State));

                // this.<>1__state = K;
                stmts.Add(Stmt(ctx.WriteField(ctx.plan.FieldMap.StateField, Literal(resumePoint.State))));

                // cachedState = K;
                stmts.Add(Stmt(new BoundAssignmentExpression(null, ctx.cachedStateLocal, Literal(resumePoint.State))));

                // this.<>u__N = awaiter;
                BoundExpression awaiterToStore = new BoundVariableExpression(null, awaiterLocal);
                if (!awaiterClrType.IsValueType)
                {
                    // Reference awaiters stored as-is (field is object, implicit upcast).
                }

                stmts.Add(Stmt(ctx.WriteField(awaiterField, awaiterToStore)));

                // builder.AwaitUnsafe/OnCompleted<TAwaiter, TSM>(ref awaiter, ref this);
                // Use the special marker node.
                var awaitOnCompletedMarker = new BoundStateMachineAwaitOnCompleted(
                    null,
                    awaiterLocal,
                    awaiterClrType,
                    awaiterTypeSymbol,
                    shape.ImplementsCriticalNotifyCompletion);
                stmts.Add(Stmt(awaitOnCompletedMarker));

                // goto exitLabel;
                stmts.Add(new BoundGotoStatement(null, ctx.plan.MoveNextPlan.ExitLabel));

                // stateK_resume:
                stmts.Add(new BoundLabelStatement(null, resumePoint.ResumeLabel));

                // [AwaitResumePoint] — hidden sequence point marker after resume dispatch.
                stmts.Add(new BoundAwaitSequencePoint(null, BoundNodeKind.AwaitResumePoint, resumePoint.State));

                // awaiter = (TAwaiter)this.<>u__N;
                BoundExpression reloadedAwaiter = ctx.ReadField(awaiterField);
                if (!awaiterClrType.IsValueType)
                {
                    reloadedAwaiter = new BoundConversionExpression(null, awaiterTypeSymbol, reloadedAwaiter);
                }

                stmts.Add(Stmt(new BoundAssignmentExpression(null, awaiterLocal, reloadedAwaiter)));

                // this.<>u__N = default;
                // Clears the awaiter field to release GC roots. For reference types
                // this emits ldnull;stfld. For value types the emitter uses the
                // optimized ldflda+initobj path via BoundDefaultExpression.
                stmts.Add(Stmt(ctx.WriteField(awaiterField, new BoundDefaultExpression(null, awaiterTypeSymbol))));

                // this.<>1__state = -1;
                stmts.Add(Stmt(ctx.WriteField(ctx.plan.FieldMap.StateField, Literal(StateMachineStates.NotStartedOrRunningState))));

                // cachedState = -1;
                stmts.Add(Stmt(new BoundAssignmentExpression(null, ctx.cachedStateLocal, Literal(StateMachineStates.NotStartedOrRunningState))));

                // stateK_resume_after:
                stmts.Add(new BoundLabelStatement(null, resumePoint.ResumeAfterLabel));

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

                bool hasResult = resultType != TypeSymbol.Void && resultType.ClrType != typeof(void);

                if (resultTarget != null && hasResult)
                {
                    if (TryGetHoistedField(resultTarget, out var targetField))
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
                    // Discard result (or void GetResult).
                    stmts.Add(Stmt(getResultCall));
                }

                return new BoundBlockStatement(null, stmts.ToImmutable());
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
