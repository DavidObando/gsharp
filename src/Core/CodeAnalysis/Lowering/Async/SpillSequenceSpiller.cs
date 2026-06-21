// <copyright file="SpillSequenceSpiller.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Rewrites an async method body so that every <see cref="BoundAwaitExpression"/>
/// appears only at statement top-level — either as a <see cref="BoundExpressionStatement"/>
/// or as the RHS of a <see cref="BoundVariableDeclaration"/> (or assignment to a spill temp).
/// Sub-expressions whose values must survive an await are lifted into spill locals.
/// After this pass, <see cref="MoveNextBodyRewriter"/> can process every await as
/// a simple top-level statement without concern for evaluation order of siblings.
/// </summary>
/// <remarks>
/// <para>This implementation handles:
/// <list type="bullet">
/// <item><description>Binary expressions (arithmetic/comparison) with await in either operand.</description></item>
/// <item><description>Short-circuit operators (<c>&amp;&amp;</c>, <c>||</c>) with await on the right.</description></item>
/// <item><description>Method calls (user, imported, imported-instance) with await in arguments.</description></item>
/// <item><description>Variable declarations and return statements with nested await.</description></item>
/// <item><description>Conversion expressions wrapping an await.</description></item>
/// </list></para>
/// <para>Deferred cases (emit a diagnostic if encountered):
/// <list type="bullet">
/// <item><description>Ref/out arguments containing await.</description></item>
/// <item><description>Value-type receivers of instance methods containing await in arguments.</description></item>
/// </list></para>
/// </remarks>
public static class SpillSequenceSpiller
{
    /// <summary>
    /// Rewrites <paramref name="body"/> so that all awaits are at statement top-level.
    /// </summary>
    /// <param name="body">The lowered async method body.</param>
    /// <returns>The spilled body (no <see cref="BoundSpillSequenceExpression"/> nodes survive).</returns>
    public static BoundBlockStatement Rewrite(BoundBlockStatement body)
    {
        if (body == null || !AsyncBoundTreeQueries.HasAwait(body))
        {
            return body;
        }

        var spiller = new Spiller();
        var result = spiller.RewriteBlock(body);
        return result;
    }

    private sealed class Spiller
    {
        private int spillOrdinal;

        public BoundBlockStatement RewriteBlock(BoundBlockStatement block)
        {
            var builder = ImmutableArray.CreateBuilder<BoundStatement>();
            var changed = false;

            foreach (var statement in block.Statements)
            {
                var rewritten = RewriteStatementToList(statement, builder);
                if (rewritten)
                {
                    changed = true;
                }
            }

            if (!changed)
            {
                return block;
            }

            return new BoundBlockStatement(null, builder.ToImmutable());
        }

        /// <summary>
        /// Rewrites a statement, flattening any spill sequences into the builder.
        /// Returns true if anything changed.
        /// </summary>
        private bool RewriteStatementToList(BoundStatement statement, ImmutableArray<BoundStatement>.Builder builder)
        {
            switch (statement)
            {
                case BoundVariableDeclaration decl:
                    return RewriteVariableDeclaration(decl, builder);

                case BoundExpressionStatement exprStmt:
                    return RewriteExpressionStatement(exprStmt, builder);

                case BoundReturnStatement ret:
                    return RewriteReturnStatement(ret, builder);

                case BoundIfStatement ifStmt:
                    return RewriteIfStatement(ifStmt, builder);

                case BoundTryStatement tryStmt:
                    return RewriteTryStatement(tryStmt, builder);

                case BoundBlockStatement nested:
                    var rewritten = RewriteBlock(nested);
                    builder.Add(rewritten);
                    return rewritten != nested;

                // Statements that are await-free leaves at this point in the pipeline.
                // Each is either structurally unable to contain a BoundExpression child,
                // or its expressions have been pre-spilled / lowered away by an earlier pass
                // (AsyncExceptionHandlerRewriter, Lowerer, iterator rewriter).
                case BoundLabelStatement:
                case BoundGotoStatement:
                case BoundConditionalGotoStatement:
                case BoundThrowStatement:
                case BoundScopeStatement:
                case BoundChannelSendStatement:
                case BoundGoStatement:
                case BoundSelectStatement:
                case BoundPatternSwitchStatement:
                case BoundAwaitSequencePoint:
                case BoundYieldStatement:
                    builder.Add(statement);
                    return false;

                default:
                    EmitDiagnosticException.Throw(
                        statement.Syntax,
                        $"SpillSequenceSpiller: unhandled BoundStatement kind '{statement.Kind}'.");
                    return false; // unreachable
            }
        }

        private bool RewriteVariableDeclaration(BoundVariableDeclaration decl, ImmutableArray<BoundStatement>.Builder builder)
        {
            if (decl.Initializer == null || !AsyncBoundTreeQueries.HasAwait(decl.Initializer))
            {
                builder.Add(decl);
                return false;
            }

            var spilled = SpillExpression(decl.Initializer);
            FlushSideEffects(spilled, builder);
            builder.Add(new BoundVariableDeclaration(null, decl.Variable, spilled.Value));
            return true;
        }

        private bool RewriteExpressionStatement(BoundExpressionStatement exprStmt, ImmutableArray<BoundStatement>.Builder builder)
        {
            if (!AsyncBoundTreeQueries.HasAwait(exprStmt.Expression))
            {
                builder.Add(exprStmt);
                return false;
            }

            // If the expression is already a top-level await, no spilling needed.
            if (exprStmt.Expression is BoundAwaitExpression)
            {
                builder.Add(exprStmt);
                return false;
            }

            // If it's an assignment where the RHS is a direct await, no spilling needed.
            if (exprStmt.Expression is BoundAssignmentExpression assign && assign.Expression is BoundAwaitExpression)
            {
                builder.Add(exprStmt);
                return false;
            }

            var spilled = SpillExpression(exprStmt.Expression);
            FlushSideEffects(spilled, builder);
            if (spilled.Value is not BoundLiteralExpression)
            {
                builder.Add(new BoundExpressionStatement(null, spilled.Value));
            }

            return true;
        }

        private bool RewriteReturnStatement(BoundReturnStatement ret, ImmutableArray<BoundStatement>.Builder builder)
        {
            if (ret.Expression == null || !AsyncBoundTreeQueries.HasAwait(ret.Expression))
            {
                builder.Add(ret);
                return false;
            }

            // Always spill: even a direct `return await X` must be lifted into
            // `var __tmp = await X; return __tmp` so MoveNextBodyRewriter can
            // recognize the await as a top-level variable-declaration shape.
            // Leaving a BoundAwaitExpression as the direct return expression
            // would leak an un-rewritten await to the emitter (issue #132).
            var spilled = SpillExpression(ret.Expression);
            FlushSideEffects(spilled, builder);
            builder.Add(new BoundReturnStatement(null, spilled.Value));
            return true;
        }

        private bool RewriteIfStatement(BoundIfStatement ifStmt, ImmutableArray<BoundStatement>.Builder builder)
        {
            // Spill the condition if it contains an await.
            BoundExpression condition = ifStmt.Condition;
            var conditionChanged = false;

            if (AsyncBoundTreeQueries.HasAwait(condition))
            {
                var spilledCond = SpillExpression(condition);
                FlushSideEffects(spilledCond, builder);
                condition = spilledCond.Value;
                conditionChanged = true;
            }

            // Recursively rewrite branches.
            var thenBuilder = ImmutableArray.CreateBuilder<BoundStatement>();
            var thenChanged = RewriteStatementToList(ifStmt.ThenStatement, thenBuilder);
            var thenStmt = thenChanged
                ? (thenBuilder.Count == 1 ? thenBuilder[0] : new BoundBlockStatement(null, thenBuilder.ToImmutable()))
                : ifStmt.ThenStatement;

            BoundStatement elseStmt = ifStmt.ElseStatement;
            var elseChanged = false;
            if (elseStmt != null)
            {
                var elseBuilder = ImmutableArray.CreateBuilder<BoundStatement>();
                elseChanged = RewriteStatementToList(elseStmt, elseBuilder);
                if (elseChanged)
                {
                    elseStmt = elseBuilder.Count == 1 ? elseBuilder[0] : new BoundBlockStatement(null, elseBuilder.ToImmutable());
                }
            }

            if (!conditionChanged && !thenChanged && !elseChanged)
            {
                builder.Add(ifStmt);
                return false;
            }

            builder.Add(new BoundIfStatement(null, condition, thenStmt, elseStmt));
            return true;
        }

        /// <summary>
        /// Spills sub-expression awaits nested inside a <see cref="BoundTryStatement"/>'s
        /// protected block (and, defensively, its handler/finally blocks). Awaits in the
        /// try body are legal suspension points that <see cref="MoveNextBodyRewriter"/>
        /// handles once they sit at statement top-level, but they only reach that form
        /// if the spiller descends into the try region. Treating the try as an opaque
        /// await-free leaf (the prior behaviour) left a sub-expression await such as
        /// <c>F(await G())</c> unspilled, leaking a <see cref="BoundAwaitExpression"/>
        /// into the emitted MoveNext body.
        /// </summary>
        private bool RewriteTryStatement(BoundTryStatement tryStmt, ImmutableArray<BoundStatement>.Builder builder)
        {
            var tryBlock = RewriteNestedBody(tryStmt.TryBlock, out var tryChanged);

            var catchesChanged = false;
            var catchBuilder = ImmutableArray.CreateBuilder<BoundCatchClause>(tryStmt.CatchClauses.Length);
            foreach (var clause in tryStmt.CatchClauses)
            {
                var body = RewriteNestedBody(clause.Body, out var clauseChanged);
                catchesChanged |= clauseChanged;
                catchBuilder.Add(clauseChanged
                    ? new BoundCatchClause(clause.ExceptionType, clause.Variable, body)
                    : clause);
            }

            var finallyBlock = RewriteNestedBody(tryStmt.FinallyBlock, out var finallyChanged);

            if (!tryChanged && !catchesChanged && !finallyChanged)
            {
                builder.Add(tryStmt);
                return false;
            }

            builder.Add(new BoundTryStatement(
                tryStmt.Syntax,
                tryBlock,
                catchesChanged ? catchBuilder.ToImmutable() : tryStmt.CatchClauses,
                finallyBlock));
            return true;
        }

        /// <summary>
        /// Spills a try/catch/finally sub-block. Returns the rewritten body and
        /// reports whether anything changed.
        /// </summary>
        private BoundStatement RewriteNestedBody(BoundStatement body, out bool changed)
        {
            if (body == null)
            {
                changed = false;
                return null;
            }

            if (body is BoundBlockStatement block)
            {
                var rewritten = RewriteBlock(block);
                changed = !ReferenceEquals(rewritten, block);
                return rewritten;
            }

            var nestedBuilder = ImmutableArray.CreateBuilder<BoundStatement>();
            changed = RewriteStatementToList(body, nestedBuilder);
            if (!changed)
            {
                return body;
            }

            return nestedBuilder.Count == 1
                ? nestedBuilder[0]
                : new BoundBlockStatement(body.Syntax, nestedBuilder.ToImmutable());
        }

        /// <summary>
        /// Core spilling: recursively visit an expression, returning a
        /// <see cref="BoundSpillSequenceExpression"/> whose Value has no
        /// embedded awaits (they've all been lifted out as side-effect statements).
        /// If the expression has no awaits, returns a trivial spill sequence.
        /// </summary>
        private BoundSpillSequenceExpression SpillExpression(BoundExpression expression)
        {
            switch (expression)
            {
                case BoundAwaitExpression awaitExpr:
                    return SpillAwait(awaitExpr);

                case BoundBinaryExpression binary:
                    return SpillBinary(binary);

                case BoundCallExpression call:
                    return SpillCall(call);

                case BoundConstrainedStaticCallExpression cstatic:
                    return SpillConstrainedStaticCall(cstatic);

                case BoundImportedCallExpression importedCall:
                    return SpillImportedCall(importedCall);

                case BoundImportedInstanceCallExpression instanceCall:
                    return SpillImportedInstanceCall(instanceCall);

                case BoundConversionExpression conv:
                    return SpillConversion(conv);

                case BoundAssignmentExpression assign:
                    return SpillAssignment(assign);

                case BoundFieldAssignmentExpression fieldAssign:
                    return SpillFieldAssignment(fieldAssign);

                case BoundIndexAssignmentExpression indexAssign:
                    return SpillIndexAssignment(indexAssign);

                case BoundUnaryExpression unary:
                    return SpillUnary(unary);

                case BoundUserInstanceCallExpression userInstance:
                    return SpillUserInstanceCall(userInstance);
                case BoundBaseInterfaceCallExpression baseInterface:
                    return SpillBaseInterfaceCall(baseInterface);

                case BoundBlockExpression block:
                    return SpillBlockExpression(block);

                // Expression kinds that are trivial for spilling — they are either
                // leaf nodes (no BoundExpression children that could contain an await)
                // or their children are structurally unable to hold an await at this
                // point in the pipeline. If HasAwait(expression) returned true at the
                // caller but control reaches here, a spiller blind spot exists for
                // this kind. The throw in the default arm surfaces it as a GS9998
                // instead of silently producing invalid IL.
                case BoundLiteralExpression:
                case BoundVariableExpression:
                case BoundDefaultExpression:
                case BoundTypeOfExpression:
                case BoundMethodGroupExpression:
                case BoundClrMethodGroupExpression:
                case BoundFunctionLiteralExpression:
                case BoundErrorExpression:
                case BoundAddressOfExpression:
                case BoundDereferenceExpression:
                case BoundIndirectAssignmentExpression:
                case BoundConditionalAddressExpression:
                case BoundConditionalExpression:
                case BoundClrStaticCallExpression:
                case BoundClrConstructorCallExpression:
                case BoundClrPropertyAccessExpression:
                case BoundClrPropertyAssignmentExpression:
                case BoundClrBinaryOperatorExpression:
                case BoundClrUnaryOperatorExpression:
                case BoundClrConversionCallExpression:
                case BoundClrIndexExpression:
                case BoundClrIndexAssignmentExpression:
                case BoundClrEventSubscriptionExpression:
                case BoundEventSubscriptionExpression:
                case BoundConstructorCallExpression:
                case BoundConstructorChainingExpression:
                case BoundFieldAccessExpression:
                case BoundPropertyAccessExpression:
                case BoundPropertyAssignmentExpression:
                case BoundNullConditionalAccessExpression:
                case BoundTupleLiteralExpression:
                case BoundTupleElementAccessExpression:
                case BoundIndirectCallExpression:
                case BoundInterpolatedStringExpression:
                case BoundIndexExpression:
                case BoundArrayCreationExpression:
                case BoundLenExpression:
                case BoundCapExpression:
                case BoundAppendExpression:
                case BoundStructLiteralExpression:
                case BoundSwitchExpression:
                case BoundMakeChannelExpression:
                case BoundChannelReceiveExpression:
                case BoundChannelCloseExpression:
                case BoundMapLiteralExpression:
                case BoundMapDeleteExpression:
                case BoundSpillSequenceExpression:
                case BoundStateMachineAwaitOnCompleted:
                case BoundStateMachineBuilderMoveNext:
                case BoundIsExpression:
                case BoundAsExpression:
                    return Trivial(expression);

                default:
                    EmitDiagnosticException.Throw(
                        expression.Syntax,
                        $"SpillSequenceSpiller: unhandled BoundExpression kind '{expression.Kind}'.");
                    return null; // unreachable
            }
        }

        /// <summary>
        /// Spills a <see cref="BoundBlockExpression"/> (e.g. an interpolated
        /// string lowered to the handler pattern, issue #368) by flattening its
        /// statements through the statement rewriter — lifting any awaits to
        /// statement level — and then spilling the trailing value expression.
        /// The hole pre-evaluation in <c>InterpolatedStringHandlerLowerer</c>
        /// guarantees awaits precede the (possibly ByRefLike) handler local, so
        /// no handler local is live across a suspension after this flattening.
        /// </summary>
        private BoundSpillSequenceExpression SpillBlockExpression(BoundBlockExpression block)
        {
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();
            foreach (var statement in block.Statements)
            {
                RewriteStatementToList(statement, sideEffects);
            }

            var valueSpill = SpillExpression(block.Expression);
            sideEffects.AddRange(valueSpill.SideEffects);

            return new BoundSpillSequenceExpression(
                null,
                valueSpill.Locals,
                sideEffects.ToImmutable(),
                valueSpill.Value);
        }

        private BoundSpillSequenceExpression SpillAwait(BoundAwaitExpression awaitExpr)
        {
            // First, spill the inner expression of the await (e.g. the Task).
            BoundSpillSequenceExpression innerSpill = null;
            BoundExpression innerExpr = awaitExpr.Expression;

            if (AsyncBoundTreeQueries.HasAwait(awaitExpr.Expression))
            {
                innerSpill = SpillExpression(awaitExpr.Expression);
                innerExpr = innerSpill.Value;
            }

            // Create a spill temp for the await result.
            var spillLocal = MakeSpillTemp(awaitExpr.Type);
            var awaitNode = new BoundAwaitExpression(null, innerExpr, awaitExpr.Type, awaitExpr.AwaiterTypeSymbol);
            var assignStmt = new BoundVariableDeclaration(null, spillLocal, awaitNode);

            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            if (innerSpill != null)
            {
                locals.AddRange(innerSpill.Locals);
                sideEffects.AddRange(innerSpill.SideEffects);
            }

            locals.Add(spillLocal);
            sideEffects.Add(assignStmt);

            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                new BoundVariableExpression(null, spillLocal));
        }

        private BoundSpillSequenceExpression SpillBinary(BoundBinaryExpression binary)
        {
            // Short-circuit operators: expand into if/else.
            if (binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd)
            {
                return SpillLogicalAnd(binary);
            }

            if (binary.Op.Kind == BoundBinaryOperatorKind.LogicalOr)
            {
                return SpillLogicalOr(binary);
            }

            var leftHasAwait = AsyncBoundTreeQueries.HasAwait(binary.Left);
            var rightHasAwait = AsyncBoundTreeQueries.HasAwait(binary.Right);

            if (!leftHasAwait && !rightHasAwait)
            {
                return Trivial(binary);
            }

            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            BoundExpression left;
            if (leftHasAwait)
            {
                var spilledLeft = SpillExpression(binary.Left);
                locals.AddRange(spilledLeft.Locals);
                sideEffects.AddRange(spilledLeft.SideEffects);
                left = spilledLeft.Value;
            }
            else
            {
                left = binary.Left;
            }

            // If right has await, the left must be spilled to a temp
            // (unless it's a pure constant or simple variable read).
            if (rightHasAwait && !IsPureOrConstant(left))
            {
                var leftTemp = MakeSpillTemp(left.Type);
                locals.Add(leftTemp);
                sideEffects.Add(new BoundVariableDeclaration(null, leftTemp, left));
                left = new BoundVariableExpression(null, leftTemp);
            }

            BoundExpression right;
            if (rightHasAwait)
            {
                var spilledRight = SpillExpression(binary.Right);
                locals.AddRange(spilledRight.Locals);
                sideEffects.AddRange(spilledRight.SideEffects);
                right = spilledRight.Value;
            }
            else
            {
                right = binary.Right;
            }

            var value = new BoundBinaryExpression(null, left, binary.Op, right);

            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(value);
            }

            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                value);
        }

        private BoundSpillSequenceExpression SpillLogicalAnd(BoundBinaryExpression binary)
        {
            // a && (await b) => { var tmp = false; if (a) goto evalRight; goto end; evalRight: tmp = await b; end: VALUE=tmp }
            var resultLocal = MakeSpillTemp(binary.Type);
            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            // Spill the left side.
            BoundExpression left = binary.Left;
            if (AsyncBoundTreeQueries.HasAwait(binary.Left))
            {
                var spilledLeft = SpillExpression(binary.Left);
                locals.AddRange(spilledLeft.Locals);
                sideEffects.AddRange(spilledLeft.SideEffects);
                left = spilledLeft.Value;
            }

            var evalRightLabel = MakeLabel();
            var endLabel = MakeLabel();

            // if (left) goto evalRight
            sideEffects.Add(new BoundConditionalGotoStatement(null, evalRightLabel, left, jumpIfTrue: true));

            // tmp = false; goto end
            sideEffects.Add(new BoundExpressionStatement(
                null,
                new BoundAssignmentExpression(null, resultLocal, new BoundLiteralExpression(null, false))));
            sideEffects.Add(new BoundGotoStatement(null, endLabel));

            // evalRight: tmp = await b
            sideEffects.Add(new BoundLabelStatement(null, evalRightLabel));
            var spilledRight = SpillExpression(binary.Right);
            locals.AddRange(spilledRight.Locals);
            sideEffects.AddRange(spilledRight.SideEffects);
            sideEffects.Add(new BoundExpressionStatement(
                null,
                new BoundAssignmentExpression(null, resultLocal, spilledRight.Value)));

            // end:
            sideEffects.Add(new BoundLabelStatement(null, endLabel));

            locals.Add(resultLocal);

            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                new BoundVariableExpression(null, resultLocal));
        }

        private BoundSpillSequenceExpression SpillLogicalOr(BoundBinaryExpression binary)
        {
            // a || (await b) => { var tmp = true; if (a) goto end; tmp = await b; end: VALUE=tmp }
            var resultLocal = MakeSpillTemp(binary.Type);
            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            BoundExpression left = binary.Left;
            if (AsyncBoundTreeQueries.HasAwait(binary.Left))
            {
                var spilledLeft = SpillExpression(binary.Left);
                locals.AddRange(spilledLeft.Locals);
                sideEffects.AddRange(spilledLeft.SideEffects);
                left = spilledLeft.Value;
            }

            var endLabel = MakeLabel();

            // if (left) { tmp = true; goto end }
            sideEffects.Add(new BoundConditionalGotoStatement(null, endLabel, left, jumpIfTrue: true));

            // else: tmp = await b
            var spilledRight = SpillExpression(binary.Right);
            locals.AddRange(spilledRight.Locals);
            sideEffects.AddRange(spilledRight.SideEffects);
            sideEffects.Add(new BoundExpressionStatement(
                null,
                new BoundAssignmentExpression(null, resultLocal, spilledRight.Value)));
            var skipTrueLabel = MakeLabel();
            sideEffects.Add(new BoundGotoStatement(null, skipTrueLabel));

            // end:  (jumped to when left is true)
            sideEffects.Add(new BoundLabelStatement(null, endLabel));
            sideEffects.Add(new BoundExpressionStatement(
                null,
                new BoundAssignmentExpression(null, resultLocal, new BoundLiteralExpression(null, true))));

            // skipTrue:
            sideEffects.Add(new BoundLabelStatement(null, skipTrueLabel));

            locals.Add(resultLocal);

            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                new BoundVariableExpression(null, resultLocal));
        }

        private BoundSpillSequenceExpression SpillCall(BoundCallExpression call)
        {
            var (locals, sideEffects, args) = SpillArgumentList(call.Arguments);

            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(call);
            }

            var value = new BoundCallExpression(null, call.Function, args.ToImmutable(), call.ReturnType);
            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                value);
        }

        private BoundSpillSequenceExpression SpillConstrainedStaticCall(BoundConstrainedStaticCallExpression call)
        {
            // ADR-0089 / issue #755: structurally identical to BoundCallExpression
            // for spilling — no receiver expression to evaluate, just argument
            // evaluation order needs preserving across awaits.
            var (locals, sideEffects, args) = SpillArgumentList(call.Arguments);

            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(call);
            }

            var value = new BoundConstrainedStaticCallExpression(
                call.Syntax,
                call.TypeParameter,
                call.InterfaceMethod,
                args.ToImmutable(),
                call.ReturnType);
            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                value);
        }

        private BoundSpillSequenceExpression SpillImportedCall(BoundImportedCallExpression call)
        {
            var (locals, sideEffects, args) = SpillArgumentList(call.Arguments);

            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(call);
            }

            var value = new BoundImportedCallExpression(null, call.Function, args.ToImmutable(), call.ArgumentRefKinds);
            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                value);
        }

        private BoundSpillSequenceExpression SpillImportedInstanceCall(BoundImportedInstanceCallExpression call)
        {
            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            // Spill the receiver if args contain an await.
            BoundExpression receiver = call.Receiver;
            var argsHaveAwait = false;
            foreach (var arg in call.Arguments)
            {
                if (AsyncBoundTreeQueries.HasAwait(arg))
                {
                    argsHaveAwait = true;
                    break;
                }
            }

            if (AsyncBoundTreeQueries.HasAwait(receiver))
            {
                var spilledReceiver = SpillExpression(receiver);
                locals.AddRange(spilledReceiver.Locals);
                sideEffects.AddRange(spilledReceiver.SideEffects);
                receiver = spilledReceiver.Value;
            }

            if (argsHaveAwait && !IsPureOrConstant(receiver))
            {
                var recvTemp = MakeSpillTemp(receiver.Type);
                locals.Add(recvTemp);
                sideEffects.Add(new BoundVariableDeclaration(null, recvTemp, receiver));
                receiver = new BoundVariableExpression(null, recvTemp);
            }

            var (argLocals, argSideEffects, args) = SpillArgumentList(call.Arguments);
            locals.AddRange(argLocals);
            sideEffects.AddRange(argSideEffects);

            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(call);
            }

            var value = new BoundImportedInstanceCallExpression(null, receiver, call.Method, call.Type, args.ToImmutable(), call.ArgumentRefKinds);
            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                value);
        }

        private BoundSpillSequenceExpression SpillUserInstanceCall(BoundUserInstanceCallExpression call)
        {
            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            BoundExpression receiver = call.Receiver;
            var argsHaveAwait = false;
            foreach (var arg in call.Arguments)
            {
                if (AsyncBoundTreeQueries.HasAwait(arg))
                {
                    argsHaveAwait = true;
                    break;
                }
            }

            if (AsyncBoundTreeQueries.HasAwait(receiver))
            {
                var spilledReceiver = SpillExpression(receiver);
                locals.AddRange(spilledReceiver.Locals);
                sideEffects.AddRange(spilledReceiver.SideEffects);
                receiver = spilledReceiver.Value;
            }

            if (argsHaveAwait && !IsPureOrConstant(receiver))
            {
                var recvTemp = MakeSpillTemp(receiver.Type);
                locals.Add(recvTemp);
                sideEffects.Add(new BoundVariableDeclaration(null, recvTemp, receiver));
                receiver = new BoundVariableExpression(null, recvTemp);
            }

            var (argLocals, argSideEffects, args) = SpillArgumentList(call.Arguments);
            locals.AddRange(argLocals);
            sideEffects.AddRange(argSideEffects);

            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(call);
            }

            var value = new BoundUserInstanceCallExpression(null, receiver, call.Method, args.ToImmutable(), call.Type);
            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                value);
        }

        private BoundSpillSequenceExpression SpillBaseInterfaceCall(BoundBaseInterfaceCallExpression call)
        {
            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            BoundExpression receiver = call.Receiver;
            var argsHaveAwait = false;
            foreach (var arg in call.Arguments)
            {
                if (AsyncBoundTreeQueries.HasAwait(arg))
                {
                    argsHaveAwait = true;
                    break;
                }
            }

            if (AsyncBoundTreeQueries.HasAwait(receiver))
            {
                var spilledReceiver = SpillExpression(receiver);
                locals.AddRange(spilledReceiver.Locals);
                sideEffects.AddRange(spilledReceiver.SideEffects);
                receiver = spilledReceiver.Value;
            }

            if (argsHaveAwait && !IsPureOrConstant(receiver))
            {
                var recvTemp = MakeSpillTemp(receiver.Type);
                locals.Add(recvTemp);
                sideEffects.Add(new BoundVariableDeclaration(null, recvTemp, receiver));
                receiver = new BoundVariableExpression(null, recvTemp);
            }

            var (argLocals, argSideEffects, args) = SpillArgumentList(call.Arguments);
            locals.AddRange(argLocals);
            sideEffects.AddRange(argSideEffects);

            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(call);
            }

            var value = new BoundBaseInterfaceCallExpression(null, receiver, call.Interface, call.Method, args.ToImmutable());
            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                value);
        }

        private BoundSpillSequenceExpression SpillConversion(BoundConversionExpression conv)
        {
            if (!AsyncBoundTreeQueries.HasAwait(conv.Expression))
            {
                return Trivial(conv);
            }

            var spilled = SpillExpression(conv.Expression);
            var value = new BoundConversionExpression(null, conv.Type, spilled.Value);
            return new BoundSpillSequenceExpression(
                null,
                spilled.Locals,
                spilled.SideEffects,
                value);
        }

        private BoundSpillSequenceExpression SpillAssignment(BoundAssignmentExpression assign)
        {
            if (!AsyncBoundTreeQueries.HasAwait(assign.Expression))
            {
                return Trivial(assign);
            }

            var spilled = SpillExpression(assign.Expression);
            var value = new BoundAssignmentExpression(null, assign.Variable, spilled.Value);
            return new BoundSpillSequenceExpression(
                null,
                spilled.Locals,
                spilled.SideEffects,
                value);
        }

        private BoundSpillSequenceExpression SpillFieldAssignment(BoundFieldAssignmentExpression assign)
        {
            // Receiver is a VariableSymbol — already a stable local read, no spilling needed.
            // Only the RHS Value can contain an await.
            if (!AsyncBoundTreeQueries.HasAwait(assign.Value))
            {
                return Trivial(assign);
            }

            var spilled = SpillExpression(assign.Value);
            var value = new BoundFieldAssignmentExpression(
                null,
                assign.Receiver,
                assign.StructType,
                assign.Field,
                spilled.Value);
            return new BoundSpillSequenceExpression(
                null,
                spilled.Locals,
                spilled.SideEffects,
                value);
        }

        private BoundSpillSequenceExpression SpillIndexAssignment(BoundIndexAssignmentExpression assign)
        {
            // Target is a VariableSymbol — already a stable local read.
            // Index and Value can each contain an await.
            var indexHasAwait = AsyncBoundTreeQueries.HasAwait(assign.Index);
            var valueHasAwait = AsyncBoundTreeQueries.HasAwait(assign.Value);

            if (!indexHasAwait && !valueHasAwait)
            {
                return Trivial(assign);
            }

            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();

            BoundExpression index;
            if (indexHasAwait)
            {
                var spilledIndex = SpillExpression(assign.Index);
                locals.AddRange(spilledIndex.Locals);
                sideEffects.AddRange(spilledIndex.SideEffects);
                index = spilledIndex.Value;
            }
            else
            {
                index = assign.Index;
            }

            // If the RHS has an await, the index must be stable across that suspension.
            if (valueHasAwait && !IsPureOrConstant(index))
            {
                var indexTemp = MakeSpillTemp(index.Type);
                locals.Add(indexTemp);
                sideEffects.Add(new BoundVariableDeclaration(null, indexTemp, index));
                index = new BoundVariableExpression(null, indexTemp);
            }

            BoundExpression rhs;
            if (valueHasAwait)
            {
                var spilledValue = SpillExpression(assign.Value);
                locals.AddRange(spilledValue.Locals);
                sideEffects.AddRange(spilledValue.SideEffects);
                rhs = spilledValue.Value;
            }
            else
            {
                rhs = assign.Value;
            }

            var value = new BoundIndexAssignmentExpression(null, assign.Target, index, rhs, assign.Type);
            return new BoundSpillSequenceExpression(
                null,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                value);
        }

        private BoundSpillSequenceExpression SpillUnary(BoundUnaryExpression unary)
        {
            if (!AsyncBoundTreeQueries.HasAwait(unary.Operand))
            {
                return Trivial(unary);
            }

            var spilled = SpillExpression(unary.Operand);
            var value = new BoundUnaryExpression(null, unary.Op, spilled.Value);
            return new BoundSpillSequenceExpression(
                null,
                spilled.Locals,
                spilled.SideEffects,
                value);
        }

        /// <summary>
        /// Spills a list of arguments. When argument K contains an await,
        /// all previous arguments (0..K-1) that are not pure/constant are
        /// spilled to temps to preserve evaluation order.
        /// </summary>
        private (ImmutableArray<LocalVariableSymbol>.Builder Locals,
                 ImmutableArray<BoundStatement>.Builder SideEffects,
                 ImmutableArray<BoundExpression>.Builder Args) SpillArgumentList(
            ImmutableArray<BoundExpression> arguments)
        {
            var locals = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
            var sideEffects = ImmutableArray.CreateBuilder<BoundStatement>();
            var args = ImmutableArray.CreateBuilder<BoundExpression>(arguments.Length);

            // First pass: determine which args have await.
            var awaitIndices = new List<int>();
            for (var i = 0; i < arguments.Length; i++)
            {
                if (AsyncBoundTreeQueries.HasAwait(arguments[i]))
                {
                    awaitIndices.Add(i);
                }
            }

            if (awaitIndices.Count == 0)
            {
                // No awaits in arguments.
                for (var i = 0; i < arguments.Length; i++)
                {
                    args.Add(arguments[i]);
                }

                return (locals, sideEffects, args);
            }

            // We need to spill. Process args left-to-right.
            var firstAwaitIdx = awaitIndices[0];

            for (var i = 0; i < arguments.Length; i++)
            {
                var arg = arguments[i];

                if (AsyncBoundTreeQueries.HasAwait(arg))
                {
                    // Spill this argument's await.
                    var spilledArg = SpillExpression(arg);
                    locals.AddRange(spilledArg.Locals);
                    sideEffects.AddRange(spilledArg.SideEffects);
                    args.Add(spilledArg.Value);
                }
                else if (i < firstAwaitIdx && !IsPureOrConstant(arg))
                {
                    // This arg precedes an await — spill to temp.
                    var temp = MakeSpillTemp(arg.Type);
                    locals.Add(temp);
                    sideEffects.Add(new BoundVariableDeclaration(null, temp, arg));
                    args.Add(new BoundVariableExpression(null, temp));
                }
                else if (i > firstAwaitIdx && !IsPureOrConstant(arg))
                {
                    // Between awaits, we also need to check if there's a
                    // later await that would require this to be spilled.
                    var needsSpill = false;
                    foreach (var awIdx in awaitIndices)
                    {
                        if (awIdx > i)
                        {
                            needsSpill = true;
                            break;
                        }
                    }

                    if (needsSpill)
                    {
                        var temp = MakeSpillTemp(arg.Type);
                        locals.Add(temp);
                        sideEffects.Add(new BoundVariableDeclaration(null, temp, arg));
                        args.Add(new BoundVariableExpression(null, temp));
                    }
                    else
                    {
                        args.Add(arg);
                    }
                }
                else
                {
                    args.Add(arg);
                }
            }

            return (locals, sideEffects, args);
        }

        private LocalVariableSymbol MakeSpillTemp(TypeSymbol type)
        {
            var name = GeneratedNames.SpillTempField(spillOrdinal++);
            return new LocalVariableSymbol(name, isReadOnly: false, type);
        }

        private BoundLabel MakeLabel()
        {
            return new BoundLabel($"<>spill_label{spillOrdinal++}");
        }

        private static bool IsPureOrConstant(BoundExpression expression)
        {
            return expression is BoundLiteralExpression
                || expression is BoundVariableExpression;
        }

        private static BoundSpillSequenceExpression Trivial(BoundExpression value)
        {
            return new BoundSpillSequenceExpression(
                null,
                ImmutableArray<LocalVariableSymbol>.Empty,
                ImmutableArray<BoundStatement>.Empty,
                value);
        }

        private static void FlushSideEffects(BoundSpillSequenceExpression spill, ImmutableArray<BoundStatement>.Builder builder)
        {
            // Emit variable declarations for the spill locals (they need IL slots).
            foreach (var local in spill.Locals)
            {
                // Only emit a declaration if the local isn't already declared as part
                // of the side-effects (the await spill already uses BoundVariableDeclaration).
                var alreadyDeclared = false;
                foreach (var stmt in spill.SideEffects)
                {
                    if (stmt is BoundVariableDeclaration decl && decl.Variable == local)
                    {
                        alreadyDeclared = true;
                        break;
                    }
                }

                if (!alreadyDeclared)
                {
                    builder.Add(new BoundVariableDeclaration(null, local, GetDefaultValue(local.Type)));
                }
            }

            foreach (var stmt in spill.SideEffects)
            {
                builder.Add(stmt);
            }
        }

        private static BoundExpression GetDefaultValue(TypeSymbol type)
        {
            if (type == TypeSymbol.Int32)
            {
                return new BoundLiteralExpression(null, 0);
            }

            if (type == TypeSymbol.Bool)
            {
                return new BoundLiteralExpression(null, false);
            }

            if (type == TypeSymbol.String)
            {
                return new BoundLiteralExpression(null, string.Empty);
            }

            // For reference types or unknown types, use default(int) as placeholder.
            // The actual value will be overwritten before use.
            return new BoundLiteralExpression(null, 0);
        }
    }
}
