// <copyright file="MoveNextBodyRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Lowering
import System.Linq

/// Rewrites the lowered user body into the canonical `MoveNext` skeleton
/// (spec §6). Replaces every (cref:BoundAwaitExpression) with the §6.4
/// per-await suspension sequence, replaces `return` statements with the
/// §6.5 funneled form, and rewrites hoisted locals/parameters to field accesses
/// on the state-machine struct.
/// @remarks The output is a (cref:BoundBlockStatement) that the existing
/// `BodyEmitter` in `ReflectionMetadataEmitter` can lower directly
/// to IL. No (cref:BoundAwaitExpression) nodes survive. The only
/// synthesized node type that requires special emitter support is
/// (cref:BoundStateMachineAwaitOnCompleted), which carries the data
/// needed to emit the `AwaitOnCompleted`/`AwaitUnsafeOnCompleted`
/// MethodSpec against the synthesized state-machine TypeDef.
shared class MoveNextBodyRewriter {
    /// Result of building the MoveNext body. Contains the body plus metadata
    /// needed by the emitter (e.g., the locals that need IL slots).
    class MoveNextBody {
        /// Initializes a new instance of the (cref:MoveNextBody) class.
        /// @param body The rewritten MoveNext block statement.
        /// @param locals All locals declared in the body that need IL slots.
        /// @param thisParameter The synthesized parameter representing `this` (arg0).
        init(body BoundBlockStatement, locals ImmutableArray[LocalVariableSymbol], thisParameter ParameterSymbol) {
            Body = body
            Locals = locals
            ThisParameter = thisParameter
        }

        /// Gets the rewritten MoveNext block statement.
        prop Body BoundBlockStatement {
            get;
        }

        /// Gets all locals declared in the body that need IL slots.
        prop Locals ImmutableArray[LocalVariableSymbol] {
            get;
        }

        /// Gets the synthesized parameter representing `this` (arg0).
        prop ThisParameter ParameterSymbol {
            get;
        }
    }

    private class RewriteContext {
        private let plan AsyncStateMachinePlan
        private let thisParameter ParameterSymbol
        private let structType StructSymbol
        private let awaitResumeMap Dictionary[BoundAwaitExpression, AwaitResumePoint]
        private let cachedStateLocal LocalVariableSymbol
        private let retValLocal LocalVariableSymbol?
        private let allLocals List[LocalVariableSymbol] = List[LocalVariableSymbol]()

        init(plan AsyncStateMachinePlan) {
            this.plan = plan
            this.structType = plan.FieldMap.StructType
            // MoveNext's `this` is arg0 (managed pointer to the struct).
            this.thisParameter = ParameterSymbol("<>sm_this", plan.FieldMap.StructType){IsReceiverParameter = true}
            this.awaitResumeMap = Dictionary[BoundAwaitExpression, AwaitResumePoint]()
            for rp in plan.MoveNextPlan.AwaitResumePoints {
                this.awaitResumeMap[rp.AwaitExpression] = rp
            }
            this.cachedStateLocal = LocalVariableSymbol("<>cachedState", isReadOnly: false, TypeSymbol.Int32)
            allLocals.Add(cachedStateLocal)
            let builderInfo = plan.StateMachine.BuilderInfo
            if builderInfo.ResultType != nil && !builderInfo.ResultType.IsSameAs(typeof(Void)) {
                let resultType = plan.StateMachine.ResultTypeSymbol ?? TypeSymbol.FromClrTypeWithoutNullability(
                    builderInfo.ResultType,
                    NullabilityFreeReason.EmitShape
                )
                this.retValLocal = LocalVariableSymbol("<>retVal", isReadOnly: false, resultType)
                allLocals.Add(retValLocal!!)
            }
        }

        func BuildBody() MoveNextBody {
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            // int cachedState = this.<>1__state;
            statements.Add(BoundVariableDeclaration(nil, cachedStateLocal, ReadField(plan.FieldMap.StateField)))
            // T retVal = default; (only for Task<T>)
            if retValLocal != nil {
                statements.Add(
                    BoundVariableDeclaration(nil, retValLocal!!, BoundDefaultExpression(nil, retValLocal!!.Type))
                )
            }
            // Pre-pass: locate each await within the user's try-statement nesting
            // so we can route the resume dispatch around protected regions.
            // `br` and `brtrue`/`brfalse` cannot enter a CLR protected region;
            // instead we route entry to a label placed immediately before the
            // outermost user try, then have each user-try's internal dispatch
            // route further (to either a resume label or a nested entry label).
            let tryDispatch = TryDispatchPlanner.Plan(plan.LoweredBody, awaitResumeMap)
            // Build the try-body: state dispatch + user body + SetResult path.
            // Everything that targets exprReturnLabel must be INSIDE the try
            // because br cannot leave a protected region.
            let tryBodyStatements = ImmutableArray.CreateBuilder[BoundStatement]()
            EmitStateDispatch(tryBodyStatements, tryDispatch)
            // Rewritten user body.
            let rewriter = MoveNextBodyRewriter.RewriteContext.InnerRewriter(this, tryDispatch)
            let rewrittenBody = rewriter.RewriteStatement(plan.LoweredBody)
            if rewrittenBody is BoundBlockStatement block {
                tryBodyStatements.AddRange(block.Statements)
            } else {
                tryBodyStatements.Add(rewrittenBody)
            }
            // exprReturnLabel: (inside try — target of return-funneling gotos)
            tryBodyStatements.Add(BoundLabelStatement(nil, plan.MoveNextPlan.ExpressionReturnLabel))
            // this.<>1__state = -2;
            tryBodyStatements.Add(Stmt(WriteField(plan.FieldMap.StateField, Literal(StateMachineStates.FinishedState))))
            // this.<>t__builder.SetResult([retVal]);
            tryBodyStatements.Add(Stmt(EmitBuilderSetResult()))
            // exitLabel: (inside try — suspension paths jump here to leave)
            tryBodyStatements.Add(BoundLabelStatement(nil, plan.MoveNextPlan.ExitLabel))
            let tryBody = BoundBlockStatement(nil, tryBodyStatements.ToImmutable())
            // catch (Exception ex) { this.<>1__state = -2; builder.SetException(ex); }
            let exLocal = LocalVariableSymbol(
                "<>ex",
                isReadOnly: false,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(Exception), NullabilityFreeReason.TypeLiteral)
            )
            allLocals.Add(exLocal)
            let catchBody = BuildCatchBody(exLocal)
            let catchClause = BoundCatchClause(
                TypeSymbol.FromClrTypeWithoutNullability(typeof(Exception), NullabilityFreeReason.TypeLiteral),
                exLocal,
                catchBody
            )
            let tryStatement = BoundTryStatement(nil, tryBody, ImmutableArray.Create(catchClause), finallyBlock: nil)
            statements.Add(tryStatement)
            // return; (after try/catch — reached via leave from both paths)
            statements.Add(BoundReturnStatement(nil, nil))
            return MoveNextBody(
                BoundBlockStatement(nil, statements.ToImmutable()),
                allLocals.ToImmutableArray(),
                thisParameter
            )
        }

        private func EmitStateDispatch(statements ImmutableArray[BoundStatement].Builder, tryDispatch TryDispatchPlan) {
            statements.Add(BoundLabelStatement(nil, plan.MoveNextPlan.DispatchLabel))
            if plan.MoveNextPlan.AwaitResumePoints.IsEmpty {
                return
            }
            for rp in plan.MoveNextPlan.AwaitResumePoints {
                // If this await is inside a user try, route to the outermost
                // containing try's entry label (placed just before that try);
                // otherwise jump directly to the resume label.
                let target = tryDispatch.GetOuterDispatchTarget(rp.State) ?? rp.ResumeLabel
                let condition = BoundBinaryExpression(
                    nil,
                    BoundVariableExpression(nil, cachedStateLocal),
                    Invariant.Required(
                        BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                        "int32 equality operator exists for await-state dispatch",
                        expression: "BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32)"
                    ),
                    Literal(rp.State)
                )
                statements.Add(BoundConditionalGotoStatement(nil, target, condition, jumpIfTrue: true))
            }
        }

        private func BuildCatchBody(exLocal LocalVariableSymbol) BoundBlockStatement {
            let stmts = ImmutableArray.CreateBuilder[BoundStatement]()
            // this.<>1__state = -2;
            stmts.Add(Stmt(WriteField(plan.FieldMap.StateField, Literal(StateMachineStates.FinishedState))))
            // this.<>t__builder.SetException(ex);
            let builderInfo = plan.StateMachine.BuilderInfo
            let builderAccess = BoundFieldAccessExpression(
                nil,
                BoundVariableExpression(nil, thisParameter),
                structType,
                plan.FieldMap.BuilderField
            )
            let builderAddr = BoundAddressOfExpression(nil, builderAccess)
            let setExceptionCall = BoundImportedInstanceCallExpression(
                nil,
                builderAddr,
                Invariant.Required(
                    builderInfo.SetExceptionMethod,
                    "MoveNextBodyRewriter runs only for a non-iterator async method, whose builder passed AsyncMethodBuilderInfo.IsValid -- that requires SetException for every kind except AsyncIterator",
                    expression: "builderInfo.SetExceptionMethod"
                ),
                TypeSymbol.Void,
                ImmutableArray.Create[BoundExpression](BoundVariableExpression(nil, exLocal))
            )
            stmts.Add(Stmt(setExceptionCall))
            return BoundBlockStatement(nil, stmts.ToImmutable())
        }

        private func EmitBuilderSetResult() BoundExpression {
            let builderInfo = plan.StateMachine.BuilderInfo
            let builderAccess = BoundFieldAccessExpression(
                nil,
                BoundVariableExpression(nil, thisParameter),
                structType,
                plan.FieldMap.BuilderField
            )
            let builderAddr = BoundAddressOfExpression(nil, builderAccess)
            var args ImmutableArray[BoundExpression]
            if retValLocal != nil {
                args = ImmutableArray.Create[BoundExpression](BoundVariableExpression(nil, retValLocal!!))
            } else {
                args = ImmutableArray[BoundExpression].Empty
            }
            return BoundImportedInstanceCallExpression(
                nil,
                builderAddr,
                Invariant.Required(
                    builderInfo.SetResultMethod,
                    "MoveNextBodyRewriter runs only for a non-iterator async method, whose builder passed AsyncMethodBuilderInfo.IsValid -- that requires SetResult for every kind except AsyncIterator",
                    expression: "builderInfo.SetResultMethod"
                ),
                TypeSymbol.Void,
                args
            )
        }

        private func ReadField(field FieldSymbol, narrowedType TypeSymbol? = nil) BoundExpression {
            return BoundFieldAccessExpression(
                nil,
                BoundVariableExpression(nil, thisParameter),
                structType,
                field,
                narrowedType
            )
        }

        private func WriteField(field FieldSymbol, value BoundExpression) BoundExpression {
            return BoundFieldAssignmentExpression(nil, thisParameter, structType, field, value)
        }

        /// Walks the user body, replacing awaits, returns, and hoisted locals.
        private class InnerRewriter : BoundTreeRewriter {
            private let ctx RewriteContext
            private let tryDispatch TryDispatchPlan
            private var aliasOrdinal int32

            init(ctx RewriteContext, tryDispatch TryDispatchPlan) {
                this.ctx = ctx
                this.tryDispatch = tryDispatch
            }

            protected override func RewriteReturnStatement(node BoundReturnStatement) BoundStatement {
                let stmts = ImmutableArray.CreateBuilder[BoundStatement]()
                if node.Expression != nil && ctx.retValLocal != nil {
                    let rewrittenExpr = RewriteExpression(node.Expression)
                    // ADR-0174 P3-8: the rewritten statement keeps the `return`'s
                    // own anchor so the PDB still maps that source line inside
                    // MoveNext and a debugger can break on it.
                    stmts.Add(
                        BoundExpressionStatement(
                            node.Syntax,
                            BoundAssignmentExpression(nil, ctx.retValLocal!!, rewrittenExpr)
                        )
                    )
                }
                stmts.Add(
                    BoundGotoStatement(
                        if node.Expression != nil && ctx.retValLocal != nil {
                            default(SyntaxNode?)
                        } else {
                            node.Syntax
                        },
                        ctx.plan.MoveNextPlan.ExpressionReturnLabel
                    )
                )
                return BoundBlockStatement(nil, stmts.ToImmutable())
            }

            protected override func RewriteExpressionStatement(node BoundExpressionStatement) BoundStatement {
                if node.Expression is BoundAwaitExpression awaitExpr {
                    return EmitPerAwaitSequence(awaitExpr, resultTarget: nil, syntax: node.Syntax)
                }
                // Check if the expression is an assignment whose RHS is an await.
                if node.Expression is BoundAssignmentExpression assign &&
                    assign.Expression is BoundAwaitExpression assignAwait {
                    return EmitPerAwaitSequence(assignAwait, resultTarget: assign.Variable, syntax: node.Syntax)
                }
                return base.RewriteExpressionStatement(node)
            }

            protected override func RewriteVariableDeclaration(node BoundVariableDeclaration) BoundStatement {
                if node.Initializer is BoundAwaitExpression awaitExpr {
                    return EmitPerAwaitSequence(awaitExpr, resultTarget: node.Variable, syntax: node.Syntax)
                }
                let rewrittenInit BoundExpression? = if node.Initializer != nil {
                    RewriteExpression(node.Initializer)
                } else {
                    default(BoundExpression?)
                }
                if TryGetHoistedField(node.Variable, out var field) {
                    if rewrittenInit != nil {
                        return RewriteContext.Stmt(ctx.WriteField(field!!, rewrittenInit), node.Syntax)
                    }
                    return BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
                }
                if rewrittenInit != node.Initializer {
                    return BoundVariableDeclaration(nil, node.Variable, rewrittenInit, node.ConstantValue)
                }
                return node
            }

            protected override func RewriteVariableExpression(node BoundVariableExpression) BoundExpression {
                if TryGetHoistedField(node.Variable, out var field) {
                    return ctx.ReadField(field!!, node.NarrowedType)
                }
                return node
            }

            protected override func RewriteAssignmentExpression(node BoundAssignmentExpression) BoundExpression {
                let rewrittenValue = RewriteExpression(node.Expression)
                if TryGetHoistedField(node.Variable, out var field) {
                    return ctx.WriteField(field!!, rewrittenValue)
                }
                if rewrittenValue != node.Expression {
                    return BoundAssignmentExpression(nil, node.Variable, rewrittenValue)
                }
                return node
            }

            protected override func RewriteFieldAssignmentExpression(
                node BoundFieldAssignmentExpression
            ) BoundExpression {
                let rewrittenValue = RewriteExpression(node.Value)
                // If the receiver is hoisted into a state-machine field, the
                // BoundFieldAssignmentExpression node shape can't reference the
                // field directly (Receiver is VariableSymbol).
                if node.Receiver is {} receiver && TryGetHoistedField(receiver, out var recvField) {
                    if BoundNodeForm.DeclaringType(node).IsClass {
                        // Class receiver — reference type. Alias the hoisted field
                        // to a fresh local and store through it.
                        let aliasLocal = LocalVariableSymbol(
                            "<>recv_alias_" + (aliasOrdinal++).ToString(),
                            isReadOnly: false,
                            receiver.Type
                        )
                        let decl = BoundVariableDeclaration(nil, aliasLocal, ctx.ReadField(recvField!!))
                        let newAssign = BoundFieldAssignmentExpression(
                            nil,
                            aliasLocal,
                            BoundNodeForm.DeclaringType(node),
                            node.Field,
                            rewrittenValue
                        )
                        return BoundBlockExpression(nil, ImmutableArray.Create[BoundStatement](decl), newAssign)
                    } else {
                        // Value-type struct receiver. A read into a local would
                        // capture a copy; we must write the mutated copy back into
                        // the hoisted state-machine field for the change to persist.
                        let copyLocal = LocalVariableSymbol(
                            "<>recv_copy_" + (aliasOrdinal++).ToString(),
                            isReadOnly: false,
                            receiver.Type
                        )
                        let copyDecl = BoundVariableDeclaration(nil, copyLocal, ctx.ReadField(recvField!!))
                        let innerAssign = BoundFieldAssignmentExpression(
                            nil,
                            copyLocal,
                            BoundNodeForm.DeclaringType(node),
                            node.Field,
                            rewrittenValue
                        )
                        let writeBack = BoundExpressionStatement(
                            nil,
                            ctx.WriteField(recvField!!, BoundVariableExpression(nil, copyLocal))
                        )
                        let resultRead = BoundFieldAccessExpression(
                            nil,
                            BoundVariableExpression(nil, copyLocal),
                            BoundNodeForm.DeclaringType(node),
                            node.Field
                        )
                        return BoundBlockExpression(
                            nil,
                            ImmutableArray.Create[BoundStatement](
                                copyDecl,
                                BoundExpressionStatement(nil, innerAssign),
                                writeBack
                            ),
                            resultRead
                        )
                    }
                }
                if rewrittenValue != node.Value {
                    // Issue #3333 / #1644: an interface static field write has a
                    // null Receiver and StructType, and carries the owning
                    // interface in InterfaceType. Rebuilding it through the
                    // variable-receiver constructor drops that, and the emitter
                    // parents the field at the open-generic TypeDef instead of a
                    // TypeSpec. This override must carry the same guard the base
                    // BoundTreeRewriter does.
                    if node.InterfaceType != nil {
                        return BoundFieldAssignmentExpression(
                            nil,
                            node.Field,
                            node.InterfaceType,
                            rewrittenValue,
                            node.ResultType
                        )
                    }
                    if node.ReceiverExpression != nil {
                        return BoundFieldAssignmentExpression.WithExpressionReceiver(
                            nil,
                            node.ReceiverExpression,
                            BoundNodeForm.DeclaringType(node),
                            node.Field,
                            rewrittenValue,
                            node.ResultType
                        )
                    }
                    return BoundFieldAssignmentExpression(
                        nil,
                        node.Receiver,
                        BoundNodeForm.DeclaringType(node),
                        node.Field,
                        rewrittenValue,
                        node.ResultType
                    )
                }
                return node
            }

            protected override func RewriteIndexAssignmentExpression(
                node BoundIndexAssignmentExpression
            ) BoundExpression {
                let rewrittenTargetExpression = if node.TargetExpression != nil {
                    RewriteExpression(node.TargetExpression)
                } else {
                    default(BoundExpression?)
                }
                let rewrittenIndices = node.Indices.Select(RewriteExpression).ToImmutableArray()
                let rewrittenValue = RewriteExpression(node.Value)
                // If the target (array/slice/map) is hoisted into a state-machine
                // field, the BoundIndexAssignmentExpression shape can't reference
                // the field directly (Target is VariableSymbol). Arrays/slices/maps
                // are reference types, so aliasing the hoisted field into a fresh
                // local lets us perform the index store through that local; the
                // mutation lands on the same underlying array.
                if node.Target != nil && TryGetHoistedField(node.Target, out var targetField) {
                    let aliasLocal = LocalVariableSymbol(
                        "<>arr_alias_" + (aliasOrdinal++).ToString(),
                        isReadOnly: false,
                        node.Target.Type
                    )
                    let decl = BoundVariableDeclaration(nil, aliasLocal, ctx.ReadField(targetField!!))
                    let newAssign = BoundIndexAssignmentExpression(
                        nil,
                        aliasLocal,
                        rewrittenIndices,
                        rewrittenValue,
                        node.Type
                    )
                    return BoundBlockExpression(nil, ImmutableArray.Create[BoundStatement](decl), newAssign)
                }
                if rewrittenTargetExpression != node.TargetExpression || !rewrittenIndices.SequenceEqual(
                    node.Indices
                ) ||
                    rewrittenValue != node
                    .Value {
                    // Preserve the node's form (see #3333): the expression-target
                    // form carries no Target.
                    return if node.TargetExpression != nil {
                        BoundIndexAssignmentExpression.WithExpressionTarget(
                            nil,
                            Invariant.Required(
                                rewrittenTargetExpression,
                                "an expression-target index assignment retains its target",
                                expression: "rewrittenTargetExpression"
                            ),
                            rewrittenIndices,
                            rewrittenValue,
                            node.Type
                        )
                    } else {
                        BoundIndexAssignmentExpression(
                            nil,
                            BoundNodeForm.VariableTarget(node),
                            rewrittenIndices,
                            rewrittenValue,
                            node.Type
                        )
                    }
                }
                return node
            }

            protected override func RewriteClrIndexAssignmentExpression(
                node BoundClrIndexAssignmentExpression
            ) BoundExpression {
                var argBuilder ImmutableArray[BoundExpression].Builder? = nil
                for var i = 0; i < node.Arguments.Length; i++ {
                    let oldArg = node.Arguments[i]
                    let newArg = RewriteExpression(oldArg)
                    if newArg != oldArg && argBuilder == nil {
                        argBuilder = ImmutableArray.CreateBuilder[BoundExpression](node.Arguments.Length)
                        for var j = 0; j < i; j++ {
                            argBuilder.Add(node.Arguments[j])
                        }
                    }
                    if argBuilder != nil {
                        argBuilder.Add(newArg)
                    }
                }
                let rewrittenArgs = argBuilder?.ToImmutable() ?? node.Arguments
                let rewrittenValue = RewriteExpression(node.Value)
                // If the target (e.g. a Dictionary) is hoisted into a
                // state-machine field, the BoundClrIndexAssignmentExpression
                // shape can't reference the field directly (Target is a
                // VariableSymbol the base rewriter never visits). Mirror the
                // closure-boxing fix (issue #618): switch to the expression
                // target form reading the hoisted field. The target is a
                // reference type, so writing the indexer through the field's
                // value mutates the same underlying object.
                if node.Target != nil && TryGetHoistedField(node.Target, out var targetField) {
                    return BoundClrIndexAssignmentExpression.WithExpressionTarget(
                        nil,
                        ctx.ReadField(targetField!!),
                        node.Indexer,
                        rewrittenArgs,
                        rewrittenValue,
                        node.Type,
                        node.ConstrainedReceiverTypeParameter,
                        node.ConstrainedInterfaceType
                    )
                }
                if node.TargetExpression != nil {
                    let rewrittenTarget = RewriteExpression(node.TargetExpression)
                    if rewrittenTarget != node.TargetExpression || argBuilder != nil || rewrittenValue != node.Value {
                        return BoundClrIndexAssignmentExpression.WithExpressionTarget(
                            nil,
                            rewrittenTarget,
                            node.Indexer,
                            rewrittenArgs,
                            rewrittenValue,
                            node.Type,
                            node.ConstrainedReceiverTypeParameter,
                            node.ConstrainedInterfaceType
                        )
                    }
                    return node
                }
                if argBuilder != nil || rewrittenValue != node.Value {
                    // Preserve the node's form: rebuilding the expression-target
                    // form through the variable-target constructor would drop
                    // TargetExpression -- the #3333 failure shape.
                    return if node.TargetExpression != nil {
                        BoundClrIndexAssignmentExpression.WithExpressionTarget(
                            nil,
                            node.TargetExpression,
                            node.Indexer,
                            rewrittenArgs,
                            rewrittenValue,
                            node.Type,
                            node.ConstrainedReceiverTypeParameter,
                            node.ConstrainedInterfaceType
                        )
                    } else {
                        BoundClrIndexAssignmentExpression(
                            nil,
                            BoundNodeForm.VariableTarget(node),
                            node.Indexer,
                            rewrittenArgs,
                            rewrittenValue,
                            node.Type,
                            node.ConstrainedReceiverTypeParameter,
                            node.ConstrainedInterfaceType
                        )
                    }
                }
                return node
            }

            protected override func RewriteTryStatement(node BoundTryStatement) BoundStatement {
                // The emitter stores the caught exception into a LOCAL slot via
                // EmitStoreVariable(clause.Variable). If the clause variable is
                // hoisted to a field (because it's referenced elsewhere in the
                // async body), the body's field-based reads would see the default
                // value (null) instead of the caught exception. Fix: inject a
                // local→field copy at the start of each catch body for hoisted
                // catch variables.
                var result = cast[BoundTryStatement](base.RewriteTryStatement(node))
                // Patch hoisted catch variables.
                var needsCatchPatch = false
                for clause in result.CatchClauses {
                    if clause.Variable is {} variable && TryGetHoistedField(variable, out _) {
                        needsCatchPatch = true
                        break
                    }
                }
                if needsCatchPatch {
                    let patchedClauses = ImmutableArray.CreateBuilder[BoundCatchClause]()
                    for clause in result.CatchClauses {
                        if clause.Variable is {} variable && TryGetHoistedField(variable, out var field) {
                            let copyToField = RewriteContext.Stmt(
                                ctx.WriteField(field!!, BoundVariableExpression(nil, variable))
                            )
                            let stmts = ImmutableArray.CreateBuilder[BoundStatement]()
                            stmts.Add(copyToField)
                            if clause.Body is BoundBlockStatement block {
                                stmts.AddRange(block.Statements)
                            } else {
                                stmts.Add(clause.Body)
                            }
                            // WithBody so the clause keeps its ADR-0177 `when`
                            // filter (and ExitsThroughFinally) rather than
                            // silently dropping them here.
                            patchedClauses.Add(clause.WithBody(BoundBlockStatement(nil, stmts.ToImmutable())))
                        } else {
                            patchedClauses.Add(clause)
                        }
                    }
                    result = BoundTryStatement(nil, result.TryBlock, patchedClauses.ToImmutable(), result.FinallyBlock)
                }
                // If this user try contains awaits in its body, prepend a
                // state-dispatch at the top of the try body (legal because
                // dispatch and resume labels are both inside the same
                // protected region) and mark the position immediately before
                // the try with the synthesized entry label that the outer
                // dispatch (or an enclosing try's dispatch) routes to.
                let dispatchEntries = tryDispatch.GetInternalDispatchEntries(node)
                let entryLabel BoundLabel? = tryDispatch.GetEntryLabel(node)
                if dispatchEntries.IsDefaultOrEmpty && entryLabel == nil {
                    return result
                }
                let newTryBodyStmts = ImmutableArray.CreateBuilder[BoundStatement]()
                if !dispatchEntries.IsDefaultOrEmpty {
                    for entry in dispatchEntries {
                        let cond = BoundBinaryExpression(
                            nil,
                            BoundVariableExpression(nil, ctx.cachedStateLocal),
                            Invariant.Required(
                                BoundBinaryOperator.Bind(
                                    SyntaxKind.EqualsEqualsToken,
                                    TypeSymbol.Int32,
                                    TypeSymbol.Int32
                                ),
                                "int32 equality operator exists for await-state dispatch",
                                expression: "BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32)"
                            ),
                            RewriteContext.Literal(entry.State)
                        )
                        newTryBodyStmts.Add(BoundConditionalGotoStatement(nil, entry.Target, cond, jumpIfTrue: true))
                    }
                }
                if result.TryBlock is BoundBlockStatement existingBlock {
                    newTryBodyStmts.AddRange(existingBlock.Statements)
                } else {
                    newTryBodyStmts.Add(result.TryBlock)
                }
                let rebuiltTry = BoundTryStatement(
                    nil,
                    BoundBlockStatement(nil, newTryBodyStmts.ToImmutable()),
                    result.CatchClauses,
                    result.FinallyBlock
                )
                if entryLabel == nil {
                    return rebuiltTry
                }
                // Place the entry label immediately before the try (outside it).
                return BoundBlockStatement(
                    nil,
                    ImmutableArray.Create[BoundStatement](BoundLabelStatement(nil, entryLabel), rebuiltTry)
                )
            }

            protected override func RewriteAwaitExpression(node BoundAwaitExpression) BoundExpression {
                // If we reach here, the await is embedded as a sub-expression
                // in a context we haven't caught at the statement level. The
                // precheck should gate this, but as a safety net return the node.
                return node
            }

            private func EmitPerAwaitSequence(
                awaitExpr BoundAwaitExpression,
                resultTarget VariableSymbol?,
                syntax SyntaxNode? = nil
            ) BoundBlockStatement {
                var syntax = syntax
                if !ctx.awaitResumeMap.TryGetValue(awaitExpr, out var resumePoint) {
                    throw InvalidOperationException("Await expression has no assigned resume state.")
                }
                let shape AwaitableShape? = AwaitableShape.Resolve(awaitExpr.Expression?.Type?.ClrType)
                if shape == nil {
                    throw InvalidOperationException(
                        "Cannot resolve awaitable shape for type '${awaitExpr.Expression?.Type?.Name}'."
                    )
                }
                let awaiterClrType = shape.AwaiterType
                let awaiterTypeSymbol = awaitExpr.AwaiterTypeSymbol ?? TypeSymbol.FromClrTypeWithoutNullability(
                    awaiterClrType,
                    NullabilityFreeReason.EmitShape
                )
                let awaiterLocal = LocalVariableSymbol(
                    "<>awaiter_" + resumePoint.State.ToString(),
                    isReadOnly: false,
                    awaiterTypeSymbol
                )
                ctx.allLocals.Add(awaiterLocal)
                // Get the pooled awaiter field.
                let awaiterField FieldSymbol? = ctx
                    .plan
                    .StateMachine
                    .GetAwaiterPoolField(awaiterClrType, awaiterTypeSymbol)
                if awaiterField == nil {
                    throw InvalidOperationException("No awaiter pool field for type '${awaiterClrType.FullName}'.")
                }
                let stmts = ImmutableArray.CreateBuilder[BoundStatement]()
                // TAwaiter awaiter = <expr>.GetAwaiter();
                let rewrittenOperand = RewriteExpression(
                    Invariant.Required(
                        awaitExpr.Expression,
                        "an await expression has an operand",
                        expression: "awaitExpr.Expression"
                    )
                )
                var getAwaiterReceiver BoundExpression
                let awaitableClrType Type? = awaitExpr.Expression?.Type?.ClrType
                if awaitableClrType != nil && awaitableClrType.IsValueType {
                    // Value-type awaitables require a managed pointer (byref) for the
                    // instance GetAwaiter() call. Spill to a temp local and take address.
                    // Issue #2195: use the operand's SYMBOLIC type (e.g.
                    // `ValueTask[Box]` / `ValueTask[T]`) for the spill temp rather
                    // than its erased CLR type (`ValueTask<object>`). The symbolic
                    // type argument is erased to `object` for a same-compilation
                    // user type or an open type parameter; typing the temp with the
                    // erased shape produced unverifiable IL (a `ValueTask<Box>`
                    // value stored into a `ValueTask<object>` slot) that also failed
                    // to load (`BadImageFormatException`) inside a generic async
                    // lambda closure. The reference-type awaitable path below
                    // already threads the symbolic operand type through unchanged.
                    let awaitableTypeSymbol = awaitExpr.Expression?.Type ?? TypeSymbol.FromClrTypeWithoutNullability(
                        awaitableClrType,
                        NullabilityFreeReason.EmitShape
                    )
                    let tempLocal = LocalVariableSymbol(
                        "<>awaitable_" + resumePoint.State.ToString(),
                        isReadOnly: false,
                        awaitableTypeSymbol
                    )
                    ctx.allLocals.Add(tempLocal)
                    // ADR-0174 P3-8: the first statement of the await sequence
                    // carries the awaiting source statement's anchor, so a
                    // breakpoint on `let v = <-ch` binds inside MoveNext and a
                    // step-over runs from this yield to its resume.
                    stmts.Add(BoundVariableDeclaration(syntax, tempLocal, rewrittenOperand))
                    syntax = nil
                    getAwaiterReceiver = BoundAddressOfExpression(nil, BoundVariableExpression(nil, tempLocal))
                } else {
                    getAwaiterReceiver = rewrittenOperand
                }
                let getAwaiterCall = BoundImportedInstanceCallExpression(
                    nil,
                    getAwaiterReceiver,
                    shape.GetAwaiterMethod,
                    awaiterTypeSymbol,
                    ImmutableArray[BoundExpression].Empty
                )
                stmts.Add(BoundVariableDeclaration(syntax, awaiterLocal, getAwaiterCall))
                // if (awaiter.IsCompleted) goto resumeAfter;
                let isCompletedGetter = shape.IsCompletedProperty.GetGetMethod()
                var isCompletedReceiver BoundExpression
                if awaiterClrType.IsValueType {
                    isCompletedReceiver = BoundAddressOfExpression(nil, BoundVariableExpression(nil, awaiterLocal))
                } else {
                    isCompletedReceiver = BoundVariableExpression(nil, awaiterLocal)
                }
                let isCompletedCall = BoundImportedInstanceCallExpression(
                    nil,
                    isCompletedReceiver,
                    Invariant.Required(
                        isCompletedGetter,
                        "AwaitableShape.Resolve only returns a shape when the awaiter declares a readable IsCompleted",
                        expression: "isCompletedGetter"
                    ),
                    TypeSymbol.Bool,
                    ImmutableArray[BoundExpression].Empty
                )
                stmts.Add(
                    BoundConditionalGotoStatement(nil, resumePoint.ResumeAfterLabel, isCompletedCall, jumpIfTrue: true)
                )
                // === Suspension path ===
                // [AwaitYieldPoint] — hidden sequence point marker before state save.
                stmts.Add(BoundAwaitSequencePoint(nil, BoundNodeKind.AwaitYieldPoint, resumePoint.State))
                // this.<>1__state = K;
                stmts.Add(
                    RewriteContext.Stmt(
                        ctx.WriteField(ctx.plan.FieldMap.StateField, RewriteContext.Literal(resumePoint.State))
                    )
                )
                // cachedState = K;
                stmts.Add(
                    RewriteContext.Stmt(
                        BoundAssignmentExpression(nil, ctx.cachedStateLocal, RewriteContext.Literal(resumePoint.State))
                    )
                )
                // this.<>u__N = awaiter;
                let awaiterToStore BoundExpression = BoundVariableExpression(nil, awaiterLocal)
                if !awaiterClrType.IsValueType {
                    // Reference awaiters stored as-is (field is object, implicit upcast).

                }
                stmts.Add(RewriteContext.Stmt(ctx.WriteField(awaiterField, awaiterToStore)))
                // builder.AwaitUnsafe/OnCompleted<TAwaiter, TSM>(ref awaiter, ref this);
                // Use the special marker node.
                let awaitOnCompletedMarker = BoundStateMachineAwaitOnCompleted(
                    nil,
                    awaiterLocal,
                    awaiterClrType,
                    awaiterTypeSymbol,
                    shape.ImplementsCriticalNotifyCompletion
                )
                stmts.Add(RewriteContext.Stmt(awaitOnCompletedMarker))
                // goto exitLabel;
                stmts.Add(BoundGotoStatement(nil, ctx.plan.MoveNextPlan.ExitLabel))
                // stateK_resume:
                stmts.Add(BoundLabelStatement(nil, resumePoint.ResumeLabel))
                // [AwaitResumePoint] — hidden sequence point marker after resume dispatch.
                stmts.Add(BoundAwaitSequencePoint(nil, BoundNodeKind.AwaitResumePoint, resumePoint.State))
                // awaiter = (TAwaiter)this.<>u__N;
                var reloadedAwaiter = ctx.ReadField(awaiterField)
                if !awaiterClrType.IsValueType {
                    reloadedAwaiter = BoundConversionExpression(nil, awaiterTypeSymbol, reloadedAwaiter)
                }
                stmts.Add(RewriteContext.Stmt(BoundAssignmentExpression(nil, awaiterLocal, reloadedAwaiter)))
                // this.<>u__N = default;
                // Clears the awaiter field to release GC roots. For reference types
                // this emits ldnull;stfld. For value types the emitter uses the
                // optimized ldflda+initobj path via BoundDefaultExpression.
                stmts.Add(
                    RewriteContext.Stmt(ctx.WriteField(awaiterField, BoundDefaultExpression(nil, awaiterTypeSymbol)))
                )
                // this.<>1__state = -1;
                stmts.Add(
                    RewriteContext.Stmt(
                        ctx.WriteField(
                            ctx.plan.FieldMap.StateField,
                            RewriteContext.Literal(StateMachineStates.NotStartedOrRunningState)
                        )
                    )
                )
                // cachedState = -1;
                stmts.Add(
                    RewriteContext.Stmt(
                        BoundAssignmentExpression(
                            nil,
                            ctx.cachedStateLocal,
                            RewriteContext.Literal(StateMachineStates.NotStartedOrRunningState)
                        )
                    )
                )
                // stateK_resume_after:
                stmts.Add(BoundLabelStatement(nil, resumePoint.ResumeAfterLabel))
                // result = awaiter.GetResult();
                var getResultReceiver BoundExpression
                if awaiterClrType.IsValueType {
                    getResultReceiver = BoundAddressOfExpression(nil, BoundVariableExpression(nil, awaiterLocal))
                } else {
                    getResultReceiver = BoundVariableExpression(nil, awaiterLocal)
                }
                let resultType = awaitExpr.Type ?? TypeSymbol.Void
                let getResultCall = BoundImportedInstanceCallExpression(
                    nil,
                    getResultReceiver,
                    shape.GetResultMethod,
                    resultType,
                    ImmutableArray[BoundExpression].Empty
                )
                let hasResult = resultType != TypeSymbol.Void && !resultType.ClrType.IsSameAs(typeof(Void))
                if resultTarget != nil && hasResult {
                    if TryGetHoistedField(resultTarget, out var targetField) {
                        stmts.Add(RewriteContext.Stmt(ctx.WriteField(targetField!!, getResultCall)))
                    } else {
                        stmts.Add(BoundVariableDeclaration(nil, resultTarget, getResultCall))
                    }
                } else {
                    // Discard result (or void GetResult).
                    stmts.Add(RewriteContext.Stmt(getResultCall))
                }
                return BoundBlockStatement(nil, stmts.ToImmutable())
            }

            private func TryGetHoistedField(variable VariableSymbol, @NotNullWhen(true) out field FieldSymbol?) bool {
                // Delegate to the field map's single source of truth (issue
                // #2331) so `this`, ordinary parameters, and locals resolve
                // identically here and at the emitter's closure-construction
                // site (MethodBodyEmitter.Closures.cs' EmitCapturedVariableLoad).
                return ctx.plan.FieldMap.TryGetHoistedField(variable, out field)
            }
        }

        shared {
            private func Literal(value int32) BoundExpression {
                return BoundLiteralExpression(nil, value)
            }

            private func Stmt(expr BoundExpression, syntax SyntaxNode? = nil) BoundExpressionStatement {
                return BoundExpressionStatement(syntax, expr)
            }
        }
    }

    /// Builds the full MoveNext body for the given async state-machine plan.
    /// @param plan The async state machine plan.
    /// @returns The rewritten MoveNext body as a (cref:BoundBlockStatement).
    func Build(plan AsyncStateMachinePlan?) MoveNextBody {
        if plan == nil {
            throw ArgumentNullException("plan")
        }
        let ctx = RewriteContext(plan)
        return ctx.BuildBody()
    }
}
