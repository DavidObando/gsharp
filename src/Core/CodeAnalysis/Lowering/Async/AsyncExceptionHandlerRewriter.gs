// <copyright file="AsyncExceptionHandlerRewriter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Runtime.ExceptionServices

/// Rewrites `try/catch` and `try/finally` statements whose handlers
/// contain `await` into pending-exception forms that can be processed by
/// the subsequent (cref:SpillSequenceSpiller) and
/// (cref:MoveNextBodyRewriter) passes.
/// @remarks The CLR does not allow suspension inside a catch or finally handler.
/// This pass lifts the handler body out of the protected region by capturing
/// exceptions into a pending-exception local and executing the original handler
/// body after the try statement completes.
///
/// <b>Pattern A — try/catch with await in catch:</b>
///
/// ```
/// Exception pendingException = null;
/// T? capture_i = null;                 // per-clause capture of original type
/// try { body; }
/// catch (T e) { capture_i = e; pendingException = e; }   // KEEP ORIGINAL TYPE
/// if (capture_i != null) {
/// T e = capture_i;                 // rebind original variable
/// handlerBody;                     // await is now outside the handler
/// }
/// ```
///
/// Keeping the catch typed (instead of widening to `Exception`) is
/// essential for correctness: it ensures the CLR catch dispatch only fires for
/// the original handler's exception type, so subsequent catch arms — and the
/// rethrow paths for unmatched exceptions — keep their original semantics
/// (issue #419).
///
/// <b>Pattern B — try/finally with await in finally:</b>
///
/// ```
/// Exception pendingException = null;
/// try { body; }
/// catch (Exception ex) { pendingException = ex; }
/// finallyBody;   // await is now outside the finally region
/// if (pendingException != null) {
/// System.Runtime.ExceptionServices.ExceptionDispatchInfo
/// .Capture(pendingException).Throw();   // preserve original stack trace (#418)
/// }
/// ```
///
/// <b>Pattern C — non-fall-through exits out of a try whose finally
/// awaits (issue #1484):</b> Every way control leaves a `try` whose
/// `finally` awaits must run the finally <i>after</i> the awaited work
/// completes and only then resume that exit. The exception exit is already
/// generalized by Pattern B; Pattern C generalizes the remaining
/// non-fall-through exits — `return` and the intra-method branches
/// (`goto`/`break`/`continue`, all of which reach this pass as
/// (cref:BoundGotoStatement)/(cref:BoundConditionalGotoStatement)
/// after the general (cref:Lowerer) desugars loops) — that target a
/// label outside the protected region (or, for `return`, leave the
/// method). Mirroring the pending-exception machinery, each such exit is
/// replaced by an assignment to a small `pendingBranch` discriminator
/// (plus a `pendingReturnValue` local for value returns, captured at the
/// point of the original return so evaluation order is preserved) followed by a
/// `goto` to the lifted-finally tail. After the finally body and the
/// pending-exception rethrow, a dispatch on the discriminator resumes the
/// captured exit:
///
/// ```
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
/// ```
///
/// The rewrite is compositional: an exit that crosses multiple awaited
/// finallys is captured one level at a time, because each level's dispatch
/// re-emits a real `return`/`goto` that the next enclosing lifted
/// try captures in turn. The discriminator and pending-return-value locals are
/// ordinary user-style locals, so (cref:AsyncCaptureWalker) hoists them
/// into state-machine fields exactly like the pending-exception local, keeping
/// them live across the awaited finally.
shared class AsyncExceptionHandlerRewriter {
    private class Rewriter : BoundTreeRewriter {
        // Reference-keyed "does this subtree contain an await" cache shared by every
        // HasAwait probe this Rewriter instance makes, so repeated queries over the
        // same nested try/catch/finally subtrees are O(1) after the first visit
        // (issue #1625). Safe for the whole pass: rewriting always produces new node
        // instances (see BoundTreeRewriter), so a memoized entry is never observed
        // for a node that was actually mutated.
        private let awaitMemo Dictionary[BoundNode, bool] = AsyncBoundTreeQueries.CreateHasAwaitMemo()

        private let preserveFinallyAcrossSuspension bool
        private var localOrdinal int32

        init(preserveFinallyAcrossSuspension bool) {
            this.preserveFinallyAcrossSuspension = preserveFinallyAcrossSuspension
        }

        /// Creates a fresh synthesized local with a deterministic, collision-free
        /// name. Used by the Pattern C exit funneler for its pending-branch
        /// discriminator and pending-return-value locals.
        /// @param prefix A short role hint embedded in the generated name.
        /// @param type The local's type.
        /// @returns The new local variable symbol.
        internal func NewLocal(prefix string, type TypeSymbol) LocalVariableSymbol {
            return LocalVariableSymbol("<>${prefix}_${localOrdinal++}", isReadOnly: false, type)
        }

        protected override func RewriteTryStatement(node BoundTryStatement) BoundStatement {
            // First, recursively rewrite children (nested try statements).
            let rewrittenTry = RewriteStatement(node.TryBlock)
            let rewrittenClauses = ImmutableArray.CreateBuilder[BoundCatchClause]()
            for clause in node.CatchClauses {
                let rewrittenBody = RewriteStatement(clause.Body)
                rewrittenClauses.Add(clause.WithBody(rewrittenBody))
            }
            let rewrittenFinally BoundStatement? = if node.FinallyBlock != nil {
                RewriteStatement(node.FinallyBlock)
            } else {
                default(BoundStatement?)
            }
            var anyCatchHasAwait = false
            for clause in rewrittenClauses {
                if HasAwait(clause.Body) {
                    anyCatchHasAwait = true
                    break
                }
            }
            let finallyHasAwait = rewrittenFinally != nil && HasAwait(rewrittenFinally)
            // The finally must be lifted out of the protected region in either
            // of two cases:
            //   1) The finally itself contains an await (the CLR forbids await
            //      inside a finally handler).
            //   2) The try body contains an await. Without lifting, the IL
            //      `leave` emitted for async suspension would execute the
            //      finally on every yield, which is semantically wrong (the
            //      finally should run only when the try completes normally,
            //      exceptionally, or via early exit — not on async suspension).
            let tryBodyHasAwait = HasAwait(rewrittenTry)
            // The finally to lift, or null when this try keeps its finally in
            // place. Holding the block rather than a bool keeps the
            // non-nullness that RewriteFinallyWithAwait requires visible.
            let finallyToLift BoundStatement? = if finallyHasAwait ||
                (tryBodyHasAwait && !preserveFinallyAcrossSuspension) {
                rewrittenFinally
            } else {
                default(BoundStatement?)
            }
            if !anyCatchHasAwait && finallyToLift == nil {
                // No handler-await and no need to lift the finally — pass
                // through (possibly with rewritten children).
                if rewrittenTry == node.TryBlock &&
                    !CatchesChanged(node.CatchClauses, rewrittenClauses) &&
                    rewrittenFinally == node.FinallyBlock {
                    return node
                }
                return BoundTryStatement(nil, rewrittenTry, rewrittenClauses.ToImmutable(), rewrittenFinally)
            }
            // We need to rewrite. Build the output statement list.
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            let exceptionType = TypeSymbol.FromClrTypeWithoutNullability(
                typeof(Exception),
                NullabilityFreeReason.TypeLiteral
            )
            let nullableExceptionType = NullableTypeSymbol.Get(exceptionType)
            let pendingExLocal = LocalVariableSymbol(
                "<>pending_ex_${localOrdinal++}",
                isReadOnly: false,
                nullableExceptionType
            )
            let pendingExNullInit = BoundVariableDeclaration(
                nil,
                pendingExLocal,
                BoundLiteralExpression(nil, nil, nullableExceptionType)
            )
            statements.Add(pendingExNullInit)
            if finallyToLift != nil {
                // Pattern B: try/finally with await in finally
                // Also handles try/catch/finally where finally has await:
                // we keep catch clauses that don't have await as-is on the inner try,
                // but add a catch-all to capture into pendingException.
                RewriteFinallyWithAwait(
                    statements,
                    rewrittenTry,
                    rewrittenClauses,
                    finallyToLift,
                    pendingExLocal,
                    exceptionType,
                    anyCatchHasAwait
                )
            } else {
                // Pattern A: try/catch with await in catch (finally has no await or is absent)
                RewriteCatchWithAwait(
                    statements,
                    rewrittenTry,
                    rewrittenClauses,
                    rewrittenFinally,
                    pendingExLocal,
                    exceptionType
                )
            }
            return BoundBlockStatement(nil, statements.ToImmutable())
        }

        private func HasAwait(statement BoundStatement) bool -> AsyncBoundTreeQueries.HasAwait(statement, awaitMemo)

        private func RewriteCatchWithAwait(
            statements ImmutableArray[BoundStatement].Builder,
            tryBody BoundStatement,
            catchClauses ImmutableArray[BoundCatchClause].Builder,
            finallyBlock BoundStatement?,
            pendingExLocal LocalVariableSymbol,
            exceptionType TypeSymbol
        ) {
            // For each catch clause with await, replace the body with
            //   capture_i = e; pendingException = e;
            // and emit the real body after the try guarded by `if (capture_i != null)`.
            // The catch clause KEEPS the original exception type so the CLR's
            // catch dispatch matches only the intended type (issue #419 — without
            // this, widening to System.Exception silently catches unrelated
            // exceptions and shadows subsequent catch arms).
            //
            // Catch clauses without await stay in-place.
            let newClauses = ImmutableArray.CreateBuilder[BoundCatchClause]()
            let afterTryHandlers = List[(Variable VariableSymbol, Body BoundStatement, Capture LocalVariableSymbol)]()
            for rawClause in catchClauses {
                if HasAwait(rawClause.Body) {
                    // ADR-0177: an unbound `catch (Type)` / bare `catch` has no
                    // variable, but every lift path below copies the caught
                    // exception into a capture local and rebinds it after the
                    // try. Give such a clause a synthesized variable to read.
                    let clause = EnsureCatchVariable(rawClause)
                    let caught = Invariant.Required(
                        clause.Variable,
                        "EnsureCatchVariable guarantees a bound catch variable",
                        expression: "clause.Variable"
                    )
                    // Per-clause capture local of nullable-of-original-type.
                    // A reference-type nullable shares the CLR representation,
                    // so this is a metadata-only annotation.
                    let captureType = NullableTypeSymbol.Get(clause.ExceptionType)
                    let captureLocal = LocalVariableSymbol(
                        "<>catch_capture_${localOrdinal++}",
                        isReadOnly: false,
                        captureType
                    )
                    statements.Add(
                        BoundVariableDeclaration(nil, captureLocal, BoundLiteralExpression(nil, nil, TypeSymbol.Null))
                    )
                    // Replace body: capture_i = e; pendingException = e;
                    let assignCapture = BoundExpressionStatement(
                        nil,
                        BoundAssignmentExpression(nil, captureLocal, BoundVariableExpression(nil, caught))
                    )
                    let assignPending = BoundExpressionStatement(
                        nil,
                        BoundAssignmentExpression(nil, pendingExLocal, BoundVariableExpression(nil, caught))
                    )
                    // The trampoline keeps the clause's ADR-0177 `when` filter, so
                    // the CLR still runs it in the first pass and a false filter
                    // still declines to the next sibling handler.
                    let typedCatchClause = BoundCatchClause(
                        clause.ExceptionType,
                        caught,
                        clause.Filter,
                        BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](assignCapture, assignPending)),
                        clause.ExitsThroughFinally
                    )
                    newClauses.Add(typedCatchClause)
                    afterTryHandlers.Add((caught, LiftRethrows(caught, clause), captureLocal))
                } else {
                    newClauses.Add(rawClause)
                }
            }
            let tryStmt = BoundTryStatement(nil, tryBody, newClauses.ToImmutable(), finallyBlock)
            statements.Add(tryStmt)
            // After the try: for each lifted clause emit
            //   if (capture_i == null) goto endLabel;
            //   T e = capture_i;
            //   handlerBody;
            //   endLabel:
            // The per-clause null check ensures the handler body only runs when
            // its specific catch fired.
            for (caughtVariable, body, captureLocal) in afterTryHandlers {
                let endLabel = AsyncExceptionHandlerRewriter.MakeLabel("catch_end")
                let captureRef = BoundVariableExpression(nil, captureLocal)
                let nullLit = BoundLiteralExpression(nil, nil, TypeSymbol.Null)
                let condition = BoundBinaryExpression(
                    nil,
                    captureRef,
                    Invariant.Required(
                        BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, captureLocal.Type, TypeSymbol.Null),
                        "captured exception locals support nil equality",
                        expression: `BoundBinaryOperator.Bind(
                            CodeAnalysis.Syntax.SyntaxKind.EqualsEqualsToken,
                            captureLocal.Type,
                            TypeSymbol.Null)`
                    ),
                    nullLit
                )
                statements.Add(BoundConditionalGotoStatement(nil, endLabel, condition, jumpIfTrue: true))
                // Rebind the original catch variable: T e = capture_i;
                let rebind = BoundVariableDeclaration(nil, caughtVariable, BoundVariableExpression(nil, captureLocal))
                statements.Add(rebind)
                // Emit the handler body
                if body is BoundBlockStatement block {
                    for stmt in block.Statements {
                        statements.Add(stmt)
                    }
                } else {
                    statements.Add(body)
                }
                statements.Add(BoundLabelStatement(nil, endLabel))
            }
        }

        private func RewriteFinallyWithAwait(
            statements ImmutableArray[BoundStatement].Builder,
            tryBody BoundStatement,
            catchClauses ImmutableArray[BoundCatchClause].Builder,
            finallyBlock BoundStatement,
            pendingExLocal LocalVariableSymbol,
            exceptionType TypeSymbol,
            anyCatchHasAwait bool
        ) {
            var tryBody = tryBody
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
            let funneler = AsyncExceptionHandlerRewriter.Rewriter.ExitFunneler(this, LabelCollector.Collect(tryBody))
            tryBody = funneler.Funnel(tryBody)
            if funneler.HasCapturedExits {
                statements.Add(
                    BoundVariableDeclaration(
                        nil,
                        Invariant.Required(
                            funneler.PendingBranchLocal,
                            "funneler.HasCapturedExits is true, and EnsureFinallyTail creates this alongside the first captured exit",
                            expression: "funneler.PendingBranchLocal"
                        ),
                        BoundLiteralExpression(nil, 0)
                    )
                )
                if funneler.PendingReturnValueLocal != nil {
                    // default(T): correct for any return type — `0`/zeroed bytes
                    // for value types (a typed null literal would emit an invalid
                    // `ldnull` for e.g. int32) and null for reference types. The
                    // value is always overwritten before the dispatch reads it.
                    statements.Add(
                        BoundVariableDeclaration(
                            nil,
                            funneler.PendingReturnValueLocal!!,
                            BoundDefaultExpression(nil, funneler.PendingReturnValueLocal!!.Type)
                        )
                    )
                }
            }
            // Build inner try: original try body + original catches.
            // Typed catches with await KEEP their original type (issue #419)
            // and capture into a per-clause local plus pendingException so the
            // post-finally lifted body can dispatch only when the typed catch
            // actually fired. A final catch-all (Exception) captures any
            // remaining exceptions into pendingException so the finally can
            // run regardless.
            let innerClauses = ImmutableArray.CreateBuilder[BoundCatchClause]()
            let liftedCatchHandlers = List[
                (Variable VariableSymbol, Body BoundStatement, Capture LocalVariableSymbol)
            ]()
            for rawClause in catchClauses {
                if HasAwait(rawClause.Body) {
                    // ADR-0177: an unbound `catch (Type)` / bare `catch` has no
                    // variable, but every lift path below copies the caught
                    // exception into a capture local and rebinds it after the
                    // try. Give such a clause a synthesized variable to read.
                    let clause = EnsureCatchVariable(rawClause)
                    let caught = Invariant.Required(
                        clause.Variable,
                        "EnsureCatchVariable guarantees a bound catch variable",
                        expression: "clause.Variable"
                    )
                    // Per-clause capture local of nullable-of-original-type.
                    let captureType = NullableTypeSymbol.Get(clause.ExceptionType)
                    let captureLocal = LocalVariableSymbol(
                        "<>catch_capture_${localOrdinal++}",
                        isReadOnly: false,
                        captureType
                    )
                    statements.Add(
                        BoundVariableDeclaration(nil, captureLocal, BoundLiteralExpression(nil, nil, TypeSymbol.Null))
                    )
                    // Capture into per-clause local and into pending; lift body after finally.
                    let assignCapture = BoundExpressionStatement(
                        nil,
                        BoundAssignmentExpression(nil, captureLocal, BoundVariableExpression(nil, caught))
                    )
                    let assignPending = BoundExpressionStatement(
                        nil,
                        BoundAssignmentExpression(nil, pendingExLocal, BoundVariableExpression(nil, caught))
                    )
                    // The trampoline keeps the clause's ADR-0177 `when` filter, so
                    // the CLR still runs it in the first pass and a false filter
                    // still declines to the next sibling handler.
                    let typedCatchClause = BoundCatchClause(
                        clause.ExceptionType,
                        caught,
                        clause.Filter,
                        BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](assignCapture, assignPending)),
                        clause.ExitsThroughFinally
                    )
                    innerClauses.Add(typedCatchClause)
                    liftedCatchHandlers.Add((caught, LiftRethrows(caught, clause), captureLocal))
                } else {
                    innerClauses.Add(rawClause)
                }
            }
            // Add catch-all for the finally pattern:
            // catch (Exception ex) { pendingException = ex; }
            let catchAllVar = LocalVariableSymbol("<>ex_finally_${localOrdinal++}", isReadOnly: false, exceptionType)
            let catchAllAssign = BoundExpressionStatement(
                nil,
                BoundAssignmentExpression(nil, pendingExLocal, BoundVariableExpression(nil, catchAllVar))
            )
            let catchAllBody = BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](catchAllAssign))
            let catchAllClause = BoundCatchClause(exceptionType, catchAllVar, catchAllBody)
            innerClauses.Add(catchAllClause)
            let innerTry = BoundTryStatement(nil, tryBody, innerClauses.ToImmutable(), finallyBlock: nil)
            statements.Add(innerTry)
            // Emit lifted catch handlers (for catch-with-await in try/catch/finally).
            // Each handler is guarded by its per-clause capture so it only runs
            // when that specific typed catch actually fired. Keep the lifted
            // handlers in a try/catch so a rethrow (or a new exception from an
            // awaited handler) is captured until the lifted finally has run.
            let liftedHandlerStatements = ImmutableArray.CreateBuilder[BoundStatement]()
            for (caughtVariable, body, captureLocal) in liftedCatchHandlers {
                let endLabel = AsyncExceptionHandlerRewriter.MakeLabel("liftcatch_end")
                let captureRef = BoundVariableExpression(nil, captureLocal)
                let nullLit = BoundLiteralExpression(nil, nil, TypeSymbol.Null)
                let condition = BoundBinaryExpression(
                    nil,
                    captureRef,
                    Invariant.Required(
                        BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, captureLocal.Type, TypeSymbol.Null),
                        "captured exception locals support nil equality",
                        expression: `BoundBinaryOperator.Bind(
                            CodeAnalysis.Syntax.SyntaxKind.EqualsEqualsToken,
                            captureLocal.Type,
                            TypeSymbol.Null)`
                    ),
                    nullLit
                )
                liftedHandlerStatements.Add(BoundConditionalGotoStatement(nil, endLabel, condition, jumpIfTrue: true))
                let rebind = BoundVariableDeclaration(nil, caughtVariable, BoundVariableExpression(nil, captureLocal))
                liftedHandlerStatements.Add(rebind)
                if body is BoundBlockStatement block {
                    for stmt in block.Statements {
                        liftedHandlerStatements.Add(stmt)
                    }
                } else {
                    liftedHandlerStatements.Add(body)
                }
                // Clear pendingException after handling so the rethrow below doesn't fire
                liftedHandlerStatements.Add(
                    BoundExpressionStatement(
                        nil,
                        BoundAssignmentExpression(
                            nil,
                            pendingExLocal,
                            BoundLiteralExpression(nil, nil, TypeSymbol.Null)
                        )
                    )
                )
                liftedHandlerStatements.Add(BoundLabelStatement(nil, endLabel))
            }
            if liftedHandlerStatements.Count > 0 {
                let liftedEx = LocalVariableSymbol("<>ex_lifted_${localOrdinal++}", isReadOnly: false, exceptionType)
                let captureLiftedEx = BoundExpressionStatement(
                    nil,
                    BoundAssignmentExpression(nil, pendingExLocal, BoundVariableExpression(nil, liftedEx))
                )
                statements.Add(
                    BoundTryStatement(
                        nil,
                        BoundBlockStatement(nil, liftedHandlerStatements.ToImmutable()),
                        ImmutableArray.Create(
                            BoundCatchClause(
                                exceptionType,
                                liftedEx,
                                BoundBlockStatement(nil, ImmutableArray.Create[BoundStatement](captureLiftedEx))
                            )
                        ),
                        finallyBlock: nil
                    )
                )
            }
            // Pattern C: place the lifted-finally tail label that funneled exits
            // branch to. It sits AFTER the lifted catch handlers and BEFORE the
            // finally body so a captured `return`/`goto`/`break`/`continue` runs
            // the finally exactly like the normal-completion and exception paths.
            if funneler.HasCapturedExits {
                statements.Add(
                    BoundLabelStatement(
                        nil,
                        Invariant.Required(
                            funneler.FinallyTailLabel,
                            "funneler.HasCapturedExits is true, and EnsureFinallyTail creates this alongside the first captured exit",
                            expression: "funneler.FinallyTailLabel"
                        )
                    )
                )
            }
            // Emit the finally body (now outside any handler region)
            if finallyBlock is BoundBlockStatement finallyBlockStmt {
                for stmt in finallyBlockStmt.Statements {
                    statements.Add(stmt)
                }
            } else {
                statements.Add(finallyBlock)
            }
            // if (pendingException != null) { throw pendingException; }
            let rethrowEndLabel = AsyncExceptionHandlerRewriter.MakeLabel("rethrow_end")
            let pendingRef = BoundVariableExpression(nil, pendingExLocal)
            let nullLitFinal = BoundLiteralExpression(nil, nil, TypeSymbol.Null)
            let rethrowCondition = BoundBinaryExpression(
                nil,
                pendingRef,
                Invariant.Required(
                    BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, pendingExLocal.Type, TypeSymbol.Null),
                    "pending exception locals support nil equality",
                    expression: `BoundBinaryOperator.Bind(
                        CodeAnalysis.Syntax.SyntaxKind.EqualsEqualsToken,
                        pendingExLocal.Type,
                        TypeSymbol.Null)`
                ),
                nullLitFinal
            )
            statements.Add(BoundConditionalGotoStatement(nil, rethrowEndLabel, rethrowCondition, jumpIfTrue: true))
            // Rethrow via ExceptionDispatchInfo.Capture(pendingException).Throw() so the
            // original throw site (stack trace, watson bucketing) is preserved across the
            // async lift. Using a bare `throw pendingException` would reset the stack
            // trace and defeat production diagnostics (issue #418 P1-11).
            statements.Add(BuildEdiCaptureThrow(BoundVariableExpression(nil, pendingExLocal), exceptionType))
            statements.Add(BoundLabelStatement(nil, rethrowEndLabel))
            // Pattern C: dispatch the captured branch AFTER the pending-exception
            // rethrow. The exception and branch exits are mutually exclusive
            // (a funneled `goto finallyTail` is a `leave`, not a throw, so it
            // never sets pendingException), and ordering the rethrow first keeps
            // the exception semantics identical to Pattern B. A discriminator of
            // 0 means fall-through and continues normally past the dispatch.
            if funneler.HasCapturedExits {
                for arm in funneler.DispatchArms {
                    let skipLabel = AsyncExceptionHandlerRewriter.MakeLabel("branch_skip")
                    let armCondition = BoundBinaryExpression(
                        nil,
                        BoundVariableExpression(
                            nil,
                            Invariant.Required(
                                funneler.PendingBranchLocal,
                                "funneler.HasCapturedExits is true, and EnsureFinallyTail creates this alongside the first captured exit",
                                expression: "funneler.PendingBranchLocal"
                            )
                        ),
                        Invariant.Required(
                            BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                            "int32 equality operator exists for captured-exit dispatch",
                            expression: `BoundBinaryOperator.Bind(
                                CodeAnalysis.Syntax.SyntaxKind.EqualsEqualsToken,
                                TypeSymbol.Int32,
                                TypeSymbol.Int32)`
                        ),
                        BoundLiteralExpression(nil, arm.Discriminator)
                    )
                    // if (pendingBranch != value) goto skip; <exit>; skip:
                    statements.Add(BoundConditionalGotoStatement(nil, skipLabel, armCondition, jumpIfTrue: false))
                    statements.Add(arm.Exit)
                    statements.Add(BoundLabelStatement(nil, skipLabel))
                }
            }
        }

        /// ADR-0177: returns a clause guaranteed to bind a variable. An unbound
        /// `catch (Type)` or bare `catch` carries none, but the lift
        /// paths in this pass all need somewhere to read the caught exception
        /// from before copying it into a capture local. The synthesized variable
        /// is invisible to user code — the lifted body never names it.
        /// @param clause The clause about to be lifted.
        /// @returns The clause itself, or a copy with a synthesized variable.
        private func EnsureCatchVariable(clause BoundCatchClause) BoundCatchClause -> if clause.Variable != nil {
            clause
        } else {
            BoundCatchClause(
                clause.ExceptionType,
                LocalVariableSymbol("<>catch_ex_${localOrdinal++}", isReadOnly: false, clause.ExceptionType),
                clause.Filter,
                clause.Body,
                clause.ExitsThroughFinally
            )
        }

        /// One captured Pattern C exit: a discriminator value paired with the
        /// statement to re-emit (a `return` of the pending-return-value, or
        /// a `goto` to the original target) when the dispatch after the
        /// lifted finally observes that value.
        private struct DispatchArm {
            init(discriminator int32, exit BoundStatement) {
                Discriminator = discriminator
                Exit = exit
            }

            prop Discriminator int32 {
                get;
            }

            prop Exit BoundStatement {
                get;
            }
        }

        /// Replaces a lifted catch handler's own `rethrow` statements with
        /// `ExceptionDispatchInfo.Capture(e).Throw()` (ADR-0176).
        private class RethrowLifter : BoundTreeRewriter {
            private let exceptionVariable VariableSymbol
            private let exceptionType TypeSymbol

            init(exceptionVariable VariableSymbol, exceptionType TypeSymbol) {
                this.exceptionVariable = exceptionVariable
                this.exceptionType = exceptionType
            }

            func Lift(body BoundStatement) BoundStatement -> RewriteStatement(body)

            protected override func RewriteRethrowStatement(
                node BoundRethrowStatement
            ) BoundStatement -> AsyncExceptionHandlerRewriter
                .Rewriter
                .BuildEdiCaptureThrow(BoundVariableExpression(node.Syntax, this.exceptionVariable), this.exceptionType)

            protected override func RewriteTryStatement(node BoundTryStatement) BoundStatement {
                // A `rethrow` inside a nested catch belongs to that catch, which
                // stays a real CLR handler here, so leave those bodies alone.
                // The nested try *block* and its finally are still ours.
                let tryBlock = RewriteStatement(node.TryBlock)
                let finallyBlock = if node.FinallyBlock != nil {
                    RewriteStatement(node.FinallyBlock)
                } else {
                    default(BoundStatement?)
                }
                if object.ReferenceEquals(tryBlock, node.TryBlock) && object.ReferenceEquals(
                    finallyBlock,
                    node.FinallyBlock
                ) {
                    return node
                }
                return BoundTryStatement(node.Syntax, tryBlock, node.CatchClauses, finallyBlock)
            }
        }

        /// Collects every label DEFINED inside a statement subtree (the targets
        /// of (cref:BoundLabelStatement)). The Pattern C exit funneler
        /// uses this set to decide whether a `goto`/conditional-goto leaves
        /// the protected region: a branch whose target label is in this set
        /// stays inside the try and must NOT run the lifted finally, whereas a
        /// branch to any other label (or a `return`) exits the try and is
        /// funneled.
        private class LabelCollector : BoundTreeWalker {
            private let labels HashSet[BoundLabel] = HashSet[BoundLabel]()

            override func VisitStatement(node BoundStatement?) {
                if node == nil {
                    return
                }
                if node is BoundLabelStatement labelStatement {
                    labels.Add(labelStatement.Label)
                }
                base.VisitStatement(node)
            }

            shared {
                func Collect(body BoundStatement) HashSet[BoundLabel] {
                    let collector = LabelCollector()
                    collector.VisitStatement(body)
                    return collector.labels
                }
            }
        }

        /// Rewrites the try body of a finally-with-await, replacing every
        /// non-fall-through exit that leaves the try (a `return`, or a
        /// `goto`/conditional-goto whose target label is outside the try)
        /// with a pending-branch capture followed by `goto finallyTail`.
        /// The captured exits are surfaced via (cref:DispatchArms) so the
        /// caller can re-emit them after the lifted finally body. Implements
        /// Pattern C (issue #1484) symmetrically with the pending-exception
        /// machinery.
        private class ExitFunneler : BoundTreeRewriter {
            private let owner AsyncExceptionHandlerRewriter.Rewriter
            private let innerLabels HashSet[BoundLabel]
            private let gotoDiscriminators Dictionary[BoundLabel, int32] = Dictionary[BoundLabel, int32]()
            private let dispatchArms List[AsyncExceptionHandlerRewriter.Rewriter.DispatchArm] = List[
                AsyncExceptionHandlerRewriter.Rewriter.DispatchArm
            ]()
            private var finallyTailLabel BoundLabel?
            private var pendingBranchLocal LocalVariableSymbol?
            private var pendingReturnValueLocal LocalVariableSymbol?
            private var returnCaptured bool
            private var nextGotoDiscriminator int32 = ReturnDiscriminator + 1

            init(owner AsyncExceptionHandlerRewriter.Rewriter, innerLabels HashSet[BoundLabel]) {
                this.owner = owner
                this.innerLabels = innerLabels
            }

            /// Gets a value indicating whether any exit was captured.
            prop HasCapturedExits bool -> dispatchArms.Count > 0

            /// Gets the lifted-finally tail label, or `null` until an
            /// exit is captured -- see (cref:HasCapturedExits).
            prop FinallyTailLabel BoundLabel? -> finallyTailLabel

            /// Gets the pending-branch discriminator local, or `null`
            /// until an exit is captured -- see (cref:HasCapturedExits).
            prop PendingBranchLocal LocalVariableSymbol? -> pendingBranchLocal

            /// Gets the pending-return-value local, or `null` when no
            /// value-return was captured.
            prop PendingReturnValueLocal LocalVariableSymbol? -> pendingReturnValueLocal

            /// Gets the captured exits, in first-encounter order.
            prop DispatchArms IReadOnlyList[AsyncExceptionHandlerRewriter.Rewriter.DispatchArm] -> dispatchArms

            func Funnel(body BoundStatement) BoundStatement -> RewriteStatement(body)

            protected override func RewriteReturnStatement(node BoundReturnStatement) BoundStatement {
                // A `return` always leaves the try (and the method), so it is
                // always funneled. The return expression is evaluated here, in
                // the try body, and stashed into the pending-return-value local
                // BEFORE the finally runs; the actual transfer happens after.
                EnsureFinallyTail()
                let stmts = ImmutableArray.CreateBuilder[BoundStatement]()
                // Held in a local as well as the field: the dispatch arm below
                // needs it, and `returnValueLocal != null` is exactly
                // `node.Expression != null` without the analyzer having to
                // correlate two separate `if`s.
                var returnValueLocal LocalVariableSymbol? = nil
                if node.Expression != nil {
                    returnValueLocal = (
                        if pendingReturnValueLocal == nil {
                            (pendingReturnValueLocal = owner.NewLocal("pending_ret", node.Expression.Type))
                        } else {
                            pendingReturnValueLocal
                        }
                    )!!
                    stmts.Add(
                        BoundExpressionStatement(
                            nil,
                            BoundAssignmentExpression(nil, returnValueLocal, node.Expression!!)
                        )
                    )
                }
                if !returnCaptured {
                    returnCaptured = true
                    let resume = if returnValueLocal != nil {
                        BoundReturnStatement(nil, BoundVariableExpression(nil, returnValueLocal), node.IsRef)
                    } else {
                        BoundReturnStatement(nil, nil)
                    }
                    dispatchArms.Add(AsyncExceptionHandlerRewriter.Rewriter.DispatchArm(ReturnDiscriminator, resume))
                }
                stmts.Add(AssignBranch(ReturnDiscriminator))
                stmts.Add(BoundGotoStatement(nil, finallyTailLabel))
                return BoundBlockStatement(nil, stmts.ToImmutable())
            }

            protected override func RewriteGotoStatement(node BoundGotoStatement) BoundStatement {
                if innerLabels.Contains(node.Label) {
                    // Target is inside the try — stays in the protected region.
                    return node
                }
                EnsureFinallyTail()
                let discriminator = GetGotoDiscriminator(node.Label)
                return BoundBlockStatement(
                    nil,
                    ImmutableArray.Create[BoundStatement](
                        AssignBranch(discriminator),
                        BoundGotoStatement(nil, finallyTailLabel)
                    )
                )
            }

            protected override func RewriteConditionalGotoStatement(node BoundConditionalGotoStatement) BoundStatement {
                if innerLabels.Contains(node.Label) {
                    return node
                }
                EnsureFinallyTail()
                let discriminator = GetGotoDiscriminator(node.Label)
                // if (cond == JumpIfTrue) { pendingBranch = d; goto finallyTail; }
                // Re-emit the condition once, jumping past the capture when the
                // branch is NOT taken (the original JumpIfTrue is negated for the
                // skip test).
                let skipLabel = AsyncExceptionHandlerRewriter.MakeLabel("exit_skip")
                return BoundBlockStatement(
                    nil,
                    ImmutableArray.Create[BoundStatement](
                        BoundConditionalGotoStatement(nil, skipLabel, node.Condition, jumpIfTrue: !node.JumpIfTrue),
                        AssignBranch(discriminator),
                        BoundGotoStatement(nil, finallyTailLabel),
                        BoundLabelStatement(nil, skipLabel)
                    )
                )
            }

            private func GetGotoDiscriminator(target BoundLabel) int32 {
                if !gotoDiscriminators.TryGetValue(target, out var discriminator) {
                    discriminator = nextGotoDiscriminator
                    nextGotoDiscriminator++
                    gotoDiscriminators[target] = discriminator
                    dispatchArms.Add(
                        AsyncExceptionHandlerRewriter.Rewriter.DispatchArm(
                            discriminator,
                            BoundGotoStatement(nil, target)
                        )
                    )
                }
                return discriminator
            }

            private func AssignBranch(discriminator int32) BoundStatement {
                EnsureFinallyTail()
                return BoundExpressionStatement(
                    nil,
                    BoundAssignmentExpression(nil, pendingBranchLocal, BoundLiteralExpression(nil, discriminator))
                )
            }

            /// Creates the lifted-finally tail label and its branch
            /// discriminator local on first use. Every site that reads either
            /// field calls this first, which is what
            /// (cref:MemberNotNullAttribute) records here: the two are
            /// always created together and never cleared.
            @MemberNotNull("finallyTailLabel", "pendingBranchLocal")
            private func EnsureFinallyTail() {
                finallyTailLabel ??= AsyncExceptionHandlerRewriter.MakeLabel("finally_tail")
                pendingBranchLocal ??= owner.NewLocal("pending_branch", TypeSymbol.Int32)
            }

            shared {
                private const ReturnDiscriminator int32 = 1
            }
        }

        shared {
            /// Converts every `rethrow` that belongs to [`clause`](paramref)
            /// into `ExceptionDispatchInfo.Capture(e).Throw()` (ADR-0176,
            /// issue #3897).
            /// @remarks A catch handler containing an `await` is lifted out of the CLR
            /// protected region by this pass, so an `ILOpCode.Rethrow` in its
            /// body would no longer be inside a handler — unverifiable IL. The EDI
            /// capture/throw pair is the standard stand-in and preserves the
            /// original stack trace, which is the whole point of the construct.
            /// Rethrows inside a <i>nested</i> catch that stays in place keep their
            /// real `rethrow`: (cref:RethrowLifter) does not descend
            /// into nested catch bodies.
            /// @param caught The variable holding the caught exception.
            /// @param clause The catch clause whose body is being lifted.
            /// @returns The handler body with its own rethrows converted.
            private func LiftRethrows(caught VariableSymbol, clause BoundCatchClause) BoundStatement -> RethrowLifter(
                caught,
                clause.ExceptionType
            ).Lift(clause.Body)

            /// Builds the lowered statement
            /// `ExceptionDispatchInfo.Capture().Throw();`.
            /// Used by the async-rethrow path so that an exception captured into a
            /// pending-exception local is re-raised with its original stack trace,
            /// matching the semantics of an unrewritten `throw;` inside a CLR
            /// finally handler.
            /// @param exceptionExpr Expression producing the exception to rethrow.
            /// @param exceptionType The bound (cref:System.Exception) type symbol.
            /// @returns A bound expression statement invoking `Capture(...).Throw()`.
            private func BuildEdiCaptureThrow(exceptionExpr BoundExpression, exceptionType TypeSymbol) BoundStatement {
                let ediType = typeof(ExceptionDispatchInfo)
                let captureMethod = Invariant.Required(
                    ediType.GetMethod("Capture", []Type{typeof(Exception)}),
                    "ExceptionDispatchInfo.Capture(Exception) is looked up on the host runtime's own type, not on the target framework's references",
                    expression: `ediType.GetMethod(
                    nameof(System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture),
                    new[] { typeof(Exception) })`
                )
                let throwMethod = Invariant.Required(
                    ediType.GetMethod("Throw", Type.EmptyTypes),
                    "ExceptionDispatchInfo.Throw() is looked up on the host runtime's own type, not on the target framework's references",
                    expression: `ediType.GetMethod(
                    nameof(System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw),
                    Type.EmptyTypes)`
                )
                let ediClass = ImportedClassSymbol(ediType, declaration: nil)
                let captureFn = ImportedFunctionSymbol(captureMethod.Name, ediClass, captureMethod, declaration: nil)
                let captureCall = BoundImportedCallExpression(nil, captureFn, ImmutableArray.Create(exceptionExpr))
                let throwCall = BoundImportedInstanceCallExpression(
                    nil,
                    captureCall,
                    throwMethod,
                    TypeSymbol.Void,
                    ImmutableArray[BoundExpression].Empty
                )
                return BoundExpressionStatement(nil, throwCall)
            }

            private func CatchesChanged(
                original ImmutableArray[BoundCatchClause],
                rewritten ImmutableArray[BoundCatchClause].Builder
            ) bool {
                if original.Length != rewritten.Count {
                    return true
                }
                for var i = 0; i < original.Length; i++ {
                    if !object.ReferenceEquals(original[i].Body, rewritten[i].Body) {
                        return true
                    }
                }
                return false
            }
        }
    }

    private var labelOrdinal int32

    /// Rewrites [`body`](paramref) so that no `await` appears inside
    /// a catch or finally handler.
    /// @param body The async method body to rewrite.
    /// @param preserveFinallyAcrossSuspension Whether the caller guards retained finally blocks against
    /// suspension.
    /// @returns The rewritten body with handlers lifted.
    func Rewrite(body BoundBlockStatement, preserveFinallyAcrossSuspension bool = false) BoundBlockStatement {
        if !AsyncBoundTreeQueries.HasAwait(body) {
            return body
        }
        let rewriter = AsyncExceptionHandlerRewriter.Rewriter(preserveFinallyAcrossSuspension)
        let result = rewriter.RewriteStatement(body)
        return result as BoundBlockStatement ?? BoundBlockStatement(nil, ImmutableArray.Create(result))
    }

    private func MakeLabel(prefix string) BoundLabel {
        return BoundLabel("<>async_exh_${prefix}_${labelOrdinal++}")
    }
}
