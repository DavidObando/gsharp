// <copyright file="IteratorMoveNextBodyBuilder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Iterators

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// Builds the `MoveNext()` method body for an iterator state machine.
/// Transforms the original function body by replacing each `yield` with
/// a state transition + return true, and adds a state-dispatch switch at entry.
shared class IteratorMoveNextBodyBuilder {
    private class FieldAccessYieldRewriter : HoistedFieldRewriter {
        private let stateField FieldSymbol
        private let currentField FieldSymbol
        private let yieldLabels Dictionary[int32, BoundLabel]
        private let endLabel BoundLabel
        private let tryDispatch IteratorTryDispatchPlan
        private let yieldStateMap IReadOnlyDictionary[BoundYieldStatement, int32]

        init(
            smClass StructSymbol,
            thisParameter ParameterSymbol,
            stateField FieldSymbol,
            currentField FieldSymbol,
            fieldMap Dictionary[VariableSymbol, FieldSymbol],
            yieldLabels Dictionary[int32, BoundLabel],
            endLabel BoundLabel,
            tryDispatch IteratorTryDispatchPlan,
            yieldStateMap IReadOnlyDictionary[BoundYieldStatement, int32]
        ) : base(smClass, thisParameter, fieldMap) {
            this.stateField = stateField
            this.currentField = currentField
            this.yieldLabels = yieldLabels
            this.endLabel = endLabel
            this.tryDispatch = tryDispatch
            this.yieldStateMap = yieldStateMap
        }

        protected override func RewriteYieldStatement(node BoundYieldStatement) BoundStatement {
            let state = this.yieldStateMap[node]
            let label = this.yieldLabels[state]
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            statements.Add(
                BoundExpressionStatement(
                    nil,
                    this.FieldWrite(this.currentField, this.RewriteExpression(node.Expression))
                )
            )
            statements.Add(
                BoundExpressionStatement(nil, this.FieldWrite(this.stateField, BoundLiteralExpression(nil, state)))
            )
            statements.Add(BoundReturnStatement(nil, BoundLiteralExpression(nil, true)))
            statements.Add(BoundLabelStatement(nil, label))
            statements.Add(
                BoundExpressionStatement(nil, this.FieldWrite(this.stateField, BoundLiteralExpression(nil, 0)))
            )
            return BoundBlockStatement(nil, statements.ToImmutable())
        }

        protected override func RewriteTryStatement(node BoundTryStatement) BoundStatement {
            // Inspect whether this try contains any yields. If not, leave
            // it intact (a normal protected region with no resume needs).
            let statesInside = this.tryDispatch.GetYieldStatesInTry(node)
            if statesInside.IsDefaultOrEmpty {
                return base.RewriteTryStatement(node)
            }
            // Issue #1618: the user try contains yields. It is kept as a
            // REAL CLR protected region (rather than removed and inlined)
            // so the runtime itself guarantees the finally runs on every
            // exit path — normal completion, an exception thrown from the
            // body, and an early return/break — not only normal completion.
            //
            //   * Internal dispatch: a resumed call cannot jump directly to
            //     a resume label living inside this try (the CLR forbids
            //     branching into a protected region from outside it). The
            //     outer dispatch instead jumps to this try's entry label
            //     (prepended immediately before the try below), which falls
            //     through into an internal dispatch prepended to the try
            //     body that routes the rest of the way to the actual resume
            //     label (or to a nested try's own entry label).
            //   * Finally guard: `leave`-ing the try on a `yield` suspend
            //     must NOT run the finally — the iterator merely paused, it
            //     isn't done. The finally body is guarded so it only runs
            //     when the current suspension `state` is NOT one of this
            //     try's own yield states; that's true for a genuine exit
            //     (normal completion / exception / return) but false right
            //     after suspending (state was just set to the yield's own
            //     number).
            //
            // Catch clauses are not supported when the try contains yields
            // (the language disallows this). If present we drop them; this
            // is conservative and matches the C# iterator restriction.
            let rewrittenTryBody = this.RewriteStatement(node.TryBlock)
            let tryBodyStatements = ImmutableArray.CreateBuilder[BoundStatement]()
            let internalDispatch = this.tryDispatch.GetInternalDispatchEntries(node)
            if !internalDispatch.IsDefaultOrEmpty {
                for entry in internalDispatch {
                    tryBodyStatements.Add(
                        BoundConditionalGotoStatement(
                            nil,
                            entry.Target,
                            BoundBinaryExpression(
                                nil,
                                this.FieldRead(this.stateField),
                                Invariant.Required(
                                    BoundBinaryOperator.Bind(
                                        SyntaxKind.EqualsEqualsToken,
                                        TypeSymbol.Int32,
                                        TypeSymbol.Int32
                                    ),
                                    "int32 equality operator exists for iterator finally dispatch",
                                    expression: "BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32)"
                                ),
                                BoundLiteralExpression(nil, entry.State)
                            ),
                            jumpIfTrue: true
                        )
                    )
                }
            }
            if rewrittenTryBody is BoundBlockStatement rewrittenBlock {
                tryBodyStatements.AddRange(rewrittenBlock.Statements)
            } else {
                tryBodyStatements.Add(rewrittenTryBody)
            }
            var result BoundStatement
            if node.FinallyBlock == nil {
                result = BoundBlockStatement(nil, tryBodyStatements.ToImmutable())
            } else {
                // Finally body is rewritten with the same field-access /
                // local-hoisting transforms (but the finally itself does
                // not contain yields by language rule, so the yield
                // rewriter is a safe pass-through here).
                let rewrittenFinally = this.RewriteStatement(node.FinallyBlock)
                // Seeded from the first state, as above: statesInside is known
                // non-empty from the guard at the top of this method.
                let StateIs = func (state int32) BoundExpression {
                    return BoundBinaryExpression(
                        nil,
                        this.FieldRead(this.stateField),
                        Invariant.Required(
                            BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                            "int32 equality operator exists for iterator state dispatch",
                            expression: "BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32)"
                        ),
                        BoundLiteralExpression(nil, state)
                    )
                }
                var suspendedAtOwnYield = StateIs(statesInside[0])
                for var i = 1; i < statesInside.Length; i++ {
                    suspendedAtOwnYield = BoundBinaryExpression(
                        nil,
                        suspendedAtOwnYield,
                        Invariant.Required(
                            BoundBinaryOperator.Bind(SyntaxKind.PipePipeToken, TypeSymbol.Bool, TypeSymbol.Bool),
                            "boolean disjunction operator exists for iterator state dispatch",
                            expression: "BoundBinaryOperator.Bind(SyntaxKind.PipePipeToken, TypeSymbol.Bool, TypeSymbol.Bool)"
                        ),
                        StateIs(statesInside[i])
                    )
                }
                let notSuspended = BoundUnaryExpression(
                    nil,
                    Invariant.Required(
                        BoundUnaryOperator.Bind(SyntaxKind.BangToken, TypeSymbol.Bool),
                        "the built-in operator table always binds `!` on bool",
                        expression: "BoundUnaryOperator.Bind(SyntaxKind.BangToken, TypeSymbol.Bool)"
                    ),
                    suspendedAtOwnYield
                )
                let guardedFinally = BoundIfStatement(nil, notSuspended, AsBlock(rewrittenFinally), elseStatement: nil)
                result = BoundTryStatement(
                    node.Syntax,
                    BoundBlockStatement(nil, tryBodyStatements.ToImmutable()),
                    ImmutableArray[BoundCatchClause].Empty,
                    AsBlock(guardedFinally)
                )
            }
            let entryLabel BoundLabel? = this.tryDispatch.GetEntryLabel(node)
            if entryLabel == nil {
                return result
            }
            return BoundBlockStatement(
                nil,
                ImmutableArray.Create[BoundStatement](BoundLabelStatement(nil, entryLabel), result)
            )
        }

        protected override func RewriteReturnStatement(node BoundReturnStatement) BoundStatement {
            // A bare `return` inside an iterator body means "stop
            // enumerating" (like `yield break`). Goto the shared end label,
            // which sets state = -1 and returns false. If this goto leaves
            // an enclosing user try (now a real CLR protected region — see
            // RewriteTryStatement above), the runtime automatically runs
            // that try's finally as part of the `leave`.
            return BoundGotoStatement(nil, this.endLabel)
        }

        shared {
            private func AsBlock(statement BoundStatement) BoundBlockStatement -> statement as BoundBlockStatement ??
                BoundBlockStatement(nil, ImmutableArray.Create(statement))
        }
    }

    /// Builds the MoveNext body and returns the lowered block statement.
    /// @param plan The iterator state machine plan.
    /// @param stateField The state field symbol (parameter slot for state local).
    /// @param currentField The current field symbol (parameter slot for current local).
    /// @param thisParameter The this parameter for the instance method.
    /// @returns The lowered MoveNext body and the this parameter.
    func BuildWithFieldAccess(
        plan IteratorStateMachinePlan,
        stateField FieldSymbol,
        currentField FieldSymbol,
        thisParameter ParameterSymbol,
        smClass StructSymbol,
        hoistedFieldMap Dictionary[VariableSymbol, FieldSymbol]
    ) IteratorMoveNextBody {
        let FieldRead = func (field FieldSymbol) BoundExpression {
            return BoundFieldAccessExpression(nil, BoundVariableExpression(nil, thisParameter), smClass, field)
        }
        let FieldWrite = func (field FieldSymbol, value BoundExpression) BoundExpression {
            return BoundFieldAssignmentExpression(nil, thisParameter, smClass, field, value)
        }
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        // Pre-pass: locate each yield within the user's try-statement nesting.
        //
        // Issue #1618: user try-finally regions with yields ARE kept as real
        // CLR protected regions in MoveNext (see
        // FieldAccessYieldRewriter.RewriteTryStatement below), so the runtime
        // itself guarantees the finally runs on every exit path — normal
        // completion, an uncaught exception from the body, and an early
        // return/break — not just the happy path. Two problems that come
        // with keeping a real region are solved as follows:
        //   * `ret` is illegal inside a CLR protected region: the yield's
        //     `return true` is rewritten by the later Lowerer.Lower() pass
        //     (which already rewrites any return inside a protected region
        //     into a store-to-temp + goto a shared method-exit label,
        //     see Lowerer.RewriteReturnStatement) into a `goto` that the
        //     emitter turns into `leave`.
        //   * A `leave` from a yield must NOT run the finally (the iterator
        //     merely suspended, it isn't done): the finally is guarded by a
        //     check of the current suspension `state` — while suspended at
        //     one of this try's own yields, `state` equals that yield's
        //     number, which the guard excludes.
        //   * The CLR forbids branching into a protected region from
        //     outside it, so the outer state dispatch cannot jump directly
        //     to a resume label that lives inside a user try. Instead it
        //     routes to a synthesized entry label placed immediately before
        //     the (outermost) try, and an internal dispatch placed at the
        //     top of each try's body routes the rest of the way in.
        // Dispose still handles premature termination (disposal while
        // suspended) separately, by running the pending finallies based on
        // the saved suspension state.
        let tryDispatch = IteratorTryDispatchPlanner.Plan(plan.Body, plan.YieldStates)
        let yieldLabels = Dictionary[int32, BoundLabel]()
        for kvp in plan.YieldStates.OrderBy((p KeyValuePair[BoundYieldStatement, int32]) -> p.Value) {
            let label = tryDispatch.GetResumeLabel(kvp.Value) ?? BoundLabel("$$iterResume_${kvp.Value}")
            yieldLabels[kvp.Value] = label
        }
        let startLabel = BoundLabel("$$iterStart")
        let endLabel = BoundLabel("$$iterEnd")
        statements.Add(
            BoundConditionalGotoStatement(
                nil,
                startLabel,
                BoundBinaryExpression(
                    nil,
                    FieldRead(stateField),
                    Invariant.Required(
                        BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                        "int32 equality operator exists for iterator state dispatch",
                        expression: "BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32)"
                    ),
                    BoundLiteralExpression(nil, 0)
                ),
                jumpIfTrue: true
            )
        )
        for kvp in plan.YieldStates.OrderBy((p KeyValuePair[BoundYieldStatement, int32]) -> p.Value) {
            // Issue #1618: user try-finally regions with yields are now kept
            // as real CLR protected regions (see RewriteTryStatement below)
            // so an exception thrown from the body reliably runs the
            // finally. The CLR forbids branching into a protected region
            // from outside it, so a resume state that lives inside a user
            // try cannot be jumped to directly — the outer dispatch instead
            // routes to that try's synthesized entry label (placed just
            // before the try), which falls through into the region, then an
            // internal dispatch placed at the top of the try routes the
            // rest of the way to the actual resume label.
            let target = tryDispatch.GetOuterDispatchTarget(kvp.Value) ?? yieldLabels[kvp.Value]
            statements.Add(
                BoundConditionalGotoStatement(
                    nil,
                    target,
                    BoundBinaryExpression(
                        nil,
                        FieldRead(stateField),
                        Invariant.Required(
                            BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                            "int32 equality operator exists for iterator state dispatch",
                            expression: "BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32)"
                        ),
                        BoundLiteralExpression(nil, kvp.Value)
                    ),
                    jumpIfTrue: true
                )
            )
        }
        statements.Add(BoundGotoStatement(nil, endLabel))
        statements.Add(BoundLabelStatement(nil, startLabel))
        let rewriter = FieldAccessYieldRewriter(
            smClass,
            thisParameter,
            stateField,
            currentField,
            hoistedFieldMap,
            yieldLabels,
            endLabel,
            tryDispatch,
            plan.YieldStates
        )
        let rewrittenBody = rewriter.RewriteStatement(plan.Body)
        if rewrittenBody is BoundBlockStatement block {
            statements.AddRange(block.Statements)
        } else {
            statements.Add(rewrittenBody)
        }
        statements.Add(BoundLabelStatement(nil, endLabel))
        statements.Add(BoundExpressionStatement(nil, FieldWrite(stateField, BoundLiteralExpression(nil, -1))))
        statements.Add(BoundReturnStatement(nil, BoundLiteralExpression(nil, false)))
        return IteratorMoveNextBody(Lowerer.Lower(BoundBlockStatement(nil, statements.ToImmutable())), thisParameter)
    }

    /// Builds the `Dispose()` body for an iterator state machine.
    /// @remarks For each user `try { … } finally { … }` that contains
    /// `yield` statements, Dispose must run the `finally` block
    /// when invoked while the enumerator is suspended inside that try. The
    /// suspension is identified by the current state field value, which
    /// equals one of the yield states inside the try.
    ///
    /// Nested try-finally with yields produces innermost-first walking
    /// so that inner finallies run before their enclosers, matching the
    /// normal stack-unwinding semantics on `foreach` early break.
    ///
    /// If the iterator body contains no yields inside any try-finally
    /// the body is the trivial `state = -1; return;` as before.
    func BuildDisposeBody(
        plan IteratorStateMachinePlan,
        stateField FieldSymbol,
        thisParameter ParameterSymbol,
        smClass StructSymbol,
        hoistedFieldMap Dictionary[VariableSymbol, FieldSymbol]
    ) BoundBlockStatement {
        let FieldRead = func (field FieldSymbol) BoundExpression {
            return BoundFieldAccessExpression(nil, BoundVariableExpression(nil, thisParameter), smClass, field)
        }
        let FieldWrite = func (field FieldSymbol, value BoundExpression) BoundExpression {
            return BoundFieldAssignmentExpression(nil, thisParameter, smClass, field, value)
        }
        let tryDispatch = IteratorTryDispatchPlanner.Plan(plan.Body, plan.YieldStates)
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        // Walk pending try-finallies in innermost-first order. For each:
        //   if (<state matches a yield state inside this try>) {
        //     try { /* empty: leave triggers finally */ } finally { <user finally> }
        //   }
        // We always set state = -1 BEFORE the chain so the iterator is left
        // in the finished state even if a finally throws.
        statements.Add(BoundExpressionStatement(nil, FieldWrite(stateField, BoundLiteralExpression(nil, -1))))
        if !tryDispatch.FinallyTrysInnermostFirst.IsDefaultOrEmpty {
            // We need to compute the per-try yield-state membership using
            // the ORIGINAL (pre-Dispose-rewrite) state field. Capture it
            // into a local once so the chain of if/try-finally blocks all
            // observe the suspension state.
            let savedStateLocal = LocalVariableSymbol("<>savedState", isReadOnly: true, TypeSymbol.Int32)
            // Restore: state = -1 was already written above; we keep it.
            // Replace the unconditional `state = -1` write with a local-init
            // that snapshots the current state, then writes -1.
            statements.Clear()
            statements.Add(BoundVariableDeclaration(nil, savedStateLocal, FieldRead(stateField)))
            statements.Add(BoundExpressionStatement(nil, FieldWrite(stateField, BoundLiteralExpression(nil, -1))))
            // For each try-finally that contains yields (innermost first):
            //   if (savedState == s1 || savedState == s2 || ...) {
            //     try {} finally { <rewritten user finally> }
            //   }
            for tryStmt in tryDispatch.FinallyTrysInnermostFirst {
                let insideStates = tryDispatch.GetYieldStatesInTry(tryStmt)
                if insideStates.IsDefaultOrEmpty {
                    continue
                }
                // Build OR-chain: savedState == s1 || savedState == s2 || ...
                // Seeded from the first state rather than from null, so the
                // chain is non-null by construction -- insideStates is known
                // non-empty from the guard above.
                let SavedStateIs = func (state int32) BoundExpression {
                    return BoundBinaryExpression(
                        nil,
                        BoundVariableExpression(nil, savedStateLocal),
                        Invariant.Required(
                            BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                            "int32 equality operator exists for iterator finally dispatch",
                            expression: "BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32)"
                        ),
                        BoundLiteralExpression(nil, state)
                    )
                }
                var condition = SavedStateIs(insideStates[0])
                for var i = 1; i < insideStates.Length; i++ {
                    condition = BoundBinaryExpression(
                        nil,
                        condition,
                        Invariant.Required(
                            BoundBinaryOperator.Bind(SyntaxKind.PipePipeToken, TypeSymbol.Bool, TypeSymbol.Bool),
                            "boolean disjunction operator exists for iterator state dispatch",
                            expression: "BoundBinaryOperator.Bind(SyntaxKind.PipePipeToken, TypeSymbol.Bool, TypeSymbol.Bool)"
                        ),
                        SavedStateIs(insideStates[i])
                    )
                }
                // Rewrite the user's finally body so any references to
                // hoisted locals resolve to fields on the state machine
                // (Dispose has its own `this`, distinct from MoveNext's).
                let disposeRewriter = HoistedFieldRewriter(smClass, thisParameter, hoistedFieldMap)
                let rewrittenFinally = disposeRewriter.RewriteStatement(
                    Invariant.Required(
                        tryStmt.FinallyBlock,
                        "a try statement with a lowered finally has a finally block",
                        expression: "tryStmt.FinallyBlock"
                    )
                )
                // try {} finally { … }
                let emptyTryBody = BoundBlockStatement(nil, ImmutableArray[BoundStatement].Empty)
                let tryFinally = BoundTryStatement(
                    nil,
                    emptyTryBody,
                    ImmutableArray[BoundCatchClause].Empty,
                    rewrittenFinally
                )
                statements.Add(BoundIfStatement(nil, condition, tryFinally, elseStatement: nil))
            }
        }
        statements.Add(BoundReturnStatement(nil, nil))
        return Lowerer.Lower(BoundBlockStatement(nil, statements.ToImmutable()))
    }
}

/// The result of building a MoveNext body.
class IteratorMoveNextBody {
    /// Initializes a new instance of the (cref:IteratorMoveNextBody) class.
    init(body BoundBlockStatement, thisParameter ParameterSymbol) {
        Body = body
        ThisParameter = thisParameter
    }

    /// Gets the lowered MoveNext body.
    prop Body BoundBlockStatement {
        get;
    }

    /// Gets the this parameter.
    prop ThisParameter ParameterSymbol {
        get;
    }
}
