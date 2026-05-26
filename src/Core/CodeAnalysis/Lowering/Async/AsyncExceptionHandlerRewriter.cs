// <copyright file="AsyncExceptionHandlerRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Lowering.Async;

/// <summary>
/// Rewrites <c>try/catch</c> and <c>try/finally</c> statements whose handlers
/// contain <c>await</c> into pending-exception forms that can be processed by
/// the subsequent <see cref="SpillSequenceSpiller"/> and
/// <see cref="MoveNextBodyRewriter"/> passes.
/// </summary>
/// <remarks>
/// <para>The CLR does not allow suspension inside a catch or finally handler.
/// This pass lifts the handler body out of the protected region by capturing
/// exceptions into a pending-exception local and executing the original handler
/// body after the try statement completes.</para>
///
/// <para><b>Pattern A — try/catch with await in catch:</b></para>
/// <code>
/// Exception pendingException = null;
/// try { body; }
/// catch (Exception ex) { pendingException = ex; }
/// if (pendingException != null) {
///     T e = (T)pendingException;   // rebind original variable
///     handlerBody;                 // await is now outside the handler
/// }
/// </code>
///
/// <para><b>Pattern B — try/finally with await in finally:</b></para>
/// <code>
/// Exception pendingException = null;
/// try { body; }
/// catch (Exception ex) { pendingException = ex; }
/// finallyBody;   // await is now outside the finally region
/// if (pendingException != null) { throw pendingException; }
/// </code>
///
/// <para><b>Deferred:</b> Pending-branch dispatch for <c>return</c>/<c>goto</c>/
/// <c>break</c> out of a try-with-async-finally (spec §8, Pattern C). A clean
/// pass-through is emitted for now; early returns from a try whose finally has
/// await are not yet supported and will produce correct but potentially
/// surprising behavior (the return value is computed but the finally runs
/// before the method actually returns, which is the normal CLR semantic — the
/// issue arises only if the return target must be funneled through the rewritten
/// code, which for our state-machine path is handled by MoveNextBodyRewriter's
/// exit label).</para>
/// </remarks>
public static class AsyncExceptionHandlerRewriter
{
    private static int labelOrdinal;

    /// <summary>
    /// Rewrites <paramref name="body"/> so that no <c>await</c> appears inside
    /// a catch or finally handler.
    /// </summary>
    /// <param name="body">The async method body to rewrite.</param>
    /// <returns>The rewritten body with handlers lifted.</returns>
    public static BoundBlockStatement Rewrite(BoundBlockStatement body)
    {
        if (body == null || !AsyncBoundTreeQueries.HasAwait(body))
        {
            return body;
        }

        var rewriter = new Rewriter();
        var result = rewriter.RewriteStatement(body);
        return result as BoundBlockStatement ?? new BoundBlockStatement(ImmutableArray.Create(result));
    }

    private static BoundLabel MakeLabel(string prefix)
    {
        return new BoundLabel($"<>async_exh_{prefix}_{labelOrdinal++}");
    }

    private sealed class Rewriter : BoundTreeRewriter
    {
        private int localOrdinal;

        protected override BoundStatement RewriteTryStatement(BoundTryStatement node)
        {
            // First, recursively rewrite children (nested try statements).
            var rewrittenTry = RewriteStatement(node.TryBlock);

            var rewrittenClauses = ImmutableArray.CreateBuilder<BoundCatchClause>();
            foreach (var clause in node.CatchClauses)
            {
                var rewrittenBody = RewriteStatement(clause.Body);
                rewrittenClauses.Add(new BoundCatchClause(clause.ExceptionType, clause.Variable, rewrittenBody));
            }

            var rewrittenFinally = node.FinallyBlock != null ? RewriteStatement(node.FinallyBlock) : null;

            bool anyCatchHasAwait = false;
            foreach (var clause in rewrittenClauses)
            {
                if (AsyncBoundTreeQueries.HasAwait(clause.Body))
                {
                    anyCatchHasAwait = true;
                    break;
                }
            }

            bool finallyHasAwait = rewrittenFinally != null && AsyncBoundTreeQueries.HasAwait(rewrittenFinally);

            // The finally must be lifted out of the protected region in either
            // of two cases:
            //   1) The finally itself contains an await (the CLR forbids await
            //      inside a finally handler).
            //   2) The try body contains an await. Without lifting, the IL
            //      `leave` emitted for async suspension would execute the
            //      finally on every yield, which is semantically wrong (the
            //      finally should run only when the try completes normally,
            //      exceptionally, or via early exit — not on async suspension).
            bool tryBodyHasAwait = AsyncBoundTreeQueries.HasAwait(rewrittenTry);
            bool needsFinallyLift = rewrittenFinally != null && (finallyHasAwait || tryBodyHasAwait);

            if (!anyCatchHasAwait && !needsFinallyLift)
            {
                // No handler-await and no need to lift the finally — pass
                // through (possibly with rewritten children).
                if (rewrittenTry == node.TryBlock && !CatchesChanged(node.CatchClauses, rewrittenClauses) && rewrittenFinally == node.FinallyBlock)
                {
                    return node;
                }

                return new BoundTryStatement(rewrittenTry, rewrittenClauses.ToImmutable(), rewrittenFinally);
            }

            // We need to rewrite. Build the output statement list.
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();

            var exceptionType = TypeSymbol.FromClrType(typeof(Exception));
            var nullableExceptionType = NullableTypeSymbol.Get(exceptionType);
            var pendingExLocal = new LocalVariableSymbol(
                $"<>pending_ex_{localOrdinal++}", isReadOnly: false, nullableExceptionType);
            var pendingExNullInit = new BoundVariableDeclaration(
                pendingExLocal, new BoundLiteralExpression(null, nullableExceptionType));
            statements.Add(pendingExNullInit);

            if (needsFinallyLift)
            {
                // Pattern B: try/finally with await in finally
                // Also handles try/catch/finally where finally has await:
                // we keep catch clauses that don't have await as-is on the inner try,
                // but add a catch-all to capture into pendingException.
                RewriteFinallyWithAwait(
                    statements,
                    rewrittenTry,
                    rewrittenClauses,
                    rewrittenFinally,
                    pendingExLocal,
                    exceptionType,
                    anyCatchHasAwait);
            }
            else
            {
                // Pattern A: try/catch with await in catch (finally has no await or is absent)
                RewriteCatchWithAwait(
                    statements,
                    rewrittenTry,
                    rewrittenClauses,
                    rewrittenFinally,
                    pendingExLocal,
                    exceptionType);
            }

            return new BoundBlockStatement(statements.ToImmutable());
        }

        private void RewriteCatchWithAwait(
            ImmutableArray<BoundStatement>.Builder statements,
            BoundStatement tryBody,
            ImmutableArray<BoundCatchClause>.Builder catchClauses,
            BoundStatement finallyBlock,
            LocalVariableSymbol pendingExLocal,
            TypeSymbol exceptionType)
        {
            // For each catch clause with await, replace the body with
            // pendingException = ex; and emit the real body after the try.
            // Catch clauses without await stay in-place.
            var newClauses = ImmutableArray.CreateBuilder<BoundCatchClause>();
            var afterTryHandlers = ImmutableArray.CreateBuilder<(BoundCatchClause Original, BoundStatement Body)>();

            foreach (var clause in catchClauses)
            {
                if (AsyncBoundTreeQueries.HasAwait(clause.Body))
                {
                    // Replace body: pendingException = ex;
                    var assignPending = new BoundExpressionStatement(
                        new BoundAssignmentExpression(
                            pendingExLocal,
                            new BoundVariableExpression(clause.Variable)));
                    var catchAllClause = new BoundCatchClause(
                        exceptionType,
                        clause.Variable,
                        new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(assignPending)));
                    newClauses.Add(catchAllClause);
                    afterTryHandlers.Add((clause, clause.Body));
                }
                else
                {
                    newClauses.Add(clause);
                }
            }

            var tryStmt = new BoundTryStatement(tryBody, newClauses.ToImmutable(), finallyBlock);
            statements.Add(tryStmt);

            // After the try: if (pendingException != null) { T e = (T)pendingException; handlerBody; }
            foreach (var (original, body) in afterTryHandlers)
            {
                var endLabel = MakeLabel("catch_end");
                var pendingExRef = new BoundVariableExpression(pendingExLocal);
                var nullLit = new BoundLiteralExpression(null, TypeSymbol.Null);
                var condition = new BoundBinaryExpression(
                    pendingExRef,
                    BoundBinaryOperator.Bind(
                        CodeAnalysis.Syntax.SyntaxKind.EqualsEqualsToken,
                        pendingExLocal.Type,
                        TypeSymbol.Null),
                    nullLit);

                // Jump past the handler if pendingException == null
                statements.Add(new BoundConditionalGotoStatement(endLabel, condition, jumpIfTrue: true));

                // Rebind the original catch variable: T e = (T)pendingException;
                // Since GSharp's catch variable type may be same as Exception, just assign directly.
                var rebind = new BoundVariableDeclaration(
                    original.Variable,
                    new BoundVariableExpression(pendingExLocal));
                statements.Add(rebind);

                // Emit the handler body
                if (body is BoundBlockStatement block)
                {
                    foreach (var stmt in block.Statements)
                    {
                        statements.Add(stmt);
                    }
                }
                else
                {
                    statements.Add(body);
                }

                statements.Add(new BoundLabelStatement(endLabel));
            }
        }

        private void RewriteFinallyWithAwait(
            ImmutableArray<BoundStatement>.Builder statements,
            BoundStatement tryBody,
            ImmutableArray<BoundCatchClause>.Builder catchClauses,
            BoundStatement finallyBlock,
            LocalVariableSymbol pendingExLocal,
            TypeSymbol exceptionType,
            bool anyCatchHasAwait)
        {
            // Build inner try: original try body + original catches (without await ones)
            // + a catch-all that stores into pendingException.
            var innerClauses = ImmutableArray.CreateBuilder<BoundCatchClause>();
            var liftedCatchHandlers = ImmutableArray.CreateBuilder<(BoundCatchClause Original, BoundStatement Body)>();

            foreach (var clause in catchClauses)
            {
                if (AsyncBoundTreeQueries.HasAwait(clause.Body))
                {
                    // Capture into pending and lift body after finally
                    var assignPending = new BoundExpressionStatement(
                        new BoundAssignmentExpression(
                            pendingExLocal,
                            new BoundVariableExpression(clause.Variable)));
                    var captureClause = new BoundCatchClause(
                        exceptionType,
                        clause.Variable,
                        new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(assignPending)));
                    innerClauses.Add(captureClause);
                    liftedCatchHandlers.Add((clause, clause.Body));
                }
                else
                {
                    innerClauses.Add(clause);
                }
            }

            // Add catch-all for the finally pattern:
            // catch (Exception ex) { pendingException = ex; }
            var catchAllVar = new LocalVariableSymbol(
                $"<>ex_finally_{localOrdinal++}", isReadOnly: false, exceptionType);
            var catchAllAssign = new BoundExpressionStatement(
                new BoundAssignmentExpression(
                    pendingExLocal,
                    new BoundVariableExpression(catchAllVar)));
            var catchAllBody = new BoundBlockStatement(ImmutableArray.Create<BoundStatement>(catchAllAssign));
            var catchAllClause = new BoundCatchClause(exceptionType, catchAllVar, catchAllBody);
            innerClauses.Add(catchAllClause);

            var innerTry = new BoundTryStatement(tryBody, innerClauses.ToImmutable(), finallyBlock: null);
            statements.Add(innerTry);

            // Emit lifted catch handlers (for catch-with-await in try/catch/finally)
            foreach (var (original, body) in liftedCatchHandlers)
            {
                var endLabel = MakeLabel("liftcatch_end");
                var pendingExRef = new BoundVariableExpression(pendingExLocal);
                var nullLit = new BoundLiteralExpression(null, TypeSymbol.Null);
                var condition = new BoundBinaryExpression(
                    pendingExRef,
                    BoundBinaryOperator.Bind(
                        CodeAnalysis.Syntax.SyntaxKind.EqualsEqualsToken,
                        pendingExLocal.Type,
                        TypeSymbol.Null),
                    nullLit);

                statements.Add(new BoundConditionalGotoStatement(endLabel, condition, jumpIfTrue: true));

                var rebind = new BoundVariableDeclaration(
                    original.Variable,
                    new BoundVariableExpression(pendingExLocal));
                statements.Add(rebind);

                if (body is BoundBlockStatement block)
                {
                    foreach (var stmt in block.Statements)
                    {
                        statements.Add(stmt);
                    }
                }
                else
                {
                    statements.Add(body);
                }

                // Clear pendingException after handling so the rethrow below doesn't fire
                statements.Add(new BoundExpressionStatement(
                    new BoundAssignmentExpression(
                        pendingExLocal,
                        new BoundLiteralExpression(null, TypeSymbol.Null))));
                statements.Add(new BoundLabelStatement(endLabel));
            }

            // Emit the finally body (now outside any handler region)
            if (finallyBlock is BoundBlockStatement finallyBlockStmt)
            {
                foreach (var stmt in finallyBlockStmt.Statements)
                {
                    statements.Add(stmt);
                }
            }
            else
            {
                statements.Add(finallyBlock);
            }

            // if (pendingException != null) { throw pendingException; }
            var rethrowEndLabel = MakeLabel("rethrow_end");
            var pendingRef = new BoundVariableExpression(pendingExLocal);
            var nullLitFinal = new BoundLiteralExpression(null, TypeSymbol.Null);
            var rethrowCondition = new BoundBinaryExpression(
                pendingRef,
                BoundBinaryOperator.Bind(
                    CodeAnalysis.Syntax.SyntaxKind.EqualsEqualsToken,
                    pendingExLocal.Type,
                    TypeSymbol.Null),
                nullLitFinal);

            statements.Add(new BoundConditionalGotoStatement(rethrowEndLabel, rethrowCondition, jumpIfTrue: true));
            statements.Add(new BoundThrowStatement(new BoundVariableExpression(pendingExLocal)));
            statements.Add(new BoundLabelStatement(rethrowEndLabel));
        }

        private static bool CatchesChanged(
            ImmutableArray<BoundCatchClause> original,
            ImmutableArray<BoundCatchClause>.Builder rewritten)
        {
            if (original.Length != rewritten.Count)
            {
                return true;
            }

            for (int i = 0; i < original.Length; i++)
            {
                if (!ReferenceEquals(original[i].Body, rewritten[i].Body))
                {
                    return true;
                }
            }

            return false;
        }
    }
}
