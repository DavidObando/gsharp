// <copyright file="AsyncExceptionHandlerRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
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
/// <para><b>Pattern C — non-fall-through exits out of a try whose finally
/// awaits (issue #1484):</b> Every way control leaves a <c>try</c> whose
/// <c>finally</c> awaits must run the finally <i>after</i> the awaited work
/// completes and only then resume that exit. The exception exit is already
/// generalized by Pattern B; Pattern C generalizes the remaining
/// non-fall-through exits — <c>return</c> and the intra-method branches
/// (<c>goto</c>/<c>break</c>/<c>continue</c>, all of which reach this pass as
/// <see cref="BoundGotoStatement"/>/<see cref="BoundConditionalGotoStatement"/>
/// after the general <see cref="Lowerer"/> desugars loops) — that target a
/// label outside the protected region (or, for <c>return</c>, leave the
/// method). Mirroring the pending-exception machinery, each such exit is
/// replaced by an assignment to a small <c>pendingBranch</c> discriminator
/// (plus a <c>pendingReturnValue</c> local for value returns, captured at the
/// point of the original return so evaluation order is preserved) followed by a
/// <c>goto</c> to the lifted-finally tail. After the finally body and the
/// pending-exception rethrow, a dispatch on the discriminator resumes the
/// captured exit:</para>
/// <code>
/// int pendingBranch = 0;          // 0 == fall-through
/// T pendingReturnValue = default; // only when a value-return is captured
/// try { body; /* `return v;` => { pendingReturnValue = v; pendingBranch = 1; goto finallyTail; } */ }
/// catch (Exception ex) { pendingException = ex; }
/// finallyTail:
/// finallyBody;                    // await is now outside the finally region
/// if (pendingException != null) { ...Capture(pendingException).Throw(); }
/// if (pendingBranch == 1) { return pendingReturnValue; }  // resume captured return
/// if (pendingBranch == 2) { goto someOuterLabel; }        // resume captured goto/break/continue
/// // pendingBranch == 0 falls through and continues normally
/// </code>
/// <para>The rewrite is compositional: an exit that crosses multiple awaited
/// finallys is captured one level at a time, because each level's dispatch
/// re-emits a real <c>return</c>/<c>goto</c> that the next enclosing lifted
/// try captures in turn. The discriminator and pending-return-value locals are
/// ordinary user-style locals, so <see cref="AsyncCaptureWalker"/> hoists them
/// into state-machine fields exactly like the pending-exception local, keeping
/// them live across the awaited finally.</para>
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
        // Reference-keyed "does this subtree contain an await" cache shared by every
        // HasAwait probe this Rewriter instance makes, so repeated queries over the
        // same nested try/catch/finally subtrees are O(1) after the first visit
        // (issue #1625). Safe for the whole pass: rewriting always produces new node
        // instances (see BoundTreeRewriter), so a memoized entry is never observed
        // for a node that was actually mutated.
        private readonly Dictionary<BoundNode, bool> awaitMemo = AsyncBoundTreeQueries.CreateHasAwaitMemo();

        private int localOrdinal;

        /// <summary>
        /// Creates a fresh synthesized local with a deterministic, collision-free
        /// name. Used by the Pattern C exit funneler for its pending-branch
        /// discriminator and pending-return-value locals.
        /// </summary>
        /// <param name="prefix">A short role hint embedded in the generated name.</param>
        /// <param name="type">The local's type.</param>
        /// <returns>The new local variable symbol.</returns>
        internal LocalVariableSymbol NewLocal(string prefix, TypeSymbol type)
        {
            return new LocalVariableSymbol($"<>{prefix}_{localOrdinal++}", isReadOnly: false, type);
        }

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
                if (HasAwait(clause.Body))
                {
                    anyCatchHasAwait = true;
                    break;
                }
            }

            bool finallyHasAwait = rewrittenFinally != null && HasAwait(rewrittenFinally);

            // The finally must be lifted out of the protected region in either
            // of two cases:
            //   1) The finally itself contains an await (the CLR forbids await
            //      inside a finally handler).
            //   2) The try body contains an await. Without lifting, the IL
            //      `leave` emitted for async suspension would execute the
            //      finally on every yield, which is semantically wrong (the
            //      finally should run only when the try completes normally,
            //      exceptionally, or via early exit — not on async suspension).
            bool tryBodyHasAwait = HasAwait(rewrittenTry);
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

        private bool HasAwait(BoundStatement statement) => AsyncBoundTreeQueries.HasAwait(statement, awaitMemo);

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
                if (HasAwait(clause.Body))
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
            // Pattern C (issue #1484): funnel every non-fall-through exit that
            // leaves the try body through the lifted finally. Each `return` or
            // intra-method branch (`goto`/`break`/`continue`, all surfaced as
            // BoundGotoStatement/BoundConditionalGotoStatement after lowering)
            // whose target lies outside the protected region is replaced by an
            // assignment to a pending-branch discriminator (and, for value
            // returns, a pending-return-value local captured at the point of the
            // original return so evaluation order is preserved) plus a `goto` to
            // the lifted-finally tail. The captured exits are re-emitted after
            // the finally body and the pending-exception rethrow.
            var funneler = new ExitFunneler(this, LabelCollector.Collect(tryBody));
            tryBody = funneler.Funnel(tryBody);
            if (funneler.HasCapturedExits)
            {
                statements.Add(new BoundVariableDeclaration(
                    null,
                    funneler.PendingBranchLocal,
                    new BoundLiteralExpression(null, 0)));
                if (funneler.PendingReturnValueLocal != null)
                {
                    // default(T): correct for any return type — `0`/zeroed bytes
                    // for value types (a typed null literal would emit an invalid
                    // `ldnull` for e.g. int32) and null for reference types. The
                    // value is always overwritten before the dispatch reads it.
                    statements.Add(new BoundVariableDeclaration(
                        null,
                        funneler.PendingReturnValueLocal,
                        new BoundDefaultExpression(null, funneler.PendingReturnValueLocal.Type)));
                }
            }

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
                if (HasAwait(clause.Body))
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
            // when that specific typed catch actually fired. Keep the lifted
            // handlers in a try/catch so a rethrow (or a new exception from an
            // awaited handler) is captured until the lifted finally has run.
            var liftedHandlerStatements = ImmutableArray.CreateBuilder<BoundStatement>();
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

                liftedHandlerStatements.Add(new BoundConditionalGotoStatement(null, endLabel, condition, jumpIfTrue: true));

                var rebind = new BoundVariableDeclaration(
                    null,
                    original.Variable,
                    new BoundVariableExpression(null, captureLocal));
                liftedHandlerStatements.Add(rebind);

                if (body is BoundBlockStatement block)
                {
                    foreach (var stmt in block.Statements)
                    {
                        liftedHandlerStatements.Add(stmt);
                    }
                }
                else
                {
                    liftedHandlerStatements.Add(body);
                }

                // Clear pendingException after handling so the rethrow below doesn't fire
                liftedHandlerStatements.Add(new BoundExpressionStatement(
                    null,
                    new BoundAssignmentExpression(
                        null,
                        pendingExLocal,
                        new BoundLiteralExpression(null, null, TypeSymbol.Null))));
                liftedHandlerStatements.Add(new BoundLabelStatement(null, endLabel));
            }

            if (liftedHandlerStatements.Count > 0)
            {
                var liftedEx = new LocalVariableSymbol(
                    $"<>ex_lifted_{localOrdinal++}", isReadOnly: false, exceptionType);
                var captureLiftedEx = new BoundExpressionStatement(
                    null,
                    new BoundAssignmentExpression(
                        null,
                        pendingExLocal,
                        new BoundVariableExpression(null, liftedEx)));
                statements.Add(new BoundTryStatement(
                    null,
                    new BoundBlockStatement(null, liftedHandlerStatements.ToImmutable()),
                    ImmutableArray.Create(new BoundCatchClause(
                        exceptionType,
                        liftedEx,
                        new BoundBlockStatement(
                            null,
                            ImmutableArray.Create<BoundStatement>(captureLiftedEx)))),
                    finallyBlock: null));
            }

            // Pattern C: place the lifted-finally tail label that funneled exits
            // branch to. It sits AFTER the lifted catch handlers and BEFORE the
            // finally body so a captured `return`/`goto`/`break`/`continue` runs
            // the finally exactly like the normal-completion and exception paths.
            if (funneler.HasCapturedExits)
            {
                statements.Add(new BoundLabelStatement(null, funneler.FinallyTailLabel));
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

            // Pattern C: dispatch the captured branch AFTER the pending-exception
            // rethrow. The exception and branch exits are mutually exclusive
            // (a funneled `goto finallyTail` is a `leave`, not a throw, so it
            // never sets pendingException), and ordering the rethrow first keeps
            // the exception semantics identical to Pattern B. A discriminator of
            // 0 means fall-through and continues normally past the dispatch.
            if (funneler.HasCapturedExits)
            {
                foreach (var arm in funneler.DispatchArms)
                {
                    var skipLabel = MakeLabel("branch_skip");
                    var armCondition = new BoundBinaryExpression(
                        null,
                        new BoundVariableExpression(null, funneler.PendingBranchLocal),
                        BoundBinaryOperator.Bind(
                            CodeAnalysis.Syntax.SyntaxKind.EqualsEqualsToken,
                            TypeSymbol.Int32,
                            TypeSymbol.Int32),
                        new BoundLiteralExpression(null, arm.Discriminator));

                    // if (pendingBranch != value) goto skip; <exit>; skip:
                    statements.Add(new BoundConditionalGotoStatement(null, skipLabel, armCondition, jumpIfTrue: false));
                    statements.Add(arm.Exit);
                    statements.Add(new BoundLabelStatement(null, skipLabel));
                }
            }
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

        /// <summary>
        /// One captured Pattern C exit: a discriminator value paired with the
        /// statement to re-emit (a <c>return</c> of the pending-return-value, or
        /// a <c>goto</c> to the original target) when the dispatch after the
        /// lifted finally observes that value.
        /// </summary>
        private readonly struct DispatchArm
        {
            public DispatchArm(int discriminator, BoundStatement exit)
            {
                Discriminator = discriminator;
                Exit = exit;
            }

            public int Discriminator { get; }

            public BoundStatement Exit { get; }
        }

        /// <summary>
        /// Collects every label DEFINED inside a statement subtree (the targets
        /// of <see cref="BoundLabelStatement"/>). The Pattern C exit funneler
        /// uses this set to decide whether a <c>goto</c>/conditional-goto leaves
        /// the protected region: a branch whose target label is in this set
        /// stays inside the try and must NOT run the lifted finally, whereas a
        /// branch to any other label (or a <c>return</c>) exits the try and is
        /// funneled.
        /// </summary>
        private sealed class LabelCollector : BoundTreeWalker
        {
            private readonly HashSet<BoundLabel> labels = new HashSet<BoundLabel>();

            public static HashSet<BoundLabel> Collect(BoundStatement body)
            {
                var collector = new LabelCollector();
                collector.VisitStatement(body);
                return collector.labels;
            }

            public override void VisitStatement(BoundStatement node)
            {
                if (node is BoundLabelStatement labelStatement)
                {
                    labels.Add(labelStatement.Label);
                }

                base.VisitStatement(node);
            }
        }

        /// <summary>
        /// Rewrites the try body of a finally-with-await, replacing every
        /// non-fall-through exit that leaves the try (a <c>return</c>, or a
        /// <c>goto</c>/conditional-goto whose target label is outside the try)
        /// with a pending-branch capture followed by <c>goto finallyTail</c>.
        /// The captured exits are surfaced via <see cref="DispatchArms"/> so the
        /// caller can re-emit them after the lifted finally body. Implements
        /// Pattern C (issue #1484) symmetrically with the pending-exception
        /// machinery.
        /// </summary>
        private sealed class ExitFunneler : BoundTreeRewriter
        {
            private const int ReturnDiscriminator = 1;

            private readonly Rewriter owner;
            private readonly HashSet<BoundLabel> innerLabels;
            private readonly Dictionary<BoundLabel, int> gotoDiscriminators = new Dictionary<BoundLabel, int>();
            private readonly List<DispatchArm> dispatchArms = new List<DispatchArm>();

            private BoundLabel finallyTailLabel;
            private LocalVariableSymbol pendingBranchLocal;
            private LocalVariableSymbol pendingReturnValueLocal;
            private bool returnCaptured;
            private int nextGotoDiscriminator = ReturnDiscriminator + 1;

            public ExitFunneler(Rewriter owner, HashSet<BoundLabel> innerLabels)
            {
                this.owner = owner;
                this.innerLabels = innerLabels;
            }

            /// <summary>Gets a value indicating whether any exit was captured.</summary>
            public bool HasCapturedExits => dispatchArms.Count > 0;

            /// <summary>Gets the lifted-finally tail label (only valid once an exit is captured).</summary>
            public BoundLabel FinallyTailLabel => finallyTailLabel;

            /// <summary>Gets the pending-branch discriminator local (only valid once an exit is captured).</summary>
            public LocalVariableSymbol PendingBranchLocal => pendingBranchLocal;

            /// <summary>Gets the pending-return-value local, or null when no value-return was captured.</summary>
            public LocalVariableSymbol PendingReturnValueLocal => pendingReturnValueLocal;

            /// <summary>Gets the captured exits, in first-encounter order.</summary>
            public IReadOnlyList<DispatchArm> DispatchArms => dispatchArms;

            public BoundStatement Funnel(BoundStatement body) => RewriteStatement(body);

            protected override BoundStatement RewriteReturnStatement(BoundReturnStatement node)
            {
                // A `return` always leaves the try (and the method), so it is
                // always funneled. The return expression is evaluated here, in
                // the try body, and stashed into the pending-return-value local
                // BEFORE the finally runs; the actual transfer happens after.
                EnsureFinallyTail();
                var stmts = ImmutableArray.CreateBuilder<BoundStatement>();

                if (node.Expression != null)
                {
                    if (pendingReturnValueLocal == null)
                    {
                        pendingReturnValueLocal = owner.NewLocal("pending_ret", node.Expression.Type);
                    }

                    stmts.Add(new BoundExpressionStatement(
                        null,
                        new BoundAssignmentExpression(null, pendingReturnValueLocal, node.Expression)));
                }

                if (!returnCaptured)
                {
                    returnCaptured = true;
                    var resume = node.Expression != null
                        ? new BoundReturnStatement(null, new BoundVariableExpression(null, pendingReturnValueLocal), node.IsRef)
                        : new BoundReturnStatement(null, null);
                    dispatchArms.Add(new DispatchArm(ReturnDiscriminator, resume));
                }

                stmts.Add(AssignBranch(ReturnDiscriminator));
                stmts.Add(new BoundGotoStatement(null, finallyTailLabel));
                return new BoundBlockStatement(null, stmts.ToImmutable());
            }

            protected override BoundStatement RewriteGotoStatement(BoundGotoStatement node)
            {
                if (innerLabels.Contains(node.Label))
                {
                    // Target is inside the try — stays in the protected region.
                    return node;
                }

                EnsureFinallyTail();
                var discriminator = GetGotoDiscriminator(node.Label);
                return new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(
                    AssignBranch(discriminator),
                    new BoundGotoStatement(null, finallyTailLabel)));
            }

            protected override BoundStatement RewriteConditionalGotoStatement(BoundConditionalGotoStatement node)
            {
                if (innerLabels.Contains(node.Label))
                {
                    return node;
                }

                EnsureFinallyTail();
                var discriminator = GetGotoDiscriminator(node.Label);

                // if (cond == JumpIfTrue) { pendingBranch = d; goto finallyTail; }
                // Re-emit the condition once, jumping past the capture when the
                // branch is NOT taken (the original JumpIfTrue is negated for the
                // skip test).
                var skipLabel = MakeLabel("exit_skip");
                return new BoundBlockStatement(null, ImmutableArray.Create<BoundStatement>(
                    new BoundConditionalGotoStatement(null, skipLabel, node.Condition, jumpIfTrue: !node.JumpIfTrue),
                    AssignBranch(discriminator),
                    new BoundGotoStatement(null, finallyTailLabel),
                    new BoundLabelStatement(null, skipLabel)));
            }

            private int GetGotoDiscriminator(BoundLabel target)
            {
                if (!gotoDiscriminators.TryGetValue(target, out var discriminator))
                {
                    discriminator = nextGotoDiscriminator++;
                    gotoDiscriminators[target] = discriminator;
                    dispatchArms.Add(new DispatchArm(discriminator, new BoundGotoStatement(null, target)));
                }

                return discriminator;
            }

            private BoundStatement AssignBranch(int discriminator)
            {
                return new BoundExpressionStatement(
                    null,
                    new BoundAssignmentExpression(
                        null,
                        pendingBranchLocal,
                        new BoundLiteralExpression(null, discriminator)));
            }

            private void EnsureFinallyTail()
            {
                if (finallyTailLabel == null)
                {
                    finallyTailLabel = MakeLabel("finally_tail");
                    pendingBranchLocal = owner.NewLocal("pending_branch", TypeSymbol.Int32);
                }
            }
        }
    }
}
