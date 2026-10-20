// <copyright file="AsyncIteratorMoveNextBodyBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Iterators

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Threading.Tasks.Sources

/// Builds the `MoveNext()` body for an async iterator state machine.
/// Handles both yield (state assignment + SetResult(true) on promise + return)
/// and await (suspension via AwaitOnCompleted, resume via state dispatch).
shared class AsyncIteratorMoveNextBodyBuilder {
    private class BuildContext {
        private let plan AsyncIteratorPlan
        private let smClass StructSymbol
        private let thisParameter ParameterSymbol
        private let stateField FieldSymbol
        private let currentField FieldSymbol
        private let promiseField FieldSymbol
        private let disposeModeField FieldSymbol
        private let disposeExceptionField FieldSymbol
        private let builderField FieldSymbol
        private let fieldMap Dictionary[VariableSymbol, FieldSymbol]
        private let awaiterPoolFields Dictionary[Type, FieldSymbol]
        private let awaitTryDispatch TryDispatchPlan
        private let yieldTryDispatch IteratorTryDispatchPlan
        // Await registration can reenter MoveNext and change the shared state.
        // Finally guards must keep the state of their own invocation.
        private let invocationState LocalVariableSymbol = LocalVariableSymbol(
            "<>ai_invocationState",
            isReadOnly: false,
            TypeSymbol.Int32
        )

        // Labels for yield resume points
        private let yieldResumeLabels Dictionary[int32, BoundLabel] = Dictionary[int32, BoundLabel]()

        // Labels for await resume points
        private let awaitResumeLabels Dictionary[int32, BoundLabel] = Dictionary[int32, BoundLabel]()

        private let awaitResumeAfterLabels Dictionary[int32, BoundLabel] = Dictionary[int32, BoundLabel]()
        private let exitLabel BoundLabel = BoundLabel("<>ai_exit")
        private let yieldResultLabel BoundLabel = BoundLabel("<>ai_yieldResult")
        private let endOfBodyLabel BoundLabel = BoundLabel("<>ai_end")

        init(
            plan AsyncIteratorPlan,
            smClass StructSymbol,
            thisParameter ParameterSymbol,
            stateField FieldSymbol,
            currentField FieldSymbol,
            promiseField FieldSymbol,
            disposeModeField FieldSymbol,
            disposeExceptionField FieldSymbol,
            builderField FieldSymbol,
            fieldMap Dictionary[VariableSymbol, FieldSymbol],
            awaiterPoolFields Dictionary[Type, FieldSymbol]
        ) {
            this.plan = plan
            this.smClass = smClass
            this.thisParameter = thisParameter
            this.stateField = stateField
            this.currentField = currentField
            this.promiseField = promiseField
            this.disposeModeField = disposeModeField
            this.disposeExceptionField = disposeExceptionField
            this.builderField = builderField
            this.fieldMap = fieldMap
            this.awaiterPoolFields = awaiterPoolFields
            // Create resume labels for awaits (non-negative states).
            let awaitResumeMap = Dictionary[BoundAwaitExpression, AwaitResumePoint]()
            for kvp in plan.AwaitStates.OrderBy((p KeyValuePair[BoundAwaitExpression, int32]) -> p.Value) {
                awaitResumeLabels[kvp.Value] = BoundLabel("<>ai_awaitResume_${kvp.Value}")
                awaitResumeAfterLabels[kvp.Value] = BoundLabel("<>ai_awaitAfter_${kvp.Value}")
                awaitResumeMap[kvp.Key] = AwaitResumePoint(
                    kvp.Key,
                    kvp.Value,
                    awaitResumeLabels[kvp.Value],
                    awaitResumeAfterLabels[kvp.Value]
                )
            }
            awaitTryDispatch = TryDispatchPlanner.Plan(plan.LoweredBody, awaitResumeMap)
            yieldTryDispatch = IteratorTryDispatchPlanner.Plan(plan.LoweredBody, plan.YieldStates)
            for kvp in plan.YieldStates.OrderBy((p KeyValuePair[BoundYieldStatement, int32]) -> p.Value) {
                yieldResumeLabels[kvp.Value] = yieldTryDispatch.GetResumeLabel(kvp.Value) ??
                    BoundLabel("<>ai_yieldResume_${kvp.Value}")
            }
        }

        func BuildBody() BoundBlockStatement {
            let stmts = ImmutableArray.CreateBuilder[BoundStatement]()
            stmts.Add(
                BoundVariableDeclaration(nil, invocationState, Literal(StateMachineStates.NotStartedOrRunningState))
            )
            // try {
            //   state dispatch
            //   user body (with yield + await rewritten)
            //   end: state = -2; promise.SetResult(false);
            // } catch (Exception ex) {
            //   state = -2; promise.SetException(ex);
            // }
            let tryBody = BuildTryBody()
            let exLocal = LocalVariableSymbol(
                "<>ex",
                isReadOnly: false,
                TypeSymbol.FromClrTypeWithoutNullability(typeof(Exception), NullabilityFreeReason.TypeLiteral)
            )
            let catchBody = BuildCatchBody(exLocal)
            let catchClause = BoundCatchClause(
                TypeSymbol.FromClrTypeWithoutNullability(typeof(Exception), NullabilityFreeReason.TypeLiteral),
                exLocal,
                catchBody
            )
            let tryStmt = BoundTryStatement(nil, tryBody, ImmutableArray.Create(catchClause), finallyBlock: nil)
            stmts.Add(tryStmt)
            // return; (after try/catch)
            stmts.Add(BoundReturnStatement(nil, nil))
            // Publish only after suspension guards have run. An inline
            // consumer continuation can reenter MoveNext or DisposeAsync.
            stmts.Add(BoundLabelStatement(nil, yieldResultLabel))
            stmts.Add(Stmt(EmitPromiseSetResult(true)))
            stmts.Add(BoundReturnStatement(nil, nil))
            return BoundBlockStatement(nil, stmts.ToImmutable())
        }

        private func BuildTryBody() BoundBlockStatement {
            let stmts = ImmutableArray.CreateBuilder[BoundStatement]()
            // State dispatch: check state and jump to resume labels.
            EmitStateDispatch(stmts)
            stmts.Add(BoundConditionalGotoStatement(nil, endOfBodyLabel, ReadField(disposeModeField), jumpIfTrue: true))
            // Rewritten user body.
            let rewriter = AsyncIteratorMoveNextBodyBuilder.BuildContext.InnerRewriter(this)
            let rewrittenBody = rewriter.RewriteStatement(plan.LoweredBody)
            if rewrittenBody is BoundBlockStatement block {
                stmts.AddRange(block.Statements)
            } else {
                stmts.Add(rewrittenBody)
            }
            // End of body: state = -2; promise.SetResult(false);
            stmts.Add(BoundLabelStatement(nil, endOfBodyLabel))
            stmts.Add(Stmt(WriteField(stateField, Literal(StateMachineStates.FinishedState))))
            stmts.Add(Stmt(EmitPromiseSetResult(false)))
            // Exit label for await suspension.
            stmts.Add(BoundLabelStatement(nil, exitLabel))
            return BoundBlockStatement(nil, stmts.ToImmutable())
        }

        private func EmitStateDispatch(stmts ImmutableArray[BoundStatement].Builder) {
            let stateRead = ReadField(stateField)
            // For each yield resume state (negative): if state == K goto yieldResumeK
            for kvp in plan.YieldStates.OrderBy((p KeyValuePair[BoundYieldStatement, int32]) -> p.Value) {
                let state = kvp.Value
                stmts.Add(
                    BoundConditionalGotoStatement(
                        nil,
                        yieldTryDispatch.GetOuterDispatchTarget(state) ?? yieldResumeLabels[state],
                        BoundBinaryExpression(
                            nil,
                            stateRead,
                            Invariant.Required(
                                BoundBinaryOperator.Bind(
                                    SyntaxKind.EqualsEqualsToken,
                                    TypeSymbol.Int32,
                                    TypeSymbol.Int32
                                ),
                                "int32 equality operator exists for async iterator state dispatch",
                                expression: "BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32)"
                            ),
                            Literal(state)
                        ),
                        jumpIfTrue: true
                    )
                )
            }
            // For each await resume state (non-negative): if state == K goto awaitResumeK
            for kvp in plan.AwaitStates.OrderBy((p KeyValuePair[BoundAwaitExpression, int32]) -> p.Value) {
                let state = kvp.Value
                stmts.Add(
                    BoundConditionalGotoStatement(
                        nil,
                        awaitTryDispatch.GetOuterDispatchTarget(state) ?? awaitResumeLabels[state],
                        BoundBinaryExpression(
                            nil,
                            ReadField(stateField),
                            Invariant.Required(
                                BoundBinaryOperator.Bind(
                                    SyntaxKind.EqualsEqualsToken,
                                    TypeSymbol.Int32,
                                    TypeSymbol.Int32
                                ),
                                "int32 equality operator exists for async iterator state dispatch",
                                expression: "BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32)"
                            ),
                            Literal(state)
                        ),
                        jumpIfTrue: true
                    )
                )
            }
        }

        private func BuildCatchBody(exLocal LocalVariableSymbol) BoundBlockStatement {
            let stmts = ImmutableArray.CreateBuilder[BoundStatement]()
            // state = -2;
            stmts.Add(Stmt(WriteField(stateField, Literal(StateMachineStates.FinishedState))))
            let exceptionType = TypeSymbol.FromClrTypeWithoutNullability(
                typeof(Exception),
                NullabilityFreeReason.TypeLiteral
            )
            let isDisposeException = BoundBinaryExpression(
                nil,
                BoundVariableExpression(nil, exLocal),
                BoundBinaryOperator.MakeReferenceEquality(SyntaxKind.EqualsEqualsToken, exceptionType, exceptionType),
                ReadField(disposeExceptionField)
            )
            let completingDispose = BoundBinaryExpression(
                nil,
                ReadField(disposeModeField),
                Invariant.Required(
                    BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool),
                    "boolean conjunction operator exists for async iterator disposal",
                    expression: `BoundBinaryOperator.Bind(
                        SyntaxKind.AmpersandAmpersandToken,
                        TypeSymbol.Bool,
                        TypeSymbol.Bool)`
                ),
                isDisposeException
            )
            let promiseFieldType = typeof(ManualResetValueTaskSourceCore[bool])
            let setExceptionMethod = promiseFieldType.GetMethod("SetException", []Type{typeof(Exception)})
            let promiseAddr = BoundAddressOfExpression(
                nil,
                BoundFieldAccessExpression(nil, BoundVariableExpression(nil, thisParameter), smClass, promiseField)
            )
            let call = BoundImportedInstanceCallExpression(
                nil,
                promiseAddr,
                Invariant.Required(
                    setExceptionMethod,
                    "an async-iterator MoveNext body is only built for a builder that passed AsyncMethodBuilderInfo.IsValid, and the iterator rewriter binds SetException itself",
                    expression: "setExceptionMethod"
                ),
                TypeSymbol.Void,
                ImmutableArray.Create[BoundExpression](BoundVariableExpression(nil, exLocal))
            )
            stmts.Add(BoundIfStatement(nil, completingDispose, Stmt(EmitPromiseSetResult(false)), Stmt(call)))
            return BoundBlockStatement(nil, stmts.ToImmutable())
        }

        private func EmitPromiseSetResult(value bool) BoundExpression {
            let promiseFieldType = typeof(ManualResetValueTaskSourceCore[bool])
            let setResultMethod = promiseFieldType.GetMethod("SetResult", []Type{typeof(bool)})
            let promiseAddr = BoundAddressOfExpression(
                nil,
                BoundFieldAccessExpression(nil, BoundVariableExpression(nil, thisParameter), smClass, promiseField)
            )
            return BoundImportedInstanceCallExpression(
                nil,
                promiseAddr,
                Invariant.Required(
                    setResultMethod,
                    "an async-iterator MoveNext body is only built for a builder that passed AsyncMethodBuilderInfo.IsValid, and the iterator rewriter binds SetResult itself",
                    expression: "setResultMethod"
                ),
                TypeSymbol.Void,
                ImmutableArray.Create[BoundExpression](BoundLiteralExpression(nil, value))
            )
        }

        private func ReadField(field FieldSymbol) BoundExpression {
            return BoundFieldAccessExpression(nil, BoundVariableExpression(nil, thisParameter), smClass, field)
        }

        private func WriteField(field FieldSymbol, value BoundExpression) BoundExpression {
            let storedValue BoundExpression = if object.ReferenceEquals(field, stateField) {
                BoundAssignmentExpression(nil, invocationState, value)
            } else {
                value
            }
            return BoundFieldAssignmentExpression(nil, thisParameter, smClass, field, storedValue)
        }

        /// Walks the user body, replacing yields, awaits, variable accesses (hoisted to fields),
        /// and returns.
        private class InnerRewriter : HoistedFieldRewriter {
            private let ctx BuildContext
            private var yieldIndex int32

            init(ctx BuildContext) : base(ctx.smClass, ctx.thisParameter, ctx.fieldMap) {
                this.ctx = ctx
            }

            protected override func RewriteVariableDeclaration(node BoundVariableDeclaration) BoundStatement {
                if node.Initializer is BoundAwaitExpression awaitExpr {
                    return EmitPerAwaitSequence(awaitExpr, node.Variable)
                }
                let rewrittenInit BoundExpression? = if node.Initializer != nil {
                    RewriteExpression(node.Initializer)
                } else {
                    default(BoundExpression?)
                }
                if ctx.fieldMap.TryGetValue(node.Variable, out var field) {
                    if rewrittenInit != nil {
                        return BuildContext.Stmt(ctx.WriteField(field, rewrittenInit))
                    }
                    return BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
                }
                if rewrittenInit != node.Initializer {
                    return BoundVariableDeclaration(nil, node.Variable, rewrittenInit, node.ConstantValue)
                }
                return node
            }

            protected override func RewriteYieldStatement(node BoundYieldStatement) BoundStatement {
                yieldIndex++
                var yieldState = ctx.plan.YieldStates.Values.OrderBy((v int32) -> v).Reverse().ElementAt(yieldIndex - 1)
                // Find the matching BoundYieldStatement in the plan.
                var matchedYield BoundYieldStatement? = nil
                for kvp in ctx.plan.YieldStates {
                    if kvp.Value == yieldState && object.ReferenceEquals(kvp.Key, node) {
                        matchedYield = kvp.Key
                        break
                    }
                }
                // Fallback: use ordered iteration matching.
                if matchedYield == nil {
                    var idx = 0
                    for kvp in ctx
                        .plan
                        .YieldStates
                        .OrderBy((kv KeyValuePair[BoundYieldStatement, int32]) -> kv.Value)
                        .Reverse() {
                        idx++
                        if idx == yieldIndex {
                            yieldState = kvp.Value
                            break
                        }
                    }
                }
                let stmts = ImmutableArray.CreateBuilder[BoundStatement]()
                let rewrittenExpr = RewriteExpression(node.Expression)
                // this.<>2__current = expr;
                stmts.Add(BuildContext.Stmt(ctx.WriteField(ctx.currentField, rewrittenExpr)))
                // this.<>1__state = yieldState;
                stmts.Add(BuildContext.Stmt(ctx.WriteField(ctx.stateField, BuildContext.Literal(yieldState))))
                stmts.Add(BoundGotoStatement(nil, ctx.yieldResultLabel))
                // yieldResumeK:
                stmts.Add(BoundLabelStatement(nil, ctx.yieldResumeLabels[yieldState]))
                // this.<>1__state = -1;
                stmts.Add(
                    BuildContext.Stmt(
                        ctx.WriteField(
                            ctx.stateField,
                            BuildContext.Literal(StateMachineStates.NotStartedOrRunningState)
                        )
                    )
                )
                let disposeException = BoundClrConstructorCallExpression(
                    nil,
                    typeof(Exception),
                    Invariant.Required(
                        typeof(Exception).GetConstructor(Type.EmptyTypes),
                        "System.Exception declares a public parameterless constructor",
                        expression: "typeof(Exception).GetConstructor(Type.EmptyTypes)"
                    ),
                    ImmutableArray[BoundExpression].Empty,
                    TypeSymbol.FromClrTypeWithoutNullability(typeof(Exception), NullabilityFreeReason.TypeLiteral)
                )
                let throwDispose = BoundBlockStatement(
                    nil,
                    ImmutableArray.Create[BoundStatement](
                        BuildContext.Stmt(ctx.WriteField(ctx.disposeExceptionField, disposeException)),
                        BoundThrowStatement(nil, ctx.ReadField(ctx.disposeExceptionField))
                    )
                )
                stmts.Add(BoundIfStatement(nil, ctx.ReadField(ctx.disposeModeField), throwDispose, elseStatement: nil))
                return BoundBlockStatement(nil, stmts.ToImmutable())
            }

            protected override func RewriteExpressionStatement(node BoundExpressionStatement) BoundStatement {
                if node.Expression is BoundAwaitExpression awaitExpr {
                    return EmitPerAwaitSequence(awaitExpr, resultTarget: nil)
                }
                if node.Expression is BoundAssignmentExpression assign &&
                    assign.Expression is BoundAwaitExpression assignAwait {
                    return EmitPerAwaitSequence(assignAwait, resultTarget: assign.Variable)
                }
                return base.RewriteExpressionStatement(node)
            }

            protected override func RewriteTryStatement(node BoundTryStatement) BoundStatement {
                // Issue #2662: the newly exposed await-for awaits and yields
                // can resume inside protected regions. Route them through the
                // same outside-entry/inside-dispatch topology as ordinary
                // async methods and synchronous iterators.
                let result = cast[BoundTryStatement](base.RewriteTryStatement(node))
                let awaitEntries = ctx.awaitTryDispatch.GetInternalDispatchEntries(node)
                let yieldEntries = ctx.yieldTryDispatch.GetInternalDispatchEntries(node)
                let awaitEntryLabel BoundLabel? = ctx.awaitTryDispatch.GetEntryLabel(node)
                let yieldEntryLabel BoundLabel? = ctx.yieldTryDispatch.GetEntryLabel(node)
                if awaitEntries.IsDefaultOrEmpty &&
                    yieldEntries.IsDefaultOrEmpty &&
                    awaitEntryLabel == nil &&
                    yieldEntryLabel == nil {
                    return result
                }
                let tryStatements = ImmutableArray.CreateBuilder[BoundStatement]()
                for entry in awaitEntries {
                    tryStatements.Add(DispatchTo(entry.State, entry.Target))
                }
                for entry in yieldEntries {
                    tryStatements.Add(DispatchTo(entry.State, entry.Target))
                }
                if result.TryBlock is BoundBlockStatement block {
                    tryStatements.AddRange(block.Statements)
                } else {
                    tryStatements.Add(result.TryBlock)
                }
                let rebuilt = BoundTryStatement(
                    nil,
                    BoundBlockStatement(nil, tryStatements.ToImmutable()),
                    result.CatchClauses,
                    GuardFinally(result.FinallyBlock, awaitEntries, yieldEntries)
                )
                if awaitEntryLabel == nil && yieldEntryLabel == nil {
                    return rebuilt
                }
                let statements = ImmutableArray.CreateBuilder[BoundStatement]()
                if awaitEntryLabel != nil {
                    statements.Add(BoundLabelStatement(nil, awaitEntryLabel))
                }
                if yieldEntryLabel != nil && !object.ReferenceEquals(yieldEntryLabel, awaitEntryLabel) {
                    statements.Add(BoundLabelStatement(nil, yieldEntryLabel))
                }
                statements.Add(rebuilt)
                return BoundBlockStatement(nil, statements.ToImmutable())
            }

            protected override func RewriteAwaitExpression(node BoundAwaitExpression) BoundExpression {
                // If we reach here, await is nested. Should have been lifted by spiller.
                return node
            }

            protected override func RewriteReturnStatement(node BoundReturnStatement) BoundStatement {
                // In an async iterator, `return` means end iteration.
                return BoundGotoStatement(nil, ctx.endOfBodyLabel)
            }

            private func GuardFinally(
                finallyBlock BoundStatement?,
                awaitEntries ImmutableArray[TryDispatchEntry],
                yieldEntries ImmutableArray[IteratorTryDispatchEntry]
            ) BoundStatement? {
                if finallyBlock == nil {
                    return nil
                }
                var suspended BoundExpression? = nil
                for entry in awaitEntries {
                    suspended = AddSuspendedState(suspended, entry.State)
                }
                for entry in yieldEntries {
                    suspended = AddSuspendedState(suspended, entry.State)
                }
                if suspended == nil {
                    return finallyBlock
                }
                let notSuspended = BoundUnaryExpression(
                    nil,
                    Invariant.Required(
                        BoundUnaryOperator.Bind(SyntaxKind.BangToken, TypeSymbol.Bool),
                        "the built-in operator table always binds `!` on bool",
                        expression: "BoundUnaryOperator.Bind(SyntaxKind.BangToken, TypeSymbol.Bool)"
                    ),
                    suspended
                )
                return BoundBlockStatement(
                    nil,
                    ImmutableArray.Create[BoundStatement](
                        BoundIfStatement(nil, notSuspended, finallyBlock, elseStatement: nil)
                    )
                )
            }

            private func AddSuspendedState(condition BoundExpression?, state int32) BoundExpression {
                let equalsState = BoundBinaryExpression(
                    nil,
                    BoundVariableExpression(nil, ctx.invocationState),
                    Invariant.Required(
                        BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                        "int32 equality operator exists for async iterator state dispatch",
                        expression: `BoundBinaryOperator.Bind(
                            SyntaxKind.EqualsEqualsToken,
                            TypeSymbol.Int32,
                            TypeSymbol.Int32)`
                    ),
                    BuildContext.Literal(state)
                )
                return if condition == nil {
                    equalsState
                } else {
                    BoundBinaryExpression(
                        nil,
                        condition,
                        Invariant.Required(
                            BoundBinaryOperator.Bind(SyntaxKind.PipePipeToken, TypeSymbol.Bool, TypeSymbol.Bool),
                            "boolean disjunction operator exists for async iterator state dispatch",
                            expression: `BoundBinaryOperator.Bind(
                                SyntaxKind.PipePipeToken,
                                TypeSymbol.Bool,
                                TypeSymbol.Bool)`
                        ),
                        equalsState
                    )
                }
            }

            private func DispatchTo(state int32, target BoundLabel) BoundConditionalGotoStatement {
                let condition = BoundBinaryExpression(
                    nil,
                    ctx.ReadField(ctx.stateField),
                    Invariant.Required(
                        BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                        "int32 equality operator exists for async iterator state dispatch",
                        expression: "BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32)"
                    ),
                    BuildContext.Literal(state)
                )
                return BoundConditionalGotoStatement(nil, target, condition, jumpIfTrue: true)
            }

            private func EmitPerAwaitSequence(
                awaitExpr BoundAwaitExpression,
                resultTarget VariableSymbol?
            ) BoundBlockStatement {
                if !ctx.plan.AwaitStates.TryGetValue(awaitExpr, out var awaitState) {
                    throw InvalidOperationException("Await expression has no assigned state.")
                }
                let shape AwaitableShape? = AwaitableShape.Resolve(awaitExpr.Expression?.Type?.ClrType)
                if shape == nil {
                    throw InvalidOperationException(
                        "Cannot resolve awaitable shape for type '${awaitExpr.Expression?.Type?.Name}'."
                    )
                }
                let awaiterClrType = shape.AwaiterType
                let awaiterTypeSymbol = TypeSymbol.FromClrTypeWithoutNullability(
                    awaiterClrType,
                    NullabilityFreeReason.EmitShape
                )
                // Get the pooled awaiter field.
                let poolKey = if awaiterClrType.IsValueType {
                    awaiterClrType
                } else {
                    typeof(object)
                }
                if !ctx.awaiterPoolFields.TryGetValue(poolKey, out var awaiterField) {
                    throw InvalidOperationException("No awaiter pool field for type '${awaiterClrType.FullName}'.")
                }
                let resumeLabel = ctx.awaitResumeLabels[awaitState]
                let resumeAfterLabel = ctx.awaitResumeAfterLabels[awaitState]
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
                    let awaitableTypeSymbol = TypeSymbol.FromClrTypeWithoutNullability(
                        awaitableClrType,
                        NullabilityFreeReason.EmitShape
                    )
                    let tempLocal = LocalVariableSymbol(
                        "<>awaitable_" + awaitState.ToString(),
                        isReadOnly: false,
                        awaitableTypeSymbol
                    )
                    stmts.Add(BoundVariableDeclaration(nil, tempLocal, rewrittenOperand))
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
                let awaiterLocal = LocalVariableSymbol(
                    "<>awaiter_" + awaitState.ToString(),
                    isReadOnly: false,
                    awaiterTypeSymbol
                )
                stmts.Add(BoundVariableDeclaration(nil, awaiterLocal, getAwaiterCall))
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
                stmts.Add(BoundConditionalGotoStatement(nil, resumeAfterLabel, isCompletedCall, jumpIfTrue: true))
                // === Suspension path ===
                // [AwaitYieldPoint] — hidden sequence point marker before state save.
                stmts.Add(BoundAwaitSequencePoint(nil, BoundNodeKind.AwaitYieldPoint, awaitState))
                // this.<>1__state = awaitState;
                stmts.Add(BuildContext.Stmt(ctx.WriteField(ctx.stateField, BuildContext.Literal(awaitState))))
                // this.<>u__N = awaiter;
                stmts.Add(BuildContext.Stmt(ctx.WriteField(awaiterField, BoundVariableExpression(nil, awaiterLocal))))
                // builder.AwaitUnsafe/OnCompleted(ref awaiter, ref this);
                let awaitOnCompletedMarker = BoundStateMachineAwaitOnCompleted(
                    nil,
                    awaiterLocal,
                    awaiterClrType,
                    TypeSymbol.FromClrTypeWithoutNullability(awaiterClrType, NullabilityFreeReason.EmitShape),
                    shape.ImplementsCriticalNotifyCompletion
                )
                stmts.Add(BuildContext.Stmt(awaitOnCompletedMarker))
                // goto exit;
                stmts.Add(BoundGotoStatement(nil, ctx.exitLabel))
                // resumeLabel:
                stmts.Add(BoundLabelStatement(nil, resumeLabel))
                // [AwaitResumePoint] — hidden sequence point marker after resume dispatch.
                stmts.Add(BoundAwaitSequencePoint(nil, BoundNodeKind.AwaitResumePoint, awaitState))
                // awaiter = this.<>u__N;
                var reloadedAwaiter = ctx.ReadField(awaiterField)
                if !awaiterClrType.IsValueType {
                    reloadedAwaiter = BoundConversionExpression(nil, awaiterTypeSymbol, reloadedAwaiter)
                }
                stmts.Add(BuildContext.Stmt(BoundAssignmentExpression(nil, awaiterLocal, reloadedAwaiter)))
                // this.<>u__N = default;
                stmts.Add(
                    BuildContext.Stmt(ctx.WriteField(awaiterField, BoundDefaultExpression(nil, awaiterTypeSymbol)))
                )
                // this.<>1__state = -1;
                stmts.Add(
                    BuildContext.Stmt(
                        ctx.WriteField(
                            ctx.stateField,
                            BuildContext.Literal(StateMachineStates.NotStartedOrRunningState)
                        )
                    )
                )
                // resumeAfterLabel:
                stmts.Add(BoundLabelStatement(nil, resumeAfterLabel))
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
                    if ctx.fieldMap.TryGetValue(resultTarget, out var targetField) {
                        stmts.Add(BuildContext.Stmt(ctx.WriteField(targetField, getResultCall)))
                    } else {
                        stmts.Add(BoundVariableDeclaration(nil, resultTarget, getResultCall))
                    }
                } else {
                    stmts.Add(BuildContext.Stmt(getResultCall))
                }
                return BoundBlockStatement(nil, stmts.ToImmutable())
            }
        }

        shared {
            private func Literal(value int32) BoundExpression -> BoundLiteralExpression(nil, value)

            private func Stmt(expr BoundExpression) BoundExpressionStatement -> BoundExpressionStatement(nil, expr)
        }
    }

    /// Builds the MoveNext body for an async iterator.
    func Build(
        plan AsyncIteratorPlan,
        smClass StructSymbol,
        thisParameter ParameterSymbol,
        stateField FieldSymbol,
        currentField FieldSymbol,
        promiseField FieldSymbol,
        disposeModeField FieldSymbol,
        disposeExceptionField FieldSymbol,
        builderField FieldSymbol,
        fieldMap Dictionary[VariableSymbol, FieldSymbol],
        awaiterPoolFields Dictionary[Type, FieldSymbol]
    ) BoundBlockStatement {
        let ctx = BuildContext(
            plan,
            smClass,
            thisParameter,
            stateField,
            currentField,
            promiseField,
            disposeModeField,
            disposeExceptionField,
            builderField,
            fieldMap,
            awaiterPoolFields
        )
        return ctx.BuildBody()
    }
}
