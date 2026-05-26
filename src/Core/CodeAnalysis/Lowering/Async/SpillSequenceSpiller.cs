// <copyright file="SpillSequenceSpiller.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
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

            return new BoundBlockStatement(builder.ToImmutable());
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

                case BoundBlockStatement nested:
                    var rewritten = RewriteBlock(nested);
                    builder.Add(rewritten);
                    return rewritten != nested;

                default:
                    builder.Add(statement);
                    return false;
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
            builder.Add(new BoundVariableDeclaration(decl.Variable, spilled.Value));
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
                builder.Add(new BoundExpressionStatement(spilled.Value));
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
            builder.Add(new BoundReturnStatement(spilled.Value));
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
                ? (thenBuilder.Count == 1 ? thenBuilder[0] : new BoundBlockStatement(thenBuilder.ToImmutable()))
                : ifStmt.ThenStatement;

            BoundStatement elseStmt = ifStmt.ElseStatement;
            var elseChanged = false;
            if (elseStmt != null)
            {
                var elseBuilder = ImmutableArray.CreateBuilder<BoundStatement>();
                elseChanged = RewriteStatementToList(elseStmt, elseBuilder);
                if (elseChanged)
                {
                    elseStmt = elseBuilder.Count == 1 ? elseBuilder[0] : new BoundBlockStatement(elseBuilder.ToImmutable());
                }
            }

            if (!conditionChanged && !thenChanged && !elseChanged)
            {
                builder.Add(ifStmt);
                return false;
            }

            builder.Add(new BoundIfStatement(condition, thenStmt, elseStmt));
            return true;
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

                case BoundImportedCallExpression importedCall:
                    return SpillImportedCall(importedCall);

                case BoundImportedInstanceCallExpression instanceCall:
                    return SpillImportedInstanceCall(instanceCall);

                case BoundConversionExpression conv:
                    return SpillConversion(conv);

                case BoundAssignmentExpression assign:
                    return SpillAssignment(assign);

                case BoundUserInstanceCallExpression userInstance:
                    return SpillUserInstanceCall(userInstance);

                default:
                    // No await in this expression — return trivially.
                    return Trivial(expression);
            }
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
            var awaitNode = new BoundAwaitExpression(innerExpr, awaitExpr.Type);
            var assignStmt = new BoundVariableDeclaration(spillLocal, awaitNode);

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
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                new BoundVariableExpression(spillLocal));
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
                sideEffects.Add(new BoundVariableDeclaration(leftTemp, left));
                left = new BoundVariableExpression(leftTemp);
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

            var value = new BoundBinaryExpression(left, binary.Op, right);

            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(value);
            }

            return new BoundSpillSequenceExpression(
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
            sideEffects.Add(new BoundConditionalGotoStatement(evalRightLabel, left, jumpIfTrue: true));

            // tmp = false; goto end
            sideEffects.Add(new BoundExpressionStatement(
                new BoundAssignmentExpression(resultLocal, new BoundLiteralExpression(false))));
            sideEffects.Add(new BoundGotoStatement(endLabel));

            // evalRight: tmp = await b
            sideEffects.Add(new BoundLabelStatement(evalRightLabel));
            var spilledRight = SpillExpression(binary.Right);
            locals.AddRange(spilledRight.Locals);
            sideEffects.AddRange(spilledRight.SideEffects);
            sideEffects.Add(new BoundExpressionStatement(
                new BoundAssignmentExpression(resultLocal, spilledRight.Value)));

            // end:
            sideEffects.Add(new BoundLabelStatement(endLabel));

            locals.Add(resultLocal);

            return new BoundSpillSequenceExpression(
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                new BoundVariableExpression(resultLocal));
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
            sideEffects.Add(new BoundConditionalGotoStatement(endLabel, left, jumpIfTrue: true));

            // else: tmp = await b
            var spilledRight = SpillExpression(binary.Right);
            locals.AddRange(spilledRight.Locals);
            sideEffects.AddRange(spilledRight.SideEffects);
            sideEffects.Add(new BoundExpressionStatement(
                new BoundAssignmentExpression(resultLocal, spilledRight.Value)));
            var skipTrueLabel = MakeLabel();
            sideEffects.Add(new BoundGotoStatement(skipTrueLabel));

            // end:  (jumped to when left is true)
            sideEffects.Add(new BoundLabelStatement(endLabel));
            sideEffects.Add(new BoundExpressionStatement(
                new BoundAssignmentExpression(resultLocal, new BoundLiteralExpression(true))));

            // skipTrue:
            sideEffects.Add(new BoundLabelStatement(skipTrueLabel));

            locals.Add(resultLocal);

            return new BoundSpillSequenceExpression(
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                new BoundVariableExpression(resultLocal));
        }

        private BoundSpillSequenceExpression SpillCall(BoundCallExpression call)
        {
            var (locals, sideEffects, args) = SpillArgumentList(call.Arguments);

            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(call);
            }

            var value = new BoundCallExpression(call.Function, args.ToImmutable(), call.ReturnType);
            return new BoundSpillSequenceExpression(
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

            var value = new BoundImportedCallExpression(call.Function, args.ToImmutable(), call.ArgumentRefKinds);
            return new BoundSpillSequenceExpression(
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
                sideEffects.Add(new BoundVariableDeclaration(recvTemp, receiver));
                receiver = new BoundVariableExpression(recvTemp);
            }

            var (argLocals, argSideEffects, args) = SpillArgumentList(call.Arguments);
            locals.AddRange(argLocals);
            sideEffects.AddRange(argSideEffects);

            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(call);
            }

            var value = new BoundImportedInstanceCallExpression(receiver, call.Method, call.Type, args.ToImmutable(), call.ArgumentRefKinds);
            return new BoundSpillSequenceExpression(
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
                sideEffects.Add(new BoundVariableDeclaration(recvTemp, receiver));
                receiver = new BoundVariableExpression(recvTemp);
            }

            var (argLocals, argSideEffects, args) = SpillArgumentList(call.Arguments);
            locals.AddRange(argLocals);
            sideEffects.AddRange(argSideEffects);

            if (locals.Count == 0 && sideEffects.Count == 0)
            {
                return Trivial(call);
            }

            var value = new BoundUserInstanceCallExpression(receiver, call.Method, args.ToImmutable());
            return new BoundSpillSequenceExpression(
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
            var value = new BoundConversionExpression(conv.Type, spilled.Value);
            return new BoundSpillSequenceExpression(
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
            var value = new BoundAssignmentExpression(assign.Variable, spilled.Value);
            return new BoundSpillSequenceExpression(
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
                    sideEffects.Add(new BoundVariableDeclaration(temp, arg));
                    args.Add(new BoundVariableExpression(temp));
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
                        sideEffects.Add(new BoundVariableDeclaration(temp, arg));
                        args.Add(new BoundVariableExpression(temp));
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
                    builder.Add(new BoundVariableDeclaration(local, GetDefaultValue(local.Type)));
                }
            }

            foreach (var stmt in spill.SideEffects)
            {
                builder.Add(stmt);
            }
        }

        private static BoundExpression GetDefaultValue(TypeSymbol type)
        {
            if (type == TypeSymbol.Int)
            {
                return new BoundLiteralExpression(0);
            }

            if (type == TypeSymbol.Bool)
            {
                return new BoundLiteralExpression(false);
            }

            if (type == TypeSymbol.String)
            {
                return new BoundLiteralExpression(string.Empty);
            }

            // For reference types or unknown types, use default(int) as placeholder.
            // The actual value will be overwritten before use.
            return new BoundLiteralExpression(0);
        }
    }
}
