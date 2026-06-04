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
/// T? capture_i = null;                 // per-clause capture of original type
/// try { body; }
/// catch (T e) { capture_i = e; pendingException = e; }   // KEEP ORIGINAL TYPE
/// if (capture_i != null) {
///     T e = capture_i;                 // rebind original variable
///     handlerBody;                     // await is now outside the handler
/// }
/// </code>
/// <para>Keeping the catch typed (instead of widening to <c>Exception</c>) is
/// essential for correctness: it ensures the CLR catch dispatch only fires for
/// the original handler's exception type, so subsequent catch arms — and the
/// rethrow paths for unmatched exceptions — keep their original semantics
/// (issue #419).</para>
///
/// <para><b>Pattern B — try/finally with await in finally:</b></para>
/// <code>
/// Exception pendingException = null;
/// try { body; }
/// catch (Exception ex) { pendingException = ex; }
/// finallyBody;   // await is now outside the finally region
/// if (pendingException != null) {
///     System.Runtime.ExceptionServices.ExceptionDispatchInfo
///         .Capture(pendingException).Throw();   // preserve original stack trace (#418)
/// }
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
        return result as BoundBlockStatement ?? new BoundBlockStatement(null, ImmutableArray.Create(result));
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

                return new BoundTryStatement(null, rewrittenTry, rewrittenClauses.ToImmutable(), rewrittenFinally);
            }

            // We need to rewrite. Build the output statement list.
            var statements = ImmutableArray.CreateBuilder<BoundStatement>();

            var exceptionType = TypeSymbol.FromClrType(typeof(Exception));
            var nullableExceptionType = NullableTypeSymbol.Get(exceptionType);
            var pendingExLocal = new LocalVariableSymbol(
                $"<>pending_ex_{localOrdinal++}", isReadOnly: false, nullableExceptionType);
            var pendingExNullInit = new BoundVariableDeclaration(
                null,
                pendingExLocal,
                new BoundLiteralExpression(null, null, nullableExceptionType));
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

            return new BoundBlockStatement(null, statements.ToImmutable());
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
            //   capture_i = e; pendingException = e;
            // and emit the real body after the try guarded by `if (capture_i != null)`.
            // The catch clause KEEPS the original exception type so the CLR's
            // catch dispatch matches only the intended type (issue #419 — without
            // this, widening to System.Exception silently catches unrelated
            // exceptions and shadows subsequent catch arms).
            //
            // Catch clauses without await stay in-place.
            var newClauses = ImmutableArray.CreateBuilder<BoundCatchClause>();
            var afterTryHandlers = new System.Collections.Generic.List<(BoundCatchClause Original, BoundStatement Body, LocalVariableSymbol Capture)>();

            foreach (var clause in catchClauses)
            {
                if (AsyncBoundTreeQueries.HasAwait(clause.Body))
                {
                    // Per-clause capture local of nullable-of-original-type.
                    // A reference-type nullable shares the CLR representation,
                    // so this is a metadata-only annotation.
                    var captureType = NullableTypeSymbol.Get(clause.ExceptionType);
                    var captureLocal = new LocalVariableSymbol(
                        $"<>catch_capture_{localOrdinal++}", isReadOnly: false, captureType);
                    statements.Add(new BoundVariableDeclaration(
                        null,
                        captureLocal,
                        new BoundLiteralExpression(null, null, TypeSymbol.Null)));

                    // Replace body: capture_i = e; pendingException = e;
                    var assignCapture = new BoundExpressionStatement(
                        null,
                        new BoundAssignmentExpression(
                            null,
                            captureLocal,
                            new BoundVariableExpression(null, clause.Variable)));
                    var assignPending = new BoundExpressionStatement(
                        null,
                        new BoundAssignmentExpression(
                            null,
                            pendingExLocal,
                            new BoundVariableExpression(null, clause.Variable)));
                    var typedCatchClause = new BoundCatchClause(
                        clause.ExceptionType,
                        clause.Variable,
                        new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(assignCapture, assignPending)));
                    newClauses.Add(typedCatchClause);
                    afterTryHandlers.Add((clause, clause.Body, captureLocal));
                }
                else
                {
                    newClauses.Add(clause);
                }
            }

            var tryStmt = new BoundTryStatement(null, tryBody, newClauses.ToImmutable(), finallyBlock);
            statements.Add(tryStmt);

            // After the try: for each lifted clause emit
            //   if (capture_i == null) goto endLabel;
            //   T e = capture_i;
            //   handlerBody;
            //   endLabel:
            // The per-clause null check ensures the handler body only runs when
            // its specific catch fired.
            foreach (var (original, body, captureLocal) in afterTryHandlers)
            {
                var endLabel = MakeLabel("catch_end");
                var captureRef = new BoundVariableExpression(null, captureLocal);
                var nullLit = new BoundLiteralExpression(null, null, TypeSymbol.Null);
                var condition = new BoundBinaryExpression(
                    null,
                    captureRef,
                    BoundBinaryOperator.Bind(
                        CodeAnalysis.Syntax.SyntaxKind.EqualsEqualsToken,
                        captureLocal.Type,
                        TypeSymbol.Null),
                    nullLit);

                statements.Add(new BoundConditionalGotoStatement(null, endLabel, condition, jumpIfTrue: true));

                // Rebind the original catch variable: T e = capture_i;
                var rebind = new BoundVariableDeclaration(
                    null,
                    original.Variable,
                    new BoundVariableExpression(null, captureLocal));
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

                statements.Add(new BoundLabelStatement(null, endLabel));
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
            // Build inner try: original try body + original catches.
            // Typed catches with await KEEP their original type (issue #419)
            // and capture into a per-clause local plus pendingException so the
            // post-finally lifted body can dispatch only when the typed catch
            // actually fired. A final catch-all (Exception) captures any
            // remaining exceptions into pendingException so the finally can
            // run regardless.
            var innerClauses = ImmutableArray.CreateBuilder<BoundCatchClause>();
            var liftedCatchHandlers = new System.Collections.Generic.List<(BoundCatchClause Original, BoundStatement Body, LocalVariableSymbol Capture)>();

            foreach (var clause in catchClauses)
            {
                if (AsyncBoundTreeQueries.HasAwait(clause.Body))
                {
                    // Per-clause capture local of nullable-of-original-type.
                    var captureType = NullableTypeSymbol.Get(clause.ExceptionType);
                    var captureLocal = new LocalVariableSymbol(
                        $"<>catch_capture_{localOrdinal++}", isReadOnly: false, captureType);
                    statements.Add(new BoundVariableDeclaration(
                        null,
                        captureLocal,
                        new BoundLiteralExpression(null, null, TypeSymbol.Null)));

                    // Capture into per-clause local and into pending; lift body after finally.
                    var assignCapture = new BoundExpressionStatement(
                        null,
                        new BoundAssignmentExpression(
                            null,
                            captureLocal,
                            new BoundVariableExpression(null, clause.Variable)));
                    var assignPending = new BoundExpressionStatement(
                        null,
                        new BoundAssignmentExpression(
                            null,
                            pendingExLocal,
                            new BoundVariableExpression(null, clause.Variable)));
                    var typedCatchClause = new BoundCatchClause(
                        clause.ExceptionType,
                        clause.Variable,
                        new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(assignCapture, assignPending)));
                    innerClauses.Add(typedCatchClause);
                    liftedCatchHandlers.Add((clause, clause.Body, captureLocal));
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
                null,
                new BoundAssignmentExpression(
                    null,
                    pendingExLocal,
                    new BoundVariableExpression(null, catchAllVar)));
            var catchAllBody = new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(catchAllAssign));
            var catchAllClause = new BoundCatchClause(exceptionType, catchAllVar, catchAllBody);
            innerClauses.Add(catchAllClause);

            var innerTry = new BoundTryStatement(null, tryBody, innerClauses.ToImmutable(), finallyBlock: null);
            statements.Add(innerTry);

            // Emit lifted catch handlers (for catch-with-await in try/catch/finally).
            // Each handler is guarded by its per-clause capture so it only runs
            // when that specific typed catch actually fired.
            foreach (var (original, body, captureLocal) in liftedCatchHandlers)
            {
                var endLabel = MakeLabel("liftcatch_end");
                var captureRef = new BoundVariableExpression(null, captureLocal);
                var nullLit = new BoundLiteralExpression(null, null, TypeSymbol.Null);
                var condition = new BoundBinaryExpression(
                    null,
                    captureRef,
                    BoundBinaryOperator.Bind(
                        CodeAnalysis.Syntax.SyntaxKind.EqualsEqualsToken,
                        captureLocal.Type,
                        TypeSymbol.Null),
                    nullLit);

                statements.Add(new BoundConditionalGotoStatement(null, endLabel, condition, jumpIfTrue: true));

                var rebind = new BoundVariableDeclaration(
                    null,
                    original.Variable,
                    new BoundVariableExpression(null, captureLocal));
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
                    null,
                    new BoundAssignmentExpression(
                        null,
                        pendingExLocal,
                        new BoundLiteralExpression(null, null, TypeSymbol.Null))));
                statements.Add(new BoundLabelStatement(null, endLabel));
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
            var pendingRef = new BoundVariableExpression(null, pendingExLocal);
            var nullLitFinal = new BoundLiteralExpression(null, null, TypeSymbol.Null);
            var rethrowCondition = new BoundBinaryExpression(
                null,
                pendingRef,
                BoundBinaryOperator.Bind(
                    CodeAnalysis.Syntax.SyntaxKind.EqualsEqualsToken,
                    pendingExLocal.Type,
                    TypeSymbol.Null),
                nullLitFinal);

            statements.Add(new BoundConditionalGotoStatement(null, rethrowEndLabel, rethrowCondition, jumpIfTrue: true));

            // Rethrow via ExceptionDispatchInfo.Capture(pendingException).Throw() so the
            // original throw site (stack trace, watson bucketing) is preserved across the
            // async lift. Using a bare `throw pendingException` would reset the stack
            // trace and defeat production diagnostics (issue #418 P1-11).
            statements.Add(BuildEdiCaptureThrow(new BoundVariableExpression(null, pendingExLocal), exceptionType));
            statements.Add(new BoundLabelStatement(null, rethrowEndLabel));
        }

        /// <summary>
        /// Builds the lowered statement
        /// <c>ExceptionDispatchInfo.Capture(<paramref name="exceptionExpr"/>).Throw();</c>.
        /// Used by the async-rethrow path so that an exception captured into a
        /// pending-exception local is re-raised with its original stack trace,
        /// matching the semantics of an unrewritten <c>throw;</c> inside a CLR
        /// finally handler.
        /// </summary>
        /// <param name="exceptionExpr">Expression producing the exception to rethrow.</param>
        /// <param name="exceptionType">The bound <see cref="System.Exception"/> type symbol.</param>
        /// <returns>A bound expression statement invoking <c>Capture(...).Throw()</c>.</returns>
        private static BoundStatement BuildEdiCaptureThrow(BoundExpression exceptionExpr, TypeSymbol exceptionType)
        {
            var ediType = typeof(System.Runtime.ExceptionServices.ExceptionDispatchInfo);
            var captureMethod = ediType.GetMethod(
                nameof(System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture),
                new[] { typeof(Exception) });
            var throwMethod = ediType.GetMethod(
                nameof(System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw),
                Type.EmptyTypes);

            var ediClass = new ImportedClassSymbol(ediType, declaration: null);
            var captureFn = new ImportedFunctionSymbol(captureMethod.Name, ediClass, captureMethod, declaration: null);

            var captureCall = new BoundImportedCallExpression(
                null,
                captureFn,
                ImmutableArray.Create(exceptionExpr));

            var throwCall = new BoundImportedInstanceCallExpression(
                null,
                captureCall,
                throwMethod,
                TypeSymbol.Void,
                ImmutableArray<BoundExpression>.Empty);

            return new BoundExpressionStatement(null, throwCall);
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
