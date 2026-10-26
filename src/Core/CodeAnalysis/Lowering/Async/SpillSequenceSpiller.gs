// <copyright file="SpillSequenceSpiller.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering.Async

import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Lowering
import System.Linq

/// Rewrites an async method body so that every (cref:BoundAwaitExpression)
/// appears only at statement top-level — either as a (cref:BoundExpressionStatement)
/// or as the RHS of a (cref:BoundVariableDeclaration) (or assignment to a spill temp).
/// Sub-expressions whose values must survive an await are lifted into spill locals.
/// After this pass, (cref:MoveNextBodyRewriter) can process every await as
/// a simple top-level statement without concern for evaluation order of siblings.
/// @remarks This implementation handles:
/// - Binary expressions (arithmetic/comparison) with await in either operand.
/// - Short-circuit operators (`&&`, `||`) with await on the right.
/// - Method calls (user, imported, imported-instance, CLR static/instance/ctor, indirect,
/// function-pointer) with await in the receiver/target and/or arguments.
/// - Variable declarations and return statements with nested await.
/// - Conversion expressions wrapping an await.
/// - Ternary/conditional expressions with await in the condition and/or an arm (issue #1619) — only the
/// taken arm's await actually runs, via an if/else expansion mirroring the short-circuit
/// logical-operator spill.
/// - Index expressions, array/tuple/struct/map literals, stack-alloc, append, len/cap, is/as,
/// field/property access and assignment, and CLR interop operators/indexers with await in any operand
/// (issue #1619) — each spilled left-to-right like a call's argument list.
/// - Switch expressions with await in the governing expression and/or an arm value (issue #1619
/// completion) — spilled via an index-selecting rebuild of the switch (so pattern-matching/guard
/// semantics run unmodified against a spilled discriminant) followed by an if/else-chain expansion
/// keyed off the selected arm index, so only the taken arm's await runs, mirroring the ternary spill.
/// - Null-conditional access (`?.`) expressions with await in the receiver and/or the when-not-null
/// continuation (issue #1619 completion) — the receiver is spilled once into the capture local/field
/// and the continuation runs only on the non-nil path, via an if/else expansion when the continuation
/// itself contains await.
/// - Conditional address-of expressions with await in a conditionally-selected operand (ADR-0061; issue
/// #1619 completion) — each operand's nested await is spilled behind a conditional-goto guard so only
/// the selected branch's side effects run, then the original
/// (cref:Binding.BoundConditionalAddressExpression) node is rebuilt from the (now await-free) operands
/// so the existing branch-and-take-address emitter performs the final, correct addressing — no
/// byref-typed value is ever carried across the branch join.
///
/// Deferred cases (emit a diagnostic if encountered):
/// - Ref/out arguments containing await.
/// - Value-type receivers of instance methods containing await in arguments.
/// - A switch-expression arm `when` guard containing await (issue #1619) — guards must be re-evaluated
/// for every candidate arm during dispatch, so an await inside a guard would need to re-run (and
/// re-suspend) for each pattern tried; this requires a fuller per-guard suspension protocol that is out
/// of scope here, so it remains diagnostic-gated.
shared class SpillSequenceSpiller {
    private class YieldInBlockExpressionWalker : BoundTreeWalker {
        private var blockExpressionDepth int32

        prop Found bool {
            get;
            private set;
        }

        protected override func VisitBlockExpression(node BoundBlockExpression) {
            blockExpressionDepth++
            base.VisitBlockExpression(node)
            blockExpressionDepth--
        }

        protected override func VisitYieldStatement(node BoundYieldStatement) {
            if blockExpressionDepth > 0 {
                Found = true
            }
        }
    }

    private class ControlFlowInBlockExpressionWalker : BoundTreeWalker {
        private var blockExpressionDepth int32

        prop Found bool {
            get;
            private set;
        }

        override func VisitStatement(node BoundStatement?) {
            if node == nil {
                return
            }
            if blockExpressionDepth > 0 &&
                (
                node.Kind is BoundNodeKind.GotoStatement or
                    BoundNodeKind.ConditionalGotoStatement or
                    BoundNodeKind.ReturnStatement or
                    BoundNodeKind.ThrowStatement or
                    BoundNodeKind.YieldStatement
            ) {
                Found = true
            }
            base.VisitStatement(node)
        }

        protected override func VisitBlockExpression(node BoundBlockExpression) {
            blockExpressionDepth++
            base.VisitBlockExpression(node)
            blockExpressionDepth--
        }
    }

    private class Spiller {
        // Reference-keyed "does this subtree contain an await" cache shared by every
        // HasAwait probe this Spiller instance makes. RewriteStatementToList/SpillExpression
        // re-query the same child nodes at every recursion level; without this memo that
        // was an O(n^2) re-walk of the tree for an async body with n nodes (issue #1625).
        // Safe across the whole pass because rewriting always produces new node instances
        // (see BoundTreeRewriter) — a memoized entry is never observed for a mutated node.
        private let awaitMemo Dictionary[BoundNode, bool] = AsyncBoundTreeQueries.CreateHasAwaitMemo()

        private let yieldInBlockMemo Dictionary[BoundNode, bool] = Dictionary[BoundNode, bool]()
        private let controlFlowInBlockMemo Dictionary[BoundNode, bool] = Dictionary[BoundNode, bool]()
        private let includeYieldInBlockExpressions bool
        private let includeControlFlowInBlockExpressions bool

        // Issue #3592: each spiller pass names its temps in its own domain
        // ("c" = control-flow block lifting, "y" = iterator block lifting,
        // "" = the async await spiller) so passes running over the SAME method
        // body never mint two same-named locals with different types — the
        // async state machine maps hoisted locals to fields by name.
        private let spillTempDomain string
        private let propertyReceiverSpiller SideEffectSpiller

        private var spillOrdinal int32

        init(includeYieldInBlockExpressions bool = false, includeControlFlowInBlockExpressions bool = false) {
            this.includeYieldInBlockExpressions = includeYieldInBlockExpressions
            this.includeControlFlowInBlockExpressions = includeControlFlowInBlockExpressions
            this.spillTempDomain = if includeControlFlowInBlockExpressions {
                "c"
            } else {
                (
                    if includeYieldInBlockExpressions {
                        "y"
                    } else {
                        string.Empty
                    }
                )
            }
            this.propertyReceiverSpiller = SideEffectSpiller("<>storage" + this.spillTempDomain)
        }

        func RewriteBlock(block BoundBlockStatement) BoundBlockStatement {
            let builder = ImmutableArray.CreateBuilder[BoundStatement]()
            var changed = false
            for statement in block.Statements {
                let rewritten = RewriteStatementToList(statement, builder)
                if rewritten {
                    changed = true
                }
            }
            if !changed {
                return block
            }
            return BoundBlockStatement(nil, builder.ToImmutable())
        }

        /// Rewrites a statement, flattening any spill sequences into the builder.
        /// Returns true if anything changed.
        private func RewriteStatementToList(
            statement BoundStatement,
            builder ImmutableArray[BoundStatement].Builder
        ) bool {
            switch statement {
                case decl is BoundVariableDeclaration {
                    return RewriteVariableDeclaration(decl, builder)
                }
                case exprStmt is BoundExpressionStatement {
                    return RewriteExpressionStatement(exprStmt, builder)
                }
                case ret is BoundReturnStatement {
                    return RewriteReturnStatement(ret, builder)
                }
                case throwStatement is BoundThrowStatement {
                    return RewriteThrowStatement(throwStatement, builder)
                }
                case yieldStatement is BoundYieldStatement {
                    return RewriteYieldStatement(yieldStatement, builder)
                }
                case goStatement is BoundGoStatement {
                    return RewriteGoStatement(goStatement, builder)
                }
                case patternSwitchStatement is BoundPatternSwitchStatement {
                    return RewritePatternSwitchStatement(patternSwitchStatement, builder)
                }
                case ifStmt is BoundIfStatement {
                    return RewriteIfStatement(ifStmt, builder)
                }
                case condGoto is BoundConditionalGotoStatement {
                    return RewriteConditionalGotoStatement(condGoto, builder)
                }
                case tryStmt is BoundTryStatement {
                    return RewriteTryStatement(tryStmt, builder)
                }
                case nested is BoundBlockStatement {
                    let rewritten = RewriteBlock(nested)
                    builder.Add(rewritten)
                    return rewritten != nested
                }
                case fixedStmt is BoundFixedStatement {
                    return RewriteFixedStatement(fixedStmt, builder)
                }
                case BoundLabelStatement,
                BoundGotoStatement,
                BoundRethrowStatement,
                BoundAwaitSequencePoint,
                BoundLocalFunctionDeclaration {
                    // Issue #1886: a generic local function's literal body is a
                    // separate lexical scope (mirrors BoundTreeRewriter's
                    // RewriteFunctionLiteralExpression) lowered independently
                    // when hosted for emission — nothing here to spill.
                    builder.Add(statement)
                    return false
                }
                default {
                    EmitDiagnosticException.Throw(
                        statement.Syntax,
                        "SpillSequenceSpiller: unhandled BoundStatement kind '${statement.Kind}'."
                    )
                    return false // unreachable

                }
            }
        }

        private func RewriteVariableDeclaration(
            decl BoundVariableDeclaration,
            builder ImmutableArray[BoundStatement].Builder
        ) bool {
            if decl.Initializer == nil || !HasAwait(decl.Initializer) {
                builder.Add(decl)
                return false
            }
            let spilled = SpillExpression(decl.Initializer!!)
            FlushSideEffects(spilled, builder)
            builder.Add(BoundVariableDeclaration(decl.Syntax, decl.Variable, spilled.Value))
            return true
        }

        private func RewriteExpressionStatement(
            exprStmt BoundExpressionStatement,
            builder ImmutableArray[BoundStatement].Builder
        ) bool {
            if !HasAwait(exprStmt.Expression) {
                builder.Add(exprStmt)
                return false
            }
            // A direct await is already in the shape MoveNext consumes only when
            // its operand contains no nested await. `await F(await G())` still
            // needs its inner call argument spilled before the outer await.
            let topLevelAwait BoundAwaitExpression? = exprStmt.Expression as BoundAwaitExpression
            if topLevelAwait != nil && !HasAwait(topLevelAwait.Expression) {
                builder.Add(exprStmt)
                return false
            }
            // Same rule for `x = await ...`: a nested await in the awaited
            // operand still requires recursive spilling.
            let assignment = exprStmt.Expression as BoundAssignmentExpression
            let assignedAwait BoundAwaitExpression? = assignment?.Expression as BoundAwaitExpression
            if assignedAwait != nil && !HasAwait(assignedAwait.Expression) {
                builder.Add(exprStmt)
                return false
            }
            let spilled = SpillExpression(exprStmt.Expression)
            FlushSideEffects(spilled, builder)
            if !(spilled.Value is BoundLiteralExpression) {
                builder.Add(BoundExpressionStatement(exprStmt.Syntax, spilled.Value))
            }
            return true
        }

        private func RewriteReturnStatement(
            ret BoundReturnStatement,
            builder ImmutableArray[BoundStatement].Builder
        ) bool {
            if ret.Expression == nil || !HasAwait(ret.Expression) {
                builder.Add(ret)
                return false
            }
            // Always spill: even a direct `return await X` must be lifted into
            // `var __tmp = await X; return __tmp` so MoveNextBodyRewriter can
            // recognize the await as a top-level variable-declaration shape.
            // Leaving a BoundAwaitExpression as the direct return expression
            // would leak an un-rewritten await to the emitter (issue #132).
            let spilled = SpillExpression(ret.Expression!!)
            FlushSideEffects(spilled, builder)
            builder.Add(BoundReturnStatement(ret.Syntax, spilled.Value))
            return true
        }

        private func RewriteThrowStatement(
            throwStatement BoundThrowStatement,
            builder ImmutableArray[BoundStatement].Builder
        ) bool {
            if !HasAwait(throwStatement.Expression) {
                builder.Add(throwStatement)
                return false
            }
            let spilled = SpillExpression(throwStatement.Expression)
            FlushSideEffects(spilled, builder)
            builder.Add(BoundThrowStatement(nil, spilled.Value, throwStatement.DiagnosticDescriptor))
            return true
        }

        private func RewriteYieldStatement(
            yieldStatement BoundYieldStatement,
            builder ImmutableArray[BoundStatement].Builder
        ) bool {
            if !HasAwait(yieldStatement.Expression) {
                builder.Add(yieldStatement)
                return false
            }
            let spilled = SpillExpression(yieldStatement.Expression)
            FlushSideEffects(spilled, builder)
            builder.Add(BoundYieldStatement(nil, spilled.Value))
            return true
        }

        private func RewritePatternSwitchStatement(
            switchStatement BoundPatternSwitchStatement,
            builder ImmutableArray[BoundStatement].Builder
        ) bool {
            var changed = false
            var discriminant = switchStatement.Discriminant
            if HasAwait(discriminant) {
                let spilled = SpillExpression(discriminant)
                FlushSideEffects(spilled, builder)
                discriminant = spilled.Value
                changed = true
            }
            let arms = ImmutableArray.CreateBuilder[BoundPatternSwitchArm](switchStatement.Arms.Length)
            for arm in switchStatement.Arms {
                var guard_ BoundExpression? = arm.Guard
                if guard_ != nil && HasAwait(guard_) {
                    guard_ = SpillSwitchGuard(guard_, "switch-statement")
                    changed = true
                }
                let bodyBuilder = ImmutableArray.CreateBuilder[BoundStatement]()
                let bodyChanged = RewriteStatementToList(arm.Body, bodyBuilder)
                let body = if bodyChanged {
                    (
                        if bodyBuilder.Count == 1 {
                            bodyBuilder[0]
                        } else {
                            cast[BoundStatement](BoundBlockStatement(nil, bodyBuilder.ToImmutable()))
                        }
                    )
                } else {
                    arm.Body
                }
                changed |= bodyChanged
                arms.Add(BoundPatternSwitchArm(arm.Syntax, arm.Pattern, guard_, body))
            }
            if !changed {
                builder.Add(switchStatement)
                return false
            }
            builder.Add(
                BoundPatternSwitchStatement(
                    switchStatement.Syntax,
                    discriminant,
                    arms.MoveToImmutable(),
                    switchStatement.IsExhaustive
                )
            )
            return true
        }

        private func SpillSwitchGuard($guard BoundExpression, switchKind string) BoundExpression {
            if AsyncBoundTreeQueries.HasAwait($guard, awaitMemo) {
                let anchor = $guard.Syntax ?? AsyncBoundTreeQueries.FindFirstAwaitSyntax($guard)
                EmitDiagnosticException.Throw(
                    anchor,
                    "'await' inside a $switchKind 'when' guard is not yet supported across a suspension point."
                )
            }
            let spilled = SpillExpression($guard)
            return BoundBlockExpression(nil, spilled.SideEffects, spilled.Value)
        }

        private func SpillAndCaptureSelectOperand(
            expression BoundExpression,
            builder ImmutableArray[BoundStatement].Builder
        ) BoundExpression {
            var expression = expression
            if HasAwait(expression) {
                let spilled = SpillExpression(expression)
                FlushSideEffects(spilled, builder)
                expression = spilled.Value
            }
            if expression.Type == TypeSymbol.Never {
                // Issue #4965 (ADR-0202): see StoreOperand.
                builder.Add(BoundExpressionStatement(nil, expression))
                return BoundThrowExpression(nil, BoundLiteralExpression(nil, value: nil))
            }
            let temp = MakeSpillTemp(expression.Type)
            builder.Add(BoundVariableDeclaration(nil, temp, expression))
            return BoundVariableExpression(nil, temp)
        }

        private func RewriteGoStatement(
            goStatement BoundGoStatement,
            builder ImmutableArray[BoundStatement].Builder
        ) bool {
            if !HasAwait(goStatement.Expression) {
                builder.Add(goStatement)
                return false
            }
            let spilled = SpillExpression(goStatement.Expression)
            FlushSideEffects(spilled, builder)
            builder.Add(
                BoundGoStatement(
                    goStatement.Syntax,
                    spilled.Value,
                    goStatement.Sink,
                    goStatement.ResultCell,
                    goStatement.ResultType,
                    goStatement.LexicalEnclosingType
                )
            )
            return true
        }

        private func RewriteFixedStatement(
            fixedStatement BoundFixedStatement,
            builder ImmutableArray[BoundStatement].Builder
        ) bool {
            var pinnedSource = fixedStatement.PinnedSource
            var sourceChanged = false
            if HasAwait(pinnedSource) {
                let spilledSource = SpillExpression(pinnedSource)
                FlushSideEffects(spilledSource, builder)
                pinnedSource = spilledSource.Value
                sourceChanged = true
            }
            let fixedBody = if fixedStatement.Body is BoundBlockStatement fixedBlock {
                cast[BoundStatement](RewriteBlock(fixedBlock))
            } else {
                fixedStatement.Body
            }
            let rebuilt = if !sourceChanged && fixedBody == fixedStatement.Body {
                fixedStatement
            } else {
                BoundFixedStatement(
                    fixedStatement.Syntax,
                    fixedStatement.PinKind,
                    fixedStatement.PinnedVariable,
                    fixedStatement.PointerVariable,
                    pinnedSource,
                    fixedBody,
                    fixedStatement.SourceVariable
                )
            }
            builder.Add(rebuilt)
            return rebuilt != fixedStatement
        }

        private func RewriteIfStatement(ifStmt BoundIfStatement, builder ImmutableArray[BoundStatement].Builder) bool {
            // Spill the condition if it contains an await.
            var condition = ifStmt.Condition
            var conditionChanged = false
            if HasAwait(condition) {
                let spilledCond = SpillExpression(condition)
                FlushSideEffects(spilledCond, builder)
                condition = spilledCond.Value
                conditionChanged = true
            }
            // Recursively rewrite branches.
            let thenBuilder = ImmutableArray.CreateBuilder[BoundStatement]()
            let thenChanged = RewriteStatementToList(ifStmt.ThenStatement, thenBuilder)
            let thenStmt = if thenChanged {
                (
                    if thenBuilder.Count == 1 {
                        thenBuilder[0]
                    } else {
                        cast[BoundStatement](BoundBlockStatement(nil, thenBuilder.ToImmutable()))
                    }
                )
            } else {
                ifStmt.ThenStatement
            }
            var elseStmt BoundStatement? = ifStmt.ElseStatement
            var elseChanged = false
            if elseStmt != nil {
                let elseBuilder = ImmutableArray.CreateBuilder[BoundStatement]()
                elseChanged = RewriteStatementToList(elseStmt, elseBuilder)
                if elseChanged {
                    elseStmt = if elseBuilder.Count == 1 {
                        elseBuilder[0]
                    } else {
                        cast[BoundStatement](BoundBlockStatement(nil, elseBuilder.ToImmutable()))
                    }
                }
            }
            if !conditionChanged && !thenChanged && !elseChanged {
                builder.Add(ifStmt)
                return false
            }
            builder.Add(BoundIfStatement(ifStmt.Syntax, condition, thenStmt, elseStmt))
            return true
        }

        /// Spills awaits that appear inside a (cref:BoundConditionalGotoStatement)
        /// condition. By the time the spiller runs, the Lowerer and the statement
        /// binder have already desugared `if`/`while`/`for`/`do-while`
        /// statements into label/goto form, so an await embedded in a branch or loop
        /// condition lives here rather than in a (cref:BoundIfStatement)
        /// (issue #1266). Without this case the condition await leaked un-rewritten to
        /// the emitter, which threw `GS9998`.
        /// @remarks The spilled side-effects (including the await suspension points) are emitted
        /// immediately before the conditional goto. For loops the binder places the
        /// loop's `check:` label directly ahead of this conditional goto, so the
        /// spilled condition computation sits inside the loop and is re-evaluated on
        /// every iteration — preserving while/for/do-while re-evaluation semantics. The
        /// (cref:SpillExpression) call also handles short-circuiting
        /// `&&`/`||` conditions (see `SpillLogicalAnd`/
        /// `SpillLogicalOr`), so a right-operand await only runs when the left
        /// operand requires it.
        private func RewriteConditionalGotoStatement(
            gotoStmt BoundConditionalGotoStatement,
            builder ImmutableArray[BoundStatement].Builder
        ) bool {
            if !HasAwait(gotoStmt.Condition) {
                builder.Add(gotoStmt)
                return false
            }
            let spilled = SpillExpression(gotoStmt.Condition)
            FlushSideEffects(spilled, builder)
            builder.Add(
                BoundConditionalGotoStatement(gotoStmt.Syntax, gotoStmt.Label, spilled.Value, gotoStmt.JumpIfTrue)
            )
            return true
        }

        /// Spills sub-expression awaits nested inside a (cref:BoundTryStatement)'s
        /// protected block (and, defensively, its handler/finally blocks). Awaits in the
        /// try body are legal suspension points that (cref:MoveNextBodyRewriter)
        /// handles once they sit at statement top-level, but they only reach that form
        /// if the spiller descends into the try region. Treating the try as an opaque
        /// await-free leaf (the prior behaviour) left a sub-expression await such as
        /// `F(await G())` unspilled, leaking a (cref:BoundAwaitExpression)
        /// into the emitted MoveNext body.
        private func RewriteTryStatement(
            tryStmt BoundTryStatement,
            builder ImmutableArray[BoundStatement].Builder
        ) bool {
            let tryBlock = RewriteNestedBody(tryStmt.TryBlock, out var tryChanged)
            var catchesChanged = false
            let catchBuilder = ImmutableArray.CreateBuilder[BoundCatchClause](tryStmt.CatchClauses.Length)
            for clause in tryStmt.CatchClauses {
                let body = RewriteNestedBody(clause.Body, out var clauseChanged)
                catchesChanged |= clauseChanged
                catchBuilder.Add(
                    if clauseChanged {
                        clause.WithBody(body!!)
                    } else {
                        clause
                    }
                )
            }
            let finallyBlock = RewriteNestedBody(tryStmt.FinallyBlock, out var finallyChanged)
            if !tryChanged && !catchesChanged && !finallyChanged {
                builder.Add(tryStmt)
                return false
            }
            builder.Add(
                BoundTryStatement(
                    tryStmt.Syntax,
                    tryBlock!!,
                    if catchesChanged {
                        catchBuilder.ToImmutable()
                    } else {
                        tryStmt.CatchClauses
                    },
                    finallyBlock
                )
            )
            return true
        }

        /// Spills a try/catch/finally sub-block. Returns the rewritten body and
        /// reports whether anything changed.
        @return: NotNullIfNotNull("body")
        private func RewriteNestedBody(body BoundStatement?, out changed bool) BoundStatement? {
            if body == nil {
                changed = false
                return nil
            }
            if body is BoundBlockStatement block {
                let rewritten = RewriteBlock(block)
                changed = !object.ReferenceEquals(rewritten, block)
                return rewritten
            }
            let nestedBuilder = ImmutableArray.CreateBuilder[BoundStatement]()
            changed = RewriteStatementToList(body, nestedBuilder)
            if !changed {
                return body
            }
            return if nestedBuilder.Count == 1 {
                nestedBuilder[0]
            } else {
                cast[BoundStatement](BoundBlockStatement(body.Syntax, nestedBuilder.ToImmutable()))
            }
        }

        /// Core spilling: recursively visit an expression, returning a
        /// (cref:BoundSpillSequenceExpression) whose Value has no
        /// embedded awaits (they've all been lifted out as side-effect statements).
        /// If the expression has no awaits, returns a trivial spill sequence.
        private func SpillExpression(expression BoundExpression) BoundSpillSequenceExpression {
            switch expression {
                case awaitExpr is BoundAwaitExpression {
                    return SpillAwait(awaitExpr)
                }
                case binary is BoundBinaryExpression {
                    return SpillBinary(binary)
                }
                case call is BoundCallExpression {
                    return SpillCall(call)
                }
                case cstatic is BoundConstrainedStaticCallExpression {
                    return SpillConstrainedStaticCall(cstatic)
                }
                case importedCall is BoundImportedCallExpression {
                    return SpillImportedCall(importedCall)
                }
                case instanceCall is BoundImportedInstanceCallExpression {
                    return SpillImportedInstanceCall(instanceCall)
                }
                case conv is BoundConversionExpression {
                    return SpillConversion(conv)
                }
                case assign is BoundAssignmentExpression {
                    return SpillAssignment(assign)
                }
                case fieldAssign is BoundFieldAssignmentExpression {
                    return SpillFieldAssignment(fieldAssign)
                }
                case indexAssign is BoundIndexAssignmentExpression {
                    return SpillIndexAssignment(indexAssign)
                }
                case unary is BoundUnaryExpression {
                    return SpillUnary(unary)
                }
                case userInstance is BoundUserInstanceCallExpression {
                    return SpillUserInstanceCall(userInstance)
                }
                case baseInterface is BoundBaseInterfaceCallExpression {
                    return SpillBaseInterfaceCall(baseInterface)
                }
                case baseClass is BoundBaseClassCallExpression {
                    return SpillBaseClassCall(baseClass)
                }
                case block is BoundBlockExpression {
                    return SpillBlockExpression(block)
                }
                case conditional is BoundConditionalExpression {
                    return SpillConditional(conditional)
                }
                case index is BoundIndexExpression {
                    return SpillIndex(index)
                }
                case clrStatic is BoundClrStaticCallExpression {
                    return SpillClrStaticCall(clrStatic)
                }
                case clrCtor is BoundClrConstructorCallExpression {
                    return SpillClrConstructorCall(clrCtor)
                }
                case ctorCall is BoundConstructorCallExpression {
                    return SpillConstructorCall(ctorCall)
                }
                case ctorChain is BoundConstructorChainingExpression {
                    return SpillConstructorChaining(ctorChain)
                }
                case indirectCall is BoundIndirectCallExpression {
                    return SpillIndirectCall(indirectCall)
                }
                case fpInvoke is BoundFunctionPointerInvocationExpression {
                    return SpillFunctionPointerInvocation(fpInvoke)
                }
                case clrIndex is BoundClrIndexExpression {
                    return SpillClrIndex(clrIndex)
                }
                case clrIndexAssign is BoundClrIndexAssignmentExpression {
                    return SpillClrIndexAssignment(clrIndexAssign)
                }
                case clrPropAccess is BoundClrPropertyAccessExpression {
                    return SpillClrPropertyAccess(clrPropAccess)
                }
                case clrPropAssign is BoundClrPropertyAssignmentExpression {
                    let propertyReceiver BoundExpression? = clrPropAssign.Receiver
                    if propertyReceiver == nil {
                        return SpillOneOperand(
                            clrPropAssign,
                            clrPropAssign.Value,
                            func (value BoundExpression) BoundExpression {
                                return BoundClrPropertyAssignmentExpression(
                                    nil,
                                    nil,
                                    clrPropAssign.Member,
                                    value,
                                    clrPropAssign.Type,
                                    clrPropAssign.StaticContainerType,
                                    clrPropAssign.ConstrainedReceiverTypeParameter,
                                    clrPropAssign.ConstrainedInterfaceType
                                )
                            }
                        )
                    }
                    return SpillTwoOperand(
                        clrPropAssign,
                        propertyReceiver,
                        clrPropAssign.Value,
                        func (recv BoundExpression, val BoundExpression) BoundExpression {
                            return BoundClrPropertyAssignmentExpression(
                                nil,
                                recv,
                                clrPropAssign.Member,
                                val,
                                clrPropAssign.Type,
                                clrPropAssign.StaticContainerType,
                                clrPropAssign.ConstrainedReceiverTypeParameter,
                                clrPropAssign.ConstrainedInterfaceType
                            )
                        },
                        preserveReceiverStorage: true
                    )
                }
                case clrBinary is BoundClrBinaryOperatorExpression {
                    // Issue #2388: preserve whichever of Method (imported CLR
                    // type) / Function (nullable-lifted same-compilation
                    // struct operator) the original node carried.
                    return SpillTwoOperand(
                        clrBinary,
                        clrBinary.Left,
                        clrBinary.Right,
                        func (l BoundExpression, r BoundExpression) BoundExpression {
                            return if clrBinary.Function != nil {
                                BoundClrBinaryOperatorExpression(
                                    nil,
                                    clrBinary.OperatorKind,
                                    l,
                                    r,
                                    clrBinary.Function,
                                    clrBinary.FunctionOwnerType,
                                    clrBinary.Type
                                )
                            } else {
                                BoundClrBinaryOperatorExpression(
                                    nil,
                                    clrBinary.OperatorKind,
                                    l,
                                    r,
                                    clrBinary.Method,
                                    clrBinary.Type
                                )
                            }
                        }
                    )
                }
                case clrUnary is BoundClrUnaryOperatorExpression {
                    return SpillOneOperand(
                        clrUnary,
                        clrUnary.Operand,
                        func (operand BoundExpression) BoundExpression {
                            return BoundClrUnaryOperatorExpression(
                                nil,
                                clrUnary.OperatorKind,
                                operand,
                                clrUnary.Method,
                                clrUnary.Type
                            )
                        }
                    )
                }
                case clrConv is BoundClrConversionCallExpression {
                    return SpillOneOperand(
                        clrConv,
                        clrConv.Source,
                        func (src BoundExpression) BoundExpression {
                            return if clrConv.Function != nil {
                                BoundClrConversionCallExpression(
                                    nil,
                                    src,
                                    clrConv.Function,
                                    clrConv.FunctionOwnerType,
                                    clrConv.Type
                                )
                            } else {
                                BoundClrConversionCallExpression(
                                    nil,
                                    src,
                                    Invariant.Required(
                                        clrConv.Method,
                                        "an imported conversion carries a CLR method",
                                        expression: "clrConv.Method"
                                    ),
                                    clrConv.Type
                                )
                            }
                        }
                    )
                }
                case clrEventSub is BoundClrEventSubscriptionExpression {
                    if clrEventSub.Receiver == nil {
                        return SpillOneOperand(
                            clrEventSub,
                            clrEventSub.Handler,
                            func (handler BoundExpression) BoundExpression {
                                return BoundClrEventSubscriptionExpression(
                                    nil,
                                    receiver: nil,
                                    clrEventSub.Event,
                                    handler,
                                    clrEventSub.IsAdd,
                                    clrEventSub.ConstrainedReceiverTypeParameter,
                                    clrEventSub.ConstrainedInterfaceType,
                                    clrEventSub.EventContainingType
                                ){IsNonVirtualBaseCall = clrEventSub.IsNonVirtualBaseCall}
                            }
                        )
                    }
                    return SpillTwoOperand(
                        clrEventSub,
                        clrEventSub.Receiver!!,
                        clrEventSub.Handler,
                        func (recv BoundExpression, handler BoundExpression) BoundExpression {
                            return BoundClrEventSubscriptionExpression(
                                nil,
                                recv,
                                clrEventSub.Event,
                                handler,
                                clrEventSub.IsAdd,
                                clrEventSub.ConstrainedReceiverTypeParameter,
                                clrEventSub.ConstrainedInterfaceType,
                                clrEventSub.EventContainingType
                            ){IsNonVirtualBaseCall = clrEventSub.IsNonVirtualBaseCall}
                        }
                    )
                }
                case eventSub is BoundEventSubscriptionExpression {
                    if eventSub.Receiver == nil {
                        return SpillOneOperand(
                            eventSub,
                            eventSub.Handler,
                            func (handler BoundExpression) BoundExpression {
                                return BoundEventSubscriptionExpression(
                                    nil,
                                    receiver: nil,
                                    eventSub.StructType,
                                    eventSub.Event,
                                    handler,
                                    eventSub.IsAdd,
                                    eventSub.EventType
                                ){IsNonVirtualBaseCall = eventSub.IsNonVirtualBaseCall}
                            }
                        )
                    }
                    return SpillTwoOperand(
                        eventSub,
                        eventSub.Receiver!!,
                        eventSub.Handler,
                        func (recv BoundExpression, handler BoundExpression) BoundExpression {
                            return BoundEventSubscriptionExpression(
                                nil,
                                recv,
                                eventSub.StructType,
                                eventSub.Event,
                                handler,
                                eventSub.IsAdd,
                                eventSub.EventType
                            ){IsNonVirtualBaseCall = eventSub.IsNonVirtualBaseCall}
                        }
                    )
                }
                case fieldAccess is BoundFieldAccessExpression {
                    return SpillFieldAccess(fieldAccess)
                }
                case fieldKey is BoundManagedFieldKeyExpression {
                    // Field is a token descriptor, not an evaluated receiver.
                    return SpillOneOperand(
                        fieldKey,
                        fieldKey.Parent,
                        func (parent BoundExpression) BoundExpression {
                            return BoundManagedFieldKeyExpression(parent, fieldKey.Field)
                        }
                    )
                }
                case propAccess is BoundPropertyAccessExpression {
                    if propAccess.Receiver == nil {
                        return Trivial(propAccess)
                    }
                    return SpillOneOperand(
                        propAccess,
                        propAccess.Receiver!!,
                        func (receiver BoundExpression) BoundExpression {
                            return BoundPropertyAccessExpression(
                                nil,
                                receiver,
                                propAccess.StructType,
                                propAccess.Property,
                                propAccess.SubstitutedType,
                                propAccess.NarrowedType,
                                propAccess.InterfaceType
                            )
                        }
                    )
                }
                case propAssign is BoundPropertyAssignmentExpression {
                    if propAssign.Receiver == nil {
                        return SpillOneOperand(
                            propAssign,
                            propAssign.Value,
                            func (value BoundExpression) BoundExpression {
                                return BoundPropertyAssignmentExpression(
                                    nil,
                                    receiver: nil,
                                    propAssign.StructType,
                                    propAssign.Property,
                                    value,
                                    propAssign.SubstitutedType,
                                    propAssign.InterfaceType
                                )
                            }
                        )
                    }
                    return SpillTwoOperand(
                        propAssign,
                        propAssign.Receiver!!,
                        propAssign.Value,
                        func (recv BoundExpression, val BoundExpression) BoundExpression {
                            return BoundPropertyAssignmentExpression(
                                nil,
                                recv,
                                propAssign.StructType,
                                propAssign.Property,
                                val,
                                propAssign.SubstitutedType,
                                propAssign.InterfaceType
                            )
                        },
                        preserveReceiverStorage: true
                    )
                }
                case tupleLiteral is BoundTupleLiteralExpression {
                    return SpillTupleLiteral(tupleLiteral)
                }
                case tupleAccess is BoundTupleElementAccessExpression {
                    return SpillOneOperand(
                        tupleAccess,
                        tupleAccess.Receiver,
                        func (recv BoundExpression) BoundExpression {
                            return BoundTupleElementAccessExpression(
                                nil,
                                recv,
                                tupleAccess.TupleType,
                                tupleAccess.Index
                            )
                        }
                    )
                }
                case interpolated is BoundInterpolatedStringExpression {
                    return SpillInterpolatedString(interpolated)
                }
                case arrayCreation is BoundArrayCreationExpression {
                    return SpillArrayCreation(arrayCreation)
                }
                case stackAlloc is BoundStackAllocExpression {
                    return SpillStackAlloc(stackAlloc)
                }
                case len is BoundLenExpression {
                    return SpillOneOperand(
                        len,
                        len.Operand,
                        func (operand BoundExpression) BoundExpression {
                            return BoundLenExpression(nil, operand)
                        }
                    )
                }
                case structLiteral is BoundStructLiteralExpression {
                    return SpillStructLiteral(structLiteral)
                }
                case mapLiteral is BoundMapLiteralExpression {
                    return SpillMapLiteral(mapLiteral)
                }
                case isExpr is BoundIsExpression {
                    return SpillOneOperand(
                        isExpr,
                        isExpr.Expression,
                        func (operand BoundExpression) BoundExpression {
                            return BoundIsExpression(nil, operand, isExpr.Pattern)
                        }
                    )
                }
                case asExpr is BoundAsExpression {
                    return SpillOneOperand(
                        asExpr,
                        asExpr.Expression,
                        func (operand BoundExpression) BoundExpression {
                            return BoundAsExpression(nil, operand, asExpr.TargetType)
                        }
                    )
                }
                case throwExpr is BoundThrowExpression {
                    return SpillOneOperand(
                        throwExpr,
                        throwExpr.Expression,
                        func (operand BoundExpression) BoundExpression {
                            return BoundThrowExpression(nil, operand)
                        }
                    )
                }
                case addressOf is BoundAddressOfExpression {
                    return SpillOneOperand(
                        addressOf,
                        addressOf.Operand,
                        func (operand BoundExpression) BoundExpression {
                            return BoundAddressOfExpression(nil, operand)
                        }
                    )
                }
                case managedReference is BoundManagedReferenceExpression {
                    // Lowerer lifts control-flow blocks before root promotion.
                    // Keep the rewritten lvalue; do not spill its value into a
                    // replacement slot or acquire a borrowed address here.
                    return SpillOneOperand(
                        managedReference,
                        managedReference.Location,
                        func (location BoundExpression) BoundExpression {
                            return BoundManagedReferenceExpression(
                                managedReference.Syntax,
                                location,
                                managedReference.Type,
                                managedReference.IsReadOnly,
                                managedReference.RetainForCapture
                            )
                        }
                    )
                }
                case dereference is BoundDereferenceExpression {
                    return SpillOneOperand(
                        dereference,
                        dereference.Operand,
                        func (operand BoundExpression) BoundExpression {
                            return BoundDereferenceExpression(nil, operand)
                        }
                    )
                }
                case indirectAssign is BoundIndirectAssignmentExpression {
                    return SpillTwoOperand(
                        indirectAssign,
                        indirectAssign.Pointer,
                        indirectAssign.Value,
                        func (ptr BoundExpression, val BoundExpression) BoundExpression {
                            return BoundIndirectAssignmentExpression(nil, ptr, val)
                        }
                    )
                }
                case switchExpr is BoundSwitchExpression {
                    return SpillSwitch(switchExpr)
                }
                case nullConditional is BoundNullConditionalAccessExpression {
                    return SpillNullConditionalAccess(nullConditional)
                }
                case condAddr is BoundConditionalAddressExpression {
                    return SpillConditionalAddress(condAddr)
                }
                case BoundLiteralExpression,
                BoundVariableExpression,
                BoundDefaultExpression,
                BoundTypeParameterConstructionExpression,
                BoundTypeOfExpression,
                BoundSizeOfExpression,
                BoundFunctionPointerFromMethodExpression,
                BoundMethodGroupExpression,
                BoundClrMethodGroupExpression,
                BoundFunctionLiteralExpression,
                BoundErrorExpression,
                BoundSpillSequenceExpression,
                BoundStateMachineAwaitOnCompleted,
                BoundStateMachineBuilderMoveNext {
                    return Trivial(expression)
                }
                default {
                    EmitDiagnosticException.Throw(
                        expression.Syntax,
                        "SpillSequenceSpiller: unhandled BoundExpression kind '${expression.Kind}'."
                    )
                    return nil // unreachable

                }
            }
        }

        /// Spills a (cref:BoundBlockExpression) (e.g. an interpolated
        /// string lowered to the handler pattern, issue #368) by flattening its
        /// statements through the statement rewriter — lifting any awaits to
        /// statement level — and then spilling the trailing value expression.
        /// The hole pre-evaluation in `InterpolatedStringHandlerLowerer`
        /// guarantees awaits precede the (possibly ByRefLike) handler local, so
        /// no handler local is live across a suspension after this flattening.
        private func SpillBlockExpression(block BoundBlockExpression) BoundSpillSequenceExpression {
            let sideEffects = ImmutableArray.CreateBuilder[BoundStatement]()
            for statement in block.Statements {
                RewriteStatementToList(statement, sideEffects)
            }
            let valueSpill = SpillExpression(block.Expression)
            sideEffects.AddRange(valueSpill.SideEffects)
            return BoundSpillSequenceExpression(nil, valueSpill.Locals, sideEffects.ToImmutable(), valueSpill.Value)
        }

        private func SpillAwait(awaitExpr BoundAwaitExpression) BoundSpillSequenceExpression {
            // First, spill the inner expression of the await (e.g. the Task).
            var innerSpill BoundSpillSequenceExpression? = nil
            var innerExpr = awaitExpr.Expression
            if HasAwait(awaitExpr.Expression) {
                innerSpill = SpillExpression(awaitExpr.Expression)
                innerExpr = innerSpill.Value
            }
            let awaitNode = BoundAwaitExpression(
                awaitExpr.Syntax,
                innerExpr,
                awaitExpr.Type,
                awaitExpr.AwaiterTypeSymbol
            )
            awaitExpr.CopyImplicitCompletionTo(awaitNode)
            let locals = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
            let sideEffects = ImmutableArray.CreateBuilder[BoundStatement]()
            if innerSpill != nil {
                locals.AddRange(innerSpill.Locals)
                sideEffects.AddRange(innerSpill.SideEffects)
                // This closed spill ran on the exact recorded operand. Await its
                // exact returned value after its own locals/effects, not a value
                // discovered by scanning an arbitrary block or replacement.
                if object.ReferenceEquals(awaitExpr.LogicalCompletionOperand, awaitExpr.Expression) &&
                    object.ReferenceEquals(innerExpr, innerSpill.Value) {
                    awaitNode.RecordLogicalCompletion(innerExpr)
                }
            }
            if awaitExpr.Type == TypeSymbol.Void {
                sideEffects.Add(BoundExpressionStatement(nil, awaitNode))
                return BoundSpillSequenceExpression(
                    nil,
                    locals.ToImmutable(),
                    sideEffects.ToImmutable(),
                    BoundLiteralExpression(nil, 0, TypeSymbol.Void)
                )
            }
            // Create a spill temp for a value-producing await result.
            let spillLocal = MakeSpillTemp(awaitExpr.Type)
            locals.Add(spillLocal)
            sideEffects.Add(BoundVariableDeclaration(nil, spillLocal, awaitNode))
            return BoundSpillSequenceExpression(
                nil,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                BoundVariableExpression(nil, spillLocal)
            )
        }

        private func SpillBinary(binary BoundBinaryExpression) BoundSpillSequenceExpression {
            // Short-circuit operators: expand into if/else.
            if binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd {
                return SpillLogicalAnd(binary)
            }
            if binary.Op.Kind == BoundBinaryOperatorKind.LogicalOr {
                return SpillLogicalOr(binary)
            }
            if binary.Op.Kind == BoundBinaryOperatorKind.NullCoalesce {
                return SpillNullCoalesce(binary)
            }
            let leftHasAwait = HasAwait(binary.Left)
            let rightHasAwait = HasAwait(binary.Right)
            if !leftHasAwait && !rightHasAwait {
                return Trivial(binary)
            }
            let locals = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
            let sideEffects = ImmutableArray.CreateBuilder[BoundStatement]()
            var left BoundExpression
            if leftHasAwait {
                let spilledLeft = SpillExpression(binary.Left)
                locals.AddRange(spilledLeft.Locals)
                sideEffects.AddRange(spilledLeft.SideEffects)
                left = spilledLeft.Value
            } else {
                left = binary.Left
            }
            // If right has await, the left must be spilled to a temp
            // (unless it's a pure constant or simple variable read).
            if rightHasAwait && !CanDeferAcrossLift(left) {
                left = StoreOperand(left, locals, sideEffects)
            }
            var right BoundExpression
            if rightHasAwait {
                let spilledRight = SpillExpression(binary.Right)
                locals.AddRange(spilledRight.Locals)
                sideEffects.AddRange(spilledRight.SideEffects)
                right = spilledRight.Value
            } else {
                right = binary.Right
            }
            let value = BoundBinaryExpression(nil, left, binary.Op, right)
            if locals.Count == 0 && sideEffects.Count == 0 {
                return Trivial(value)
            }
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        private func SpillLogicalAnd(binary BoundBinaryExpression) BoundSpillSequenceExpression {
            // a && (await b) => { var tmp = false; if (a) goto evalRight; goto end; evalRight: tmp = await b; end: VALUE=tmp }
            let resultLocal = MakeSpillTemp(binary.Type)
            let locals = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
            let sideEffects = ImmutableArray.CreateBuilder[BoundStatement]()
            // Spill the left side.
            var left = binary.Left
            if HasAwait(binary.Left) {
                let spilledLeft = SpillExpression(binary.Left)
                locals.AddRange(spilledLeft.Locals)
                sideEffects.AddRange(spilledLeft.SideEffects)
                left = spilledLeft.Value
            }
            let evalRightLabel = MakeLabel()
            let endLabel = MakeLabel()
            // if (left) goto evalRight
            sideEffects.Add(BoundConditionalGotoStatement(nil, evalRightLabel, left, jumpIfTrue: true))
            // tmp = false; goto end
            sideEffects.Add(
                BoundExpressionStatement(
                    nil,
                    BoundAssignmentExpression(nil, resultLocal, BoundLiteralExpression(nil, false))
                )
            )
            sideEffects.Add(BoundGotoStatement(nil, endLabel))
            // evalRight: tmp = await b
            sideEffects.Add(BoundLabelStatement(nil, evalRightLabel))
            let spilledRight = SpillExpression(binary.Right)
            locals.AddRange(spilledRight.Locals)
            sideEffects.AddRange(spilledRight.SideEffects)
            sideEffects.Add(
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, resultLocal, spilledRight.Value))
            )
            // end:
            sideEffects.Add(BoundLabelStatement(nil, endLabel))
            locals.Add(resultLocal)
            return BoundSpillSequenceExpression(
                nil,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                BoundVariableExpression(nil, resultLocal)
            )
        }

        private func SpillNullCoalesce(binary BoundBinaryExpression) BoundSpillSequenceExpression {
            let locals = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
            let sideEffects = ImmutableArray.CreateBuilder[BoundStatement]()
            let spilledLeft = SpillExpression(binary.Left)
            locals.AddRange(spilledLeft.Locals)
            sideEffects.AddRange(spilledLeft.SideEffects)
            let leftLocal = MakeSpillTemp(binary.Left.Type)
            locals.Add(leftLocal)
            sideEffects.Add(BoundVariableDeclaration(nil, leftLocal, spilledLeft.Value))
            let resultLocal = MakeSpillTemp(binary.Type)
            locals.Add(resultLocal)
            let useLeftLabel = MakeLabel()
            let endLabel = MakeLabel()
            sideEffects.Add(
                BoundConditionalGotoStatement(
                    nil,
                    useLeftLabel,
                    BoundVariableExpression(nil, leftLocal),
                    jumpIfTrue: true
                )
            )
            let spilledRight = SpillExpression(binary.Right)
            locals.AddRange(spilledRight.Locals)
            sideEffects.AddRange(spilledRight.SideEffects)
            sideEffects.Add(
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, resultLocal, spilledRight.Value))
            )
            sideEffects.Add(BoundGotoStatement(nil, endLabel))
            sideEffects.Add(BoundLabelStatement(nil, useLeftLabel))
            var leftValue BoundExpression = BoundVariableExpression(nil, leftLocal)
            if leftLocal.Type is NullableTypeSymbol {
                let unwrapOp = Invariant.Required(
                    BoundUnaryOperator.Bind(SyntaxKind.BangBangToken, leftLocal.Type),
                    "the left operand of null coalescing is nullable and always supports `!!`",
                    expression: "BoundUnaryOperator.Bind(SyntaxKind.BangBangToken, leftLocal.Type)"
                )
                leftValue = BoundUnaryExpression(nil, unwrapOp, leftValue)
            }
            if leftValue.Type != binary.Type {
                leftValue = BoundConversionExpression(nil, binary.Type, leftValue)
            }
            sideEffects.Add(BoundExpressionStatement(nil, BoundAssignmentExpression(nil, resultLocal, leftValue)))
            sideEffects.Add(BoundLabelStatement(nil, endLabel))
            return BoundSpillSequenceExpression(
                nil,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                BoundVariableExpression(nil, resultLocal)
            )
        }

        private func SpillLogicalOr(binary BoundBinaryExpression) BoundSpillSequenceExpression {
            // a || (await b) => { var tmp = true; if (a) goto end; tmp = await b; end: VALUE=tmp }
            let resultLocal = MakeSpillTemp(binary.Type)
            let locals = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
            let sideEffects = ImmutableArray.CreateBuilder[BoundStatement]()
            var left = binary.Left
            if HasAwait(binary.Left) {
                let spilledLeft = SpillExpression(binary.Left)
                locals.AddRange(spilledLeft.Locals)
                sideEffects.AddRange(spilledLeft.SideEffects)
                left = spilledLeft.Value
            }
            let endLabel = MakeLabel()
            // if (left) { tmp = true; goto end }
            sideEffects.Add(BoundConditionalGotoStatement(nil, endLabel, left, jumpIfTrue: true))
            // else: tmp = await b
            let spilledRight = SpillExpression(binary.Right)
            locals.AddRange(spilledRight.Locals)
            sideEffects.AddRange(spilledRight.SideEffects)
            sideEffects.Add(
                BoundExpressionStatement(nil, BoundAssignmentExpression(nil, resultLocal, spilledRight.Value))
            )
            let skipTrueLabel = MakeLabel()
            sideEffects.Add(BoundGotoStatement(nil, skipTrueLabel))
            // end:  (jumped to when left is true)
            sideEffects.Add(BoundLabelStatement(nil, endLabel))
            sideEffects.Add(
                BoundExpressionStatement(
                    nil,
                    BoundAssignmentExpression(nil, resultLocal, BoundLiteralExpression(nil, true))
                )
            )
            // skipTrue:
            sideEffects.Add(BoundLabelStatement(nil, skipTrueLabel))
            locals.Add(resultLocal)
            return BoundSpillSequenceExpression(
                nil,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                BoundVariableExpression(nil, resultLocal)
            )
        }

        private func SpillCall(call BoundCallExpression) BoundSpillSequenceExpression {
            let (locals, sideEffects, args) = SpillArgumentList(call.Arguments)
            if locals.Count == 0 && sideEffects.Count == 0 {
                return Trivial(call)
            }
            let value = BoundCallExpression(
                nil,
                call.Function,
                args.ToImmutable(),
                call.ReturnType,
                call.IsConditionalElided
            ){
                StaticGenericOwnerType = call.StaticGenericOwnerType,
                StaticGenericInterfaceOwnerType = call.StaticGenericInterfaceOwnerType,
                MethodTypeArguments = call.MethodTypeArguments
            }
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        private func SpillConstrainedStaticCall(
            call BoundConstrainedStaticCallExpression
        ) BoundSpillSequenceExpression {
            // ADR-0089 / issue #755: structurally identical to BoundCallExpression
            // for spilling — no receiver expression to evaluate, just argument
            // evaluation order needs preserving across awaits.
            let (locals, sideEffects, args) = SpillArgumentList(call.Arguments)
            if locals.Count == 0 && sideEffects.Count == 0 {
                return Trivial(call)
            }
            // Issue #3525: the imported-CLR-interface shape carries a
            // MethodInfo (ClrMethod) instead of a FunctionSymbol (InterfaceMethod).
            let value = if call.InterfaceMethod != nil {
                BoundConstrainedStaticCallExpression(
                    call.Syntax,
                    call.TypeParameter,
                    call.InterfaceMethod,
                    args.ToImmutable(),
                    call.ReturnType
                )
            } else {
                BoundConstrainedStaticCallExpression(
                    call.Syntax,
                    call.TypeParameter,
                    call.ClrMethod!!,
                    args.ToImmutable(),
                    call.ArgumentRefKinds,
                    call.ReturnType,
                    call.ConstrainedInterfaceType!!,
                    call.TypeArgumentSymbols
                )
            }
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        private func SpillImportedCall(call BoundImportedCallExpression) BoundSpillSequenceExpression {
            let (locals, sideEffects, args) = SpillArgumentList(call.Arguments)
            if locals.Count == 0 && sideEffects.Count == 0 {
                return Trivial(call)
            }
            let value = BoundImportedCallExpression(
                nil,
                call.Function,
                args.ToImmutable(),
                call.ArgumentRefKinds,
                call.TypeArgumentSymbols,
                call.StaticContainerType
            )
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        /// Shared receiver+argument spilling used by every instance-call
        /// spill ((cref:SpillImportedInstanceCall), (cref:SpillUserInstanceCall),
        /// (cref:SpillBaseInterfaceCall), (cref:SpillBaseClassCall)):
        /// spill the receiver if it (or any argument) contains an await, then
        /// spill the argument list itself.
        private func SpillReceiverAndArguments(receiver BoundExpression, arguments ImmutableArray[BoundExpression])(
            Locals ImmutableArray[LocalVariableSymbol],
            SideEffects ImmutableArray[BoundStatement],
            Receiver BoundExpression,
            Args ImmutableArray[BoundExpression]
        ) {
            var receiver = receiver
            let locals = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
            let sideEffects = ImmutableArray.CreateBuilder[BoundStatement]()
            // Spill the receiver if args contain an await.
            var argsHaveAwait = false
            for arg in arguments {
                if HasAwait(arg) {
                    argsHaveAwait = true
                    break
                }
            }
            if HasAwait(receiver) {
                let spilledReceiver = SpillExpression(receiver)
                locals.AddRange(spilledReceiver.Locals)
                sideEffects.AddRange(spilledReceiver.SideEffects)
                receiver = spilledReceiver.Value
            }
            if argsHaveAwait && !CanDeferAcrossLift(receiver) {
                receiver = StoreOperand(receiver, locals, sideEffects)
            }
            let (argLocals, argSideEffects, args) = SpillArgumentList(arguments)
            locals.AddRange(argLocals)
            sideEffects.AddRange(argSideEffects)
            return (locals.ToImmutable(), sideEffects.ToImmutable(), receiver, args.ToImmutable())
        }

        private func SpillImportedInstanceCall(call BoundImportedInstanceCallExpression) BoundSpillSequenceExpression {
            let (locals, sideEffects, receiver, args) = SpillReceiverAndArguments(call.Receiver, call.Arguments)
            if locals.IsEmpty && sideEffects.IsEmpty {
                return Trivial(call)
            }
            let value = BoundImportedInstanceCallExpression(
                nil,
                receiver,
                call.Method,
                call.Type,
                args,
                call.ArgumentRefKinds,
                call.TypeArgumentSymbols,
                call.ConstrainedReceiverTypeParameter,
                call.ConstrainedInterfaceType,
                call.IsNonVirtualBaseCall
            )
            return BoundSpillSequenceExpression(nil, locals, sideEffects, value)
        }

        private func SpillUserInstanceCall(call BoundUserInstanceCallExpression) BoundSpillSequenceExpression {
            let (locals, sideEffects, receiver, args) = SpillReceiverAndArguments(call.Receiver, call.Arguments)
            if locals.IsEmpty && sideEffects.IsEmpty {
                return Trivial(call)
            }
            let value = BoundUserInstanceCallExpression(
                nil,
                receiver,
                call.Method,
                args,
                call.Type,
                call.ConstrainedReceiverTypeParameter,
                call.ConstrainedInterfaceType
            ){MethodTypeArguments = call.MethodTypeArguments}
            return BoundSpillSequenceExpression(nil, locals, sideEffects, value)
        }

        private func SpillBaseInterfaceCall(call BoundBaseInterfaceCallExpression) BoundSpillSequenceExpression {
            let (locals, sideEffects, receiver, args) = SpillReceiverAndArguments(call.Receiver, call.Arguments)
            if locals.IsEmpty && sideEffects.IsEmpty {
                return Trivial(call)
            }
            let value = BoundBaseInterfaceCallExpression(nil, receiver, call.Interface, call.Method, args)
            return BoundSpillSequenceExpression(nil, locals, sideEffects, value)
        }

        private func SpillBaseClassCall(call BoundBaseClassCallExpression) BoundSpillSequenceExpression {
            let (locals, sideEffects, receiver, args) = SpillReceiverAndArguments(call.Receiver, call.Arguments)
            if locals.IsEmpty && sideEffects.IsEmpty {
                return Trivial(call)
            }
            let value = BoundBaseClassCallExpression(
                nil,
                receiver,
                call.BaseClass,
                call.Method,
                args,
                call.Type,
                call.Property,
                call.IsSetterAccessor
            ){MethodTypeArguments = call.MethodTypeArguments}
            return BoundSpillSequenceExpression(nil, locals, sideEffects, value)
        }

        private func SpillConversion(conv BoundConversionExpression) BoundSpillSequenceExpression {
            if !HasAwait(conv.Expression) {
                return Trivial(conv)
            }
            let spilled = SpillExpression(conv.Expression)
            let value = BoundConversionExpression(nil, conv.Type, spilled.Value)
            return BoundSpillSequenceExpression(nil, spilled.Locals, spilled.SideEffects, value)
        }

        private func SpillAssignment(assign BoundAssignmentExpression) BoundSpillSequenceExpression {
            if !HasAwait(assign.Expression) {
                return Trivial(assign)
            }
            let spilled = SpillExpression(assign.Expression)
            let value = BoundAssignmentExpression(nil, assign.Variable, spilled.Value)
            return BoundSpillSequenceExpression(nil, spilled.Locals, spilled.SideEffects, value)
        }

        private func SpillFieldAssignment(assign BoundFieldAssignmentExpression) BoundSpillSequenceExpression {
            // Receiver is a VariableSymbol — already a stable local read, no spilling needed.
            // Only the RHS Value can contain an await.
            if !HasAwait(assign.Value) {
                return Trivial(assign)
            }
            let spilled = SpillExpression(assign.Value)
            // Issue #3333 / #1644: an interface static field write has a null
            // Receiver and StructType, and carries the owning interface in
            // InterfaceType. Rebuilding it through the variable-receiver
            // constructor drops that, and the emitter parents the field at the
            // open-generic TypeDef instead of a TypeSpec.
            let value = if assign.InterfaceType != nil {
                BoundFieldAssignmentExpression(
                    nil,
                    assign.Field,
                    assign.InterfaceType,
                    spilled.Value,
                    assign.ResultType
                )
            } else {
                BoundFieldAssignmentExpression(
                    nil,
                    assign.Receiver,
                    BoundNodeForm.DeclaringType(assign),
                    assign.Field,
                    spilled.Value,
                    assign.ResultType
                )
            }
            return BoundSpillSequenceExpression(nil, spilled.Locals, spilled.SideEffects, value)
        }

        private func SpillIndexAssignment(assign BoundIndexAssignmentExpression) BoundSpillSequenceExpression {
            let combined = ImmutableArray.CreateBuilder[BoundExpression](assign.Indices.Length + 2)
            let targetExpression = assign.TargetExpression ??
                BoundVariableExpression(nil, BoundNodeForm.VariableTarget(assign))
            combined.Add(targetExpression)
            combined.AddRange(assign.Indices)
            combined.Add(assign.Value)
            let (locals, sideEffects, spilled) = SpillArgumentList(
                combined.MoveToImmutable(),
                spillEveryPreAwaitOperand: IsRectangularArrayType(targetExpression.Type)
            )
            if locals.Count == 0 && sideEffects.Count == 0 {
                return Trivial(assign)
            }
            let target = spilled[0]
            var offset = 1
            let indices = ImmutableArray.CreateBuilder[BoundExpression](assign.Indices.Length)
            for var i = 0; i < assign.Indices.Length; i++ {
                indices.Add(spilled[offset])
                offset++
            }
            let rhs = spilled[offset]
            let value = BoundIndexAssignmentExpression.WithExpressionTarget(
                nil,
                target,
                indices.MoveToImmutable(),
                rhs,
                assign.Type
            )
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        private func SpillUnary(unary BoundUnaryExpression) BoundSpillSequenceExpression {
            if !HasAwait(unary.Operand) {
                return Trivial(unary)
            }
            let spilled = SpillExpression(unary.Operand)
            // ADR-0186 §4: preserve the coercion check's message across the
            // await spill, for the same reason `BoundTreeRewriter` does.
            let value = BoundUnaryExpression(nil, unary.Op, spilled.Value, unary.IsChecked, unary.PlatformCheckMessage)
            return BoundSpillSequenceExpression(nil, spilled.Locals, spilled.SideEffects, value)
        }

        /// Spills a ternary/conditional expression (issue #1619). Unlike a
        /// plain binary expression, only one of `WhenTrue`/`WhenFalse`
        /// executes at runtime, so an await in an arm must not run
        /// unconditionally. This mirrors the if/else-with-goto expansion used
        /// by (cref:SpillLogicalAnd)/(cref:SpillLogicalOr): the
        /// condition (if it itself has an await) is spilled unconditionally
        /// first, then each arm's side effects are guarded behind a label so
        /// only the taken arm's await(s) actually run.
        private func SpillConditional(conditional BoundConditionalExpression) BoundSpillSequenceExpression {
            let conditionHasAwait = HasAwait(conditional.Condition)
            let trueHasAwait = HasAwait(conditional.WhenTrue)
            let falseHasAwait = HasAwait(conditional.WhenFalse)
            if !conditionHasAwait && !trueHasAwait && !falseHasAwait {
                return Trivial(conditional)
            }
            let locals = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
            let sideEffects = ImmutableArray.CreateBuilder[BoundStatement]()
            var condition = conditional.Condition
            if conditionHasAwait {
                let spilledCondition = SpillExpression(conditional.Condition)
                locals.AddRange(spilledCondition.Locals)
                sideEffects.AddRange(spilledCondition.SideEffects)
                condition = spilledCondition.Value
            }
            // Null exactly when the conditional is void: testing resultLocal
            // rather than a separate bool is what lets the analyzer see the
            // local is present wherever it is assigned or read.
            // Issue #4965 (ADR-0202): a never-typed conditional (every branch
            // exits) has no value to carry either.
            let resultLocal LocalVariableSymbol? = if conditional.Type == TypeSymbol.Void ||
                conditional.Type == TypeSymbol.Never {
                default(LocalVariableSymbol?)
            } else {
                MakeSpillTemp(conditional.Type)
            }
            let elseLabel = MakeLabel()
            let endLabel = MakeLabel()
            // if (!condition) goto else
            sideEffects.Add(BoundConditionalGotoStatement(nil, elseLabel, condition, jumpIfTrue: false))
            // then: result = whenTrue (spilled — only runs if condition was true)
            let spilledTrue = SpillExpression(conditional.WhenTrue)
            locals.AddRange(spilledTrue.Locals)
            sideEffects.AddRange(spilledTrue.SideEffects)
            if resultLocal != nil {
                sideEffects.Add(
                    BoundExpressionStatement(nil, BoundAssignmentExpression(nil, resultLocal, spilledTrue.Value))
                )
            } else if !(spilledTrue.Value is BoundLiteralExpression) {
                sideEffects.Add(BoundExpressionStatement(nil, spilledTrue.Value))
            }
            sideEffects.Add(BoundGotoStatement(nil, endLabel))
            // else: result = whenFalse (spilled — only runs if condition was false)
            sideEffects.Add(BoundLabelStatement(nil, elseLabel))
            let spilledFalse = SpillExpression(conditional.WhenFalse)
            locals.AddRange(spilledFalse.Locals)
            sideEffects.AddRange(spilledFalse.SideEffects)
            if resultLocal != nil {
                sideEffects.Add(
                    BoundExpressionStatement(nil, BoundAssignmentExpression(nil, resultLocal, spilledFalse.Value))
                )
            } else if !(spilledFalse.Value is BoundLiteralExpression) {
                sideEffects.Add(BoundExpressionStatement(nil, spilledFalse.Value))
            }
            // end:
            sideEffects.Add(BoundLabelStatement(nil, endLabel))
            if resultLocal == nil {
                return BoundSpillSequenceExpression(
                    nil,
                    locals.ToImmutable(),
                    sideEffects.ToImmutable(),
                    NoValue(conditional.Type)
                )
            }
            locals.Add(resultLocal)
            return BoundSpillSequenceExpression(
                nil,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                BoundVariableExpression(nil, resultLocal)
            )
        }

        /// Spills a switch expression (issue #1619 completion). A guard
        /// (`when` clause) containing `await` stays diagnostic-gated:
        /// a false guard must fall through to the next arm's pattern test, and
        /// replicating that retry as bound-tree control flow would mean
        /// re-implementing the whole pattern-matching decision tree
        /// ((cref:Emit.MethodBodyEmitter.EmitPattern) and friends) instead
        /// of reusing it — a duplication this pass avoids for every other kind.
        /// The discriminant and each arm's result value, however, are fully
        /// spillable: this method reuses the existing (unmodified) pattern-match
        /// dispatch to select which arm matched — by building a second,
        /// award-free "index" switch whose arms carry the same
        /// patterns/guards but return the arm's ordinal instead of its real
        /// result — and only then evaluates the *selected* arm's (possibly
        /// awaiting) result, via an if/else-if chain on the stored index. Any
        /// locals a pattern binds (e.g. `case Point(var x, var y)`) are
        /// still assigned by the (unmodified, reused) pattern test itself, so
        /// they remain visible to the result-evaluation chain.
        private func SpillSwitch(switchExpr BoundSwitchExpression) BoundSpillSequenceExpression {
            let discriminantHasAwait = HasAwait(switchExpr.Discriminant)
            var anyGuardHasAwait = false
            var anyResultHasAwait = false
            let rewrittenArms = ImmutableArray.CreateBuilder[BoundSwitchExpressionArm](switchExpr.Arms.Length)
            for arm in switchExpr.Arms {
                var guard_ BoundExpression? = arm.Guard
                if guard_ != nil && HasAwait(guard_) {
                    anyGuardHasAwait = true
                    guard_ = SpillSwitchGuard(guard_, "switch-expression")
                }
                if HasAwait(arm.Result) {
                    anyResultHasAwait = true
                }
                rewrittenArms.Add(BoundSwitchExpressionArm(arm.Syntax, arm.Pattern, guard_, arm.Result))
            }
            if !discriminantHasAwait && !anyGuardHasAwait && !anyResultHasAwait {
                return Trivial(switchExpr)
            }
            let arms = rewrittenArms.MoveToImmutable()
            let locals = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
            let sideEffects = ImmutableArray.CreateBuilder[BoundStatement]()
            var discriminant = switchExpr.Discriminant
            if discriminantHasAwait {
                let spilledDiscriminant = SpillExpression(switchExpr.Discriminant)
                locals.AddRange(spilledDiscriminant.Locals)
                sideEffects.AddRange(spilledDiscriminant.SideEffects)
                discriminant = spilledDiscriminant.Value
            }
            if !anyResultHasAwait {
                // Only the discriminant needed spilling — no arm result has an
                // await, so the existing opaque pattern-dispatch emission can
                // still own arm selection and result evaluation unmodified.
                let rebuiltSwitch = BoundSwitchExpression(nil, discriminant, arms, switchExpr.Type)
                return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), rebuiltSwitch)
            }
            // Phase 1: reuse the unmodified pattern/guard machinery to select
            // which arm matched, via a synthetic switch expression whose arms
            // return their own ordinal (an await-free int) instead of the real
            // (possibly awaiting) result.
            let indexArms = ImmutableArray.CreateBuilder[BoundSwitchExpressionArm](arms.Length)
            for var i = 0; i < arms.Length; i++ {
                let arm = arms[i]
                indexArms.Add(BoundSwitchExpressionArm(nil, arm.Pattern, arm.Guard, BoundLiteralExpression(nil, i)))
            }
            if switchExpr.Type == TypeSymbol.Void && !arms.Any((arm BoundSwitchExpressionArm) -> arm.IsCatchAll) {
                // The void switch runs no arm for an unmatched value (see
                // ExpressionBinder.BindSwitchExpression), so the index switch
                // gets a default that selects none instead of throwing.
                indexArms.Add(BoundSwitchExpressionArm(nil, nil, nil, BoundLiteralExpression(nil, -1)))
            }
            let indexSwitch = BoundSwitchExpression(nil, discriminant, indexArms.ToImmutable(), TypeSymbol.Int32)
            let armIndexLocal = MakeSpillTemp(TypeSymbol.Int32)
            locals.Add(armIndexLocal)
            sideEffects.Add(BoundVariableDeclaration(nil, armIndexLocal, indexSwitch))
            // Phase 2: dispatch on the stored arm index, evaluating only the
            // selected arm's (possibly awaiting) result. Issue #4966
            // (ADR-0202): a void switch (or one whose every arm exits) has no
            // result to carry, so each selected arm runs as a statement.
            let resultLocal LocalVariableSymbol? = if switchExpr.Type == TypeSymbol.Void ||
                switchExpr.Type == TypeSymbol.Never {
                default(LocalVariableSymbol?)
            } else {
                MakeSpillTemp(switchExpr.Type)
            }
            let endLabel = MakeLabel()
            let eqOperator = Invariant.Required(
                BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32),
                "int32 equality operator exists for spill dispatch",
                expression: "BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, TypeSymbol.Int32, TypeSymbol.Int32)"
            )
            var firstArmResultDeclared = false
            for var i = 0; i < arms.Length; i++ {
                let arm = arms[i]
                let nextArmLabel = MakeLabel()
                let isSelected = BoundBinaryExpression(
                    nil,
                    BoundVariableExpression(nil, armIndexLocal),
                    eqOperator,
                    BoundLiteralExpression(nil, i)
                )
                sideEffects.Add(BoundConditionalGotoStatement(nil, nextArmLabel, isSelected, jumpIfTrue: false))
                let spilledResult = SpillExpression(arm.Result)
                locals.AddRange(spilledResult.Locals)
                sideEffects.AddRange(spilledResult.SideEffects)
                if resultLocal == nil {
                    if !(spilledResult.Value is BoundLiteralExpression) {
                        sideEffects.Add(BoundExpressionStatement(nil, spilledResult.Value))
                    }
                } else if !firstArmResultDeclared {
                    // Declare resultLocal where the selected arm first assigns
                    // it, avoiding a redundant default initialization.
                    sideEffects.Add(BoundVariableDeclaration(nil, resultLocal, spilledResult.Value))
                    firstArmResultDeclared = true
                } else {
                    sideEffects.Add(
                        BoundExpressionStatement(nil, BoundAssignmentExpression(nil, resultLocal, spilledResult.Value))
                    )
                }
                sideEffects.Add(BoundGotoStatement(nil, endLabel))
                sideEffects.Add(BoundLabelStatement(nil, nextArmLabel))
            }
            sideEffects.Add(BoundLabelStatement(nil, endLabel))
            if resultLocal == nil {
                return BoundSpillSequenceExpression(
                    nil,
                    locals.ToImmutable(),
                    sideEffects.ToImmutable(),
                    NoValue(switchExpr.Type)
                )
            }
            locals.Add(resultLocal)
            return BoundSpillSequenceExpression(
                nil,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                BoundVariableExpression(nil, resultLocal)
            )
        }

        /// Issue #4965 / #4966 (ADR-0202): the value a spilled construct with
        /// no result leaves behind — the void placeholder for a void one, and
        /// for a never-typed one (every path exited) an unreachable `throw nil`
        /// trap that keeps the bottom type for the consumer.
        private func NoValue(type TypeSymbol) BoundExpression -> if type == TypeSymbol.Never {
            cast[BoundExpression](BoundThrowExpression(nil, BoundLiteralExpression(nil, value: nil)))
        } else {
            cast[BoundExpression](BoundLiteralExpression(nil, 0, TypeSymbol.Void))
        }

        /// Spills a null-conditional access (`?.`) expression (issue #1619
        /// completion). Mirrors (cref:SpillConditional): the receiver is
        /// always evaluated (spilled unconditionally if it has an await), but
        /// (cref:BoundNullConditionalAccessExpression.WhenNotNull) — and
        /// any await inside it — must only run on the non-nil path, so that
        /// path is expanded into explicit if/else statements instead of
        /// letting the opaque single-expression emission
        /// (`EmitNullConditionalAccess`) own it. The not-null branch
        /// reuses the general-purpose conversion emitter (rather than
        /// duplicating `EmitNullConditionalAccess`'s bespoke
        /// Nullable-wrap IL) to lift a value-typed result into
        /// (cref:BoundNullConditionalAccessExpression.Type) when needed.
        private func SpillNullConditionalAccess(nc BoundNullConditionalAccessExpression) BoundSpillSequenceExpression {
            // Issue #1700: a value-type `Nullable<T>` receiver (BCL, user
            // struct/enum) needs the statement-based (declare + goto/label)
            // rebuild below UNCONDITIONALLY — even when neither the receiver
            // nor WhenNotNull contains an await. `nc.Capture` is declared as
            // the unwrapped `T` (so member-access binding resolves against
            // `T`), so it can never directly hold the real `Nullable<T>`
            // receiver value. The shared variable emitter routes hoisted
            // captures to state-machine fields (issue #2771), but it cannot
            // reconcile this wrapper/unwrapped type mismatch.
            let isValueTypeNullableReceiver = nc
                .Receiver
                .Type is NullableTypeSymbol ncReceiverNullable &&
                NullableLifting.IsAnyValueTypeNullable(ncReceiverNullable)
            let receiverHasAwait = HasAwait(nc.Receiver)
            let whenNotNullHasAwait = HasAwait(nc.WhenNotNull)
            if !isValueTypeNullableReceiver && !receiverHasAwait && !whenNotNullHasAwait {
                return Trivial(nc)
            }
            let locals = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
            let sideEffects = ImmutableArray.CreateBuilder[BoundStatement]()
            var receiver = nc.Receiver
            if receiverHasAwait {
                let spilledReceiver = SpillExpression(nc.Receiver)
                locals.AddRange(spilledReceiver.Locals)
                sideEffects.AddRange(spilledReceiver.SideEffects)
                receiver = spilledReceiver.Value
            }
            if !isValueTypeNullableReceiver && !whenNotNullHasAwait {
                // Reference-type (or non-nullable-collapse) receiver, only
                // the receiver needed spilling — WhenNotNull is still
                // await-free. The emitter's shared variable load/store path
                // preserves nc.Capture whether it remains local or is hoisted.
                let rebuiltNc = BoundNullConditionalAccessExpression(
                    nil,
                    receiver,
                    nc.Capture,
                    nc.WhenNotNull,
                    nc.Type,
                    nc.ResultSlot
                )
                return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), rebuiltNc)
            }
            // Either WhenNotNull has an await (must run only on the non-nil
            // path, needing explicit if/else control flow) or the receiver
            // is a value-type Nullable<T> (needing the wrapper-local +
            // guard + `!!` unwrap shape regardless of await). Since this
            // path replaces the BoundNullConditionalAccessExpression node
            // entirely, nc.Capture is no longer discoverable by the
            // emitter's CollectNullConditionalCaptures walk (which only
            // finds the local through a surviving node of that kind) — it
            // must be registered as a spill local explicitly here or its
            // slot never gets planned.
            //
            // Issue #1700: a value-type `Nullable<T>` receiver cannot reuse
            // `nc.Capture` (declared as unwrapped `T`) to hold the raw
            // receiver, nor can a `T`-typed variable read be branched on
            // directly (both are the same StackUnexpected mismatch as the
            // reference-type Leg-1 case above). Route it through its own
            // `Nullable<T>`-typed wrapper local instead: declare
            // `wrapper := receiver`, guard on `wrapper` (its Nullable<T>
            // type makes EmitConditionalGotoProbe take the box-probe path),
            // then unwrap `wrapper` into `nc.Capture` via `!!`
            // (NullAssertion) only once the guard confirms HasValue — `!!`'s
            // emit path already has full, pre-existing support for user
            // struct/enum and BCL value-type Nullable<T> operands
            // (NullableValueTypeUnwrapCollector auto-slots any such node it
            // finds in the tree), so no new emitter plumbing is needed here.
            var wrapperLocal LocalVariableSymbol? = nil
            var guardCondition BoundExpression
            if isValueTypeNullableReceiver {
                wrapperLocal = MakeSpillTemp(receiver.Type)
                locals.Add(wrapperLocal)
                sideEffects.Add(BoundVariableDeclaration(nil, wrapperLocal, receiver))
                locals.Add(cast[LocalVariableSymbol](nc.Capture))
                sideEffects.Add(
                    BoundVariableDeclaration(
                        nil,
                        cast[LocalVariableSymbol](nc.Capture),
                        BoundDefaultExpression(nil, nc.Capture.Type)
                    )
                )
                guardCondition = BoundVariableExpression(nil, wrapperLocal)
            } else {
                // Declare the capture with the real receiver value so the
                // following null guard observes that value directly.
                locals.Add(cast[LocalVariableSymbol](nc.Capture))
                sideEffects.Add(BoundVariableDeclaration(nil, cast[LocalVariableSymbol](nc.Capture), receiver))
                guardCondition = BoundVariableExpression(nil, nc.Capture)
            }
            // Null exactly when the chain is void -- see SpillConditional.
            let resultLocal LocalVariableSymbol? = if object.ReferenceEquals(nc.Type, TypeSymbol.Void) {
                default(LocalVariableSymbol?)
            } else {
                MakeSpillTemp(nc.Type)
            }
            let nonNullLabel = MakeLabel()
            let endLabel = MakeLabel()
            // if (capture/wrapper) goto nonNull   (brtrue — reference/Nullable non-nil check)
            sideEffects.Add(BoundConditionalGotoStatement(nil, nonNullLabel, guardCondition, jumpIfTrue: true))
            // nil branch
            if resultLocal != nil {
                sideEffects.Add(BoundVariableDeclaration(nil, resultLocal, BoundDefaultExpression(nil, nc.Type)))
            }
            sideEffects.Add(BoundGotoStatement(nil, endLabel))
            // non-null branch
            sideEffects.Add(BoundLabelStatement(nil, nonNullLabel))
            if wrapperLocal != nil {
                let unwrapOp = Invariant.Required(
                    BoundUnaryOperator.Bind(SyntaxKind.BangBangToken, wrapperLocal.Type),
                    "the wrapper local is a nullable value type, for which the operator table always binds `!!`",
                    expression: "BoundUnaryOperator.Bind(SyntaxKind.BangBangToken, wrapperLocal.Type)"
                )
                let unwrap = BoundUnaryExpression(nil, unwrapOp, BoundVariableExpression(nil, wrapperLocal))
                sideEffects.Add(BoundExpressionStatement(nil, BoundAssignmentExpression(nil, nc.Capture, unwrap)))
            }
            let spilledWhenNotNull = SpillExpression(nc.WhenNotNull)
            locals.AddRange(spilledWhenNotNull.Locals)
            sideEffects.AddRange(spilledWhenNotNull.SideEffects)
            if resultLocal == nil {
                sideEffects.Add(BoundExpressionStatement(nil, spilledWhenNotNull.Value))
            } else {
                var value = spilledWhenNotNull.Value
                // ResultSlot != null marks a value-typed access result whose
                // WhenNotNull sub-tree pushes the raw underlying value, which
                // must be lifted into the Nullable<T>/nc.Type shape — unless
                // it's already a Nullable<T> itself (ADR-0073 chained `?.`).
                if nc.ResultSlot != nil && !(value.Type is NullableTypeSymbol) {
                    value = BoundConversionExpression(nil, nc.Type, value)
                }
                sideEffects.Add(BoundExpressionStatement(nil, BoundAssignmentExpression(nil, resultLocal, value)))
            }
            sideEffects.Add(BoundLabelStatement(nil, endLabel))
            if resultLocal != nil {
                locals.Add(resultLocal)
            }
            let resultValue = if resultLocal == nil {
                cast[BoundExpression](BoundLiteralExpression(nil, nil, TypeSymbol.Void))
            } else {
                cast[BoundExpression](BoundVariableExpression(nil, resultLocal))
            }
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), resultValue)
        }

        /// Spills a conditional address-of expression (ADR-0061; issue #1619
        /// completion). Unlike (cref:SpillConditional)'s ternary case,
        /// the *result* here is a managed pointer (`T&`), which
        /// cannot be carried across the if/else join in a plain spill temp:
        /// (cref:RefInitializationHoister) — the pass that runs
        /// immediately after this one — eliminates every `T&`-typed
        /// local by re-deriving its address from a *single* declaration-site
        /// template at every use site, since state-machine field hoisting
        /// can never hold a managed pointer. A local reassigned differently
        /// in each branch (one address in the "then" arm, a different one in
        /// the "else" arm) breaks that single-template assumption — the
        /// hoister only tracks the last template it walks over lexically,
        /// so it would silently rewrite every read to whichever branch's
        /// address expression appears last in the statement list, regardless
        /// of which branch actually ran (this was caught by
        /// `Await_In_Conditional_Address_Condition_Selects_Correct_RefBranch`
        /// failing with the wrong branch's value).
        ///
        /// The fix: never store the address itself across the join. Only the
        /// (plain-typed, non-byref) sub-expressions that an await could be
        /// nested inside — e.g. an indexer's index, a field access's receiver
        /// — are spilled, and only inside a guard that runs solely when that
        /// operand is the one selected (so its await never fires on the
        /// unchosen branch). The two (possibly-rebuilt) lvalue trees are then
        /// fed back into a fresh (cref:BoundConditionalAddressExpression)
        /// so the existing, unmodified `EmitConditionalAddress` emitter
        /// still performs the actual branch-and-take-address IL — it just
        /// re-evaluates the (already spilled, side-effect-free) condition a
        /// second time and reads whichever branch's temps were populated.
        private func SpillConditionalAddress(condAddr BoundConditionalAddressExpression) BoundSpillSequenceExpression {
            let conditionHasAwait = HasAwait(condAddr.Condition)
            let trueHasAwait = HasAwait(condAddr.WhenTrueOperand)
            let falseHasAwait = HasAwait(condAddr.WhenFalseOperand)
            if !conditionHasAwait && !trueHasAwait && !falseHasAwait {
                return Trivial(condAddr)
            }
            let locals = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
            let sideEffects = ImmutableArray.CreateBuilder[BoundStatement]()
            // If the condition contains an await, spill it exactly once, up
            // front, so the guards/rebuild below reference the resulting
            // value rather than re-running the await.
            var condition = condAddr.Condition
            if conditionHasAwait {
                let spilledCondition = SpillExpression(condAddr.Condition)
                locals.AddRange(spilledCondition.Locals)
                sideEffects.AddRange(spilledCondition.SideEffects)
                condition = spilledCondition.Value
            }
            // The condition is read up to three times below: the "then"
            // guard, the "else" guard, and the rebuilt
            // BoundConditionalAddressExpression that EmitConditionalAddress
            // re-evaluates. If it isn't already side-effect-free, materialize
            // it into a spill temp exactly once here so a side effect in the
            // condition (e.g. a method call) can't fire more than once.
            if !CanDeferAcrossLift(condition) {
                condition = StoreOperand(condition, locals, sideEffects)
            }
            var trueOperand = condAddr.WhenTrueOperand
            if trueHasAwait {
                // Guard: only spill (and evaluate any nested await) when this
                // branch is the one that will actually be selected.
                let skipTrueLabel = MakeLabel()
                sideEffects.Add(BoundConditionalGotoStatement(nil, skipTrueLabel, condition, jumpIfTrue: false))
                let spilledTrue = SpillExpression(condAddr.WhenTrueOperand)
                locals.AddRange(spilledTrue.Locals)
                sideEffects.AddRange(spilledTrue.SideEffects)
                trueOperand = spilledTrue.Value
                sideEffects.Add(BoundLabelStatement(nil, skipTrueLabel))
            }
            var falseOperand = condAddr.WhenFalseOperand
            if falseHasAwait {
                let skipFalseLabel = MakeLabel()
                sideEffects.Add(BoundConditionalGotoStatement(nil, skipFalseLabel, condition, jumpIfTrue: true))
                let spilledFalse = SpillExpression(condAddr.WhenFalseOperand)
                locals.AddRange(spilledFalse.Locals)
                sideEffects.AddRange(spilledFalse.SideEffects)
                falseOperand = spilledFalse.Value
                sideEffects.Add(BoundLabelStatement(nil, skipFalseLabel))
            }
            // Rebuild the original node kind so the existing (unmodified)
            // EmitConditionalAddress emitter still owns the actual
            // branch-and-take-address IL — it never sees a byref local.
            let value = BoundConditionalAddressExpression(
                nil,
                condition,
                trueOperand,
                falseOperand,
                condAddr.PointeeType
            )
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        private func SpillIndex(index BoundIndexExpression) BoundSpillSequenceExpression {
            let combined = ImmutableArray.CreateBuilder[BoundExpression](index.Indices.Length + 1)
            combined.Add(index.Target)
            combined.AddRange(index.Indices)
            let (locals, sideEffects, spilled) = SpillArgumentList(
                combined.MoveToImmutable(),
                spillEveryPreAwaitOperand: IsRectangularArrayType(index.Target.Type)
            )
            if locals.Count == 0 && sideEffects.Count == 0 {
                return Trivial(index)
            }
            let indices = ImmutableArray.CreateBuilder[BoundExpression](index.Indices.Length)
            for var i = 1; i < spilled.Count; i++ {
                indices.Add(spilled[i])
            }
            return BoundSpillSequenceExpression(
                nil,
                locals.ToImmutable(),
                sideEffects.ToImmutable(),
                BoundIndexExpression(nil, spilled[0], indices.MoveToImmutable(), index.Type)
            )
        }

        private func SpillClrStaticCall(call BoundClrStaticCallExpression) BoundSpillSequenceExpression {
            let (locals, sideEffects, args) = SpillArgumentList(call.Arguments)
            if locals.Count == 0 && sideEffects.Count == 0 {
                return Trivial(call)
            }
            let value = BoundClrStaticCallExpression(
                nil,
                call.Method,
                call.Type,
                args.ToImmutable(),
                call.ArgumentRefKinds
            )
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        private func SpillClrConstructorCall(call BoundClrConstructorCallExpression) BoundSpillSequenceExpression {
            let (locals, sideEffects, args) = SpillArgumentList(call.Arguments)
            if locals.Count == 0 && sideEffects.Count == 0 {
                return Trivial(call)
            }
            let value = BoundClrConstructorCallExpression(
                call.Syntax,
                call.ClrType,
                call.Constructor,
                args.ToImmutable(),
                call.Type,
                call.ArgumentRefKinds
            )
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        private func SpillConstructorCall(call BoundConstructorCallExpression) BoundSpillSequenceExpression {
            let (locals, sideEffects, args) = SpillArgumentList(call.Arguments)
            if locals.Count == 0 && sideEffects.Count == 0 {
                return Trivial(call)
            }
            let value = BoundConstructorCallExpression(
                call.Syntax,
                call.StructType,
                args.ToImmutable(),
                call.SelectedConstructor
            )
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        private func SpillConstructorChaining(call BoundConstructorChainingExpression) BoundSpillSequenceExpression {
            let (locals, sideEffects, args) = SpillArgumentList(call.Arguments)
            if locals.Count == 0 && sideEffects.Count == 0 {
                return Trivial(call)
            }
            let value = BoundConstructorChainingExpression(call.Syntax, call.SelectedConstructor, args.ToImmutable())
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        /// Spills a target/pointer expression together with a following
        /// argument list, preserving the rule that the target is evaluated
        /// before any argument (issue #1619). Used for indirect calls,
        /// function-pointer invocations, and CLR indexers.
        private func SpillTargetAndArguments(
            original BoundExpression,
            target BoundExpression,
            arguments ImmutableArray[BoundExpression],
            rebuild(BoundExpression, ImmutableArray[BoundExpression]) -> BoundExpression
        ) BoundSpillSequenceExpression {
            let combined = ImmutableArray.CreateBuilder[BoundExpression](arguments.Length + 1)
            combined.Add(target)
            combined.AddRange(arguments)
            let (locals, sideEffects, spilledCombined) = SpillArgumentList(combined.ToImmutable())
            if locals.Count == 0 && sideEffects.Count == 0 {
                return Trivial(original)
            }
            let spilledTarget = spilledCombined[0]
            let spilledArgs = ImmutableArray.CreateBuilder[BoundExpression](arguments.Length)
            for var i = 1; i < spilledCombined.Count; i++ {
                spilledArgs.Add(spilledCombined[i])
            }
            let value = rebuild(spilledTarget, spilledArgs.ToImmutable())
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        private func SpillIndirectCall(call BoundIndirectCallExpression) BoundSpillSequenceExpression {
            return SpillTargetAndArguments(
                call,
                call.Target,
                call.Arguments,
                func (target BoundExpression, arguments ImmutableArray[BoundExpression]) BoundExpression {
                    return BoundIndirectCallExpression(nil, target, call.FunctionType, arguments, call.ArgumentRefKinds)
                }
            )
        }

        private func SpillFunctionPointerInvocation(
            call BoundFunctionPointerInvocationExpression
        ) BoundSpillSequenceExpression {
            return SpillTargetAndArguments(
                call,
                call.Pointer,
                call.Arguments,
                func (pointer BoundExpression, arguments ImmutableArray[BoundExpression]) BoundExpression {
                    return BoundFunctionPointerInvocationExpression(nil, pointer, arguments, call.FunctionPointerType)
                }
            )
        }

        private func SpillClrIndex(index BoundClrIndexExpression) BoundSpillSequenceExpression {
            return SpillTargetAndArguments(
                index,
                index.Target,
                index.Arguments,
                func (target BoundExpression, arguments ImmutableArray[BoundExpression]) BoundExpression {
                    return BoundClrIndexExpression(
                        nil,
                        target,
                        index.Indexer,
                        arguments,
                        index.Type,
                        index.ConstrainedReceiverTypeParameter,
                        index.ConstrainedInterfaceType
                    )
                }
            )
        }

        private func SpillClrIndexAssignment(assign BoundClrIndexAssignmentExpression) BoundSpillSequenceExpression {
            // Target is a stable VariableSymbol (not a BoundExpression) — only
            // the indexer arguments and the assigned value can hold an await.
            let combined = ImmutableArray.CreateBuilder[BoundExpression](assign.Arguments.Length + 1)
            combined.AddRange(assign.Arguments)
            combined.Add(assign.Value)
            let (locals, sideEffects, spilled) = SpillArgumentList(combined.ToImmutable())
            if locals.Count == 0 && sideEffects.Count == 0 {
                return Trivial(assign)
            }
            let spilledArgs = ImmutableArray.CreateBuilder[BoundExpression](assign.Arguments.Length)
            for var i = 0; i < assign.Arguments.Length; i++ {
                spilledArgs.Add(spilled[i])
            }
            let spilledValue = spilled[assign.Arguments.Length]
            let value = if assign.TargetExpression != nil {
                BoundClrIndexAssignmentExpression.WithExpressionTarget(
                    nil,
                    assign.TargetExpression,
                    assign.Indexer,
                    spilledArgs.ToImmutable(),
                    spilledValue,
                    assign.Type,
                    assign.ConstrainedReceiverTypeParameter,
                    assign.ConstrainedInterfaceType
                )
            } else {
                BoundClrIndexAssignmentExpression(
                    nil,
                    BoundNodeForm.VariableTarget(assign),
                    assign.Indexer,
                    spilledArgs.ToImmutable(),
                    spilledValue,
                    assign.Type,
                    assign.ConstrainedReceiverTypeParameter,
                    assign.ConstrainedInterfaceType
                )
            }
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        private func SpillClrPropertyAccess(access BoundClrPropertyAccessExpression) BoundSpillSequenceExpression {
            // Receiver is null for a static member access — nothing to spill.
            if access.Receiver == nil {
                return Trivial(access)
            }
            return SpillOneOperand(
                access,
                access.Receiver!!,
                func (recv BoundExpression) BoundExpression {
                    return BoundClrPropertyAccessExpression(
                        nil,
                        recv,
                        access.Member,
                        access.Type,
                        access.StaticContainerType
                    )
                }
            )
        }

        private func SpillFieldAccess(fieldAccess BoundFieldAccessExpression) BoundSpillSequenceExpression {
            // Receiver is null for an interface-static field read — nothing to spill.
            if fieldAccess.Receiver == nil {
                return Trivial(fieldAccess)
            }
            return SpillOneOperand(
                fieldAccess,
                fieldAccess.Receiver!!,
                func (recv BoundExpression) BoundExpression {
                    return BoundFieldAccessExpression(
                        nil,
                        recv,
                        BoundNodeForm.DeclaringType(fieldAccess),
                        fieldAccess.Field,
                        fieldAccess.SubstitutedType,
                        fieldAccess.NarrowedType
                    )
                }
            )
        }

        private func SpillTupleLiteral(tupleLiteral BoundTupleLiteralExpression) BoundSpillSequenceExpression {
            let (locals, sideEffects, elements) = SpillArgumentList(tupleLiteral.Elements)
            if locals.Count == 0 && sideEffects.Count == 0 {
                return Trivial(tupleLiteral)
            }
            let value = BoundTupleLiteralExpression(nil, tupleLiteral.TupleType, elements.ToImmutable())
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        /// Spills an interpolated string's holes. By this point in the
        /// pipeline most interpolated strings have already been lowered to
        /// the handler pattern (a (cref:BoundBlockExpression), handled
        /// by (cref:SpillBlockExpression)); this path only fires for
        /// interpolated strings that reach the spiller in their raw
        /// part-list form (issue #1619).
        private func SpillInterpolatedString(
            interpolated BoundInterpolatedStringExpression
        ) BoundSpillSequenceExpression {
            let holeIndices = List[int32]()
            let holeValues = ImmutableArray.CreateBuilder[BoundExpression]()
            for var i = 0; i < interpolated.Parts.Length; i++ {
                let part = interpolated.Parts[i]
                if part.IsHole {
                    holeIndices.Add(i)
                    holeValues.Add(part.Value!!)
                }
            }
            let (locals, sideEffects, spilledHoles) = SpillArgumentList(holeValues.ToImmutable())
            if locals.Count == 0 && sideEffects.Count == 0 {
                return Trivial(interpolated)
            }
            let parts = ImmutableArray.CreateBuilder[BoundInterpolatedStringPart](interpolated.Parts.Length)
            parts.AddRange(interpolated.Parts)
            for var i = 0; i < holeIndices.Count; i++ {
                let partIndex = holeIndices[i]
                parts[partIndex] = parts[partIndex].WithValue(spilledHoles[i])
            }
            let value = BoundInterpolatedStringExpression(nil, parts.ToImmutable(), interpolated.Handler)
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        private func SpillArrayCreation(arrayCreation BoundArrayCreationExpression) BoundSpillSequenceExpression {
            if arrayCreation
                .DimensionExpressions
                .Length > 1 &&
                arrayCreation.ContainerType is RectangularArrayTypeSymbol rectangular {
                if !arrayCreation
                    .Elements
                    .IsDefaultOrEmpty &&
                    arrayCreation
                    .RectangularLengths
                    .Length == rectangular
                    .Rank {
                    let (initializerLocals, initializerSideEffects, spilledDimensions) = SpillArgumentList(
                        arrayCreation.DimensionExpressions,
                        spillEveryPreAwaitOperand: true
                    )
                    let arrayTemp = MakeSpillTemp(rectangular)
                    initializerLocals.Add(arrayTemp)
                    initializerSideEffects.Add(
                        BoundVariableDeclaration(
                            nil,
                            arrayTemp,
                            BoundArrayCreationExpression.CreateRectangular(
                                nil,
                                rectangular,
                                spilledDimensions.MoveToImmutable()
                            )
                        )
                    )
                    let arrayReference = BoundVariableExpression(nil, arrayTemp)
                    for var flatIndex = 0; flatIndex < arrayCreation.Elements.Length; flatIndex++ {
                        var element = arrayCreation.Elements[flatIndex]
                        if HasAwait(element) {
                            let spilledElement = SpillExpression(element)
                            initializerLocals.AddRange(spilledElement.Locals)
                            initializerSideEffects.AddRange(spilledElement.SideEffects)
                            element = spilledElement.Value
                        }
                        let indices = ImmutableArray.CreateBuilder[BoundExpression](rectangular.Rank)
                        var remainder = flatIndex
                        for var dimension = 0; dimension < rectangular.Rank; dimension++ {
                            var stride = 1
                            for var trailing = dimension + 1; trailing < rectangular.Rank; trailing++ {
                                stride *= arrayCreation.RectangularLengths[trailing]
                            }
                            let index = if stride == 0 {
                                0
                            } else {
                                remainder / stride
                            }
                            remainder = if stride == 0 {
                                0
                            } else {
                                remainder % stride
                            }
                            indices.Add(BoundLiteralExpression(nil, index, TypeSymbol.Int32))
                        }
                        initializerSideEffects.Add(
                            BoundExpressionStatement(
                                nil,
                                BoundIndexAssignmentExpression.WithExpressionTarget(
                                    nil,
                                    arrayReference,
                                    indices.MoveToImmutable(),
                                    element,
                                    rectangular.ElementType
                                )
                            )
                        )
                    }
                    return BoundSpillSequenceExpression(
                        nil,
                        initializerLocals.ToImmutable(),
                        initializerSideEffects.ToImmutable(),
                        arrayReference
                    )
                }
                let operands = ImmutableArray.CreateBuilder[BoundExpression](
                    arrayCreation.DimensionExpressions.Length + arrayCreation.Elements.Length
                )
                operands.AddRange(arrayCreation.DimensionExpressions)
                operands.AddRange(arrayCreation.Elements)
                let (rectangularLocals, rectangularSideEffects, spilled) = SpillArgumentList(
                    operands.MoveToImmutable(),
                    spillEveryPreAwaitOperand: true
                )
                if rectangularLocals.Count == 0 && rectangularSideEffects.Count == 0 {
                    return Trivial(arrayCreation)
                }
                let dimensions = spilled.Take(arrayCreation.DimensionExpressions.Length).ToImmutableArray()
                let rectangularElements = spilled.Skip(arrayCreation.DimensionExpressions.Length).ToImmutableArray()
                return BoundSpillSequenceExpression(
                    nil,
                    rectangularLocals.ToImmutable(),
                    rectangularSideEffects.ToImmutable(),
                    BoundArrayCreationExpression.CreateRectangular(
                        nil,
                        rectangular,
                        dimensions,
                        rectangularElements,
                        arrayCreation.RectangularLengths
                    )
                )
            }
            if arrayCreation.LengthExpression != nil {
                return SpillOneOperand(
                    arrayCreation,
                    arrayCreation.LengthExpression,
                    func (length BoundExpression) BoundExpression {
                        return BoundArrayCreationExpression(nil, arrayCreation.ContainerType, length)
                    }
                )
            }
            let (locals, sideEffects, elements) = SpillArgumentList(arrayCreation.Elements)
            if locals.Count == 0 && sideEffects.Count == 0 {
                return Trivial(arrayCreation)
            }
            let value = BoundArrayCreationExpression(nil, arrayCreation.ContainerType, elements.ToImmutable())
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        private func SpillStackAlloc(stackAlloc BoundStackAllocExpression) BoundSpillSequenceExpression {
            let combined = ImmutableArray.CreateBuilder[BoundExpression](stackAlloc.InitializerElements.Length + 1)
            combined.Add(stackAlloc.Count)
            combined.AddRange(stackAlloc.InitializerElements)
            let (locals, sideEffects, spilled) = SpillArgumentList(combined.ToImmutable())
            if locals.Count == 0 && sideEffects.Count == 0 {
                return Trivial(stackAlloc)
            }
            let spilledCount = spilled[0]
            let spilledElements = ImmutableArray.CreateBuilder[BoundExpression](stackAlloc.InitializerElements.Length)
            for var i = 1; i < spilled.Count; i++ {
                spilledElements.Add(spilled[i])
            }
            let value = BoundStackAllocExpression(
                nil,
                stackAlloc.ResultType,
                stackAlloc.ElementType,
                spilledCount,
                stackAlloc.IsPointerForm,
                spilledElements.ToImmutable()
            )
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        private func SpillStructLiteral(structLiteral BoundStructLiteralExpression) BoundSpillSequenceExpression {
            if structLiteral.CopySource != nil {
                return SpillOneOperand(
                    structLiteral,
                    structLiteral.CopySource,
                    func (source BoundExpression) BoundExpression {
                        return BoundStructLiteralExpression(
                            nil,
                            structLiteral.StructType,
                            structLiteral.Initializers,
                            source
                        )
                    }
                )
            }
            let values = ImmutableArray.CreateBuilder[BoundExpression](structLiteral.Initializers.Length)
            if structLiteral.CopySource != nil {
                values.Add(structLiteral.CopySource)
            }
            for init in structLiteral.Initializers {
                values.Add(init.Value)
            }
            let (locals, sideEffects, spilledValues) = SpillArgumentList(values.ToImmutable())
            if locals.Count == 0 && sideEffects.Count == 0 {
                return Trivial(structLiteral)
            }
            let initializers = ImmutableArray.CreateBuilder[BoundFieldInitializer](structLiteral.Initializers.Length)
            for var i = 0; i < structLiteral.Initializers.Length; i++ {
                let original = structLiteral.Initializers[i]
                initializers.Add(original with{Value = spilledValues[i]})
            }
            let value = BoundStructLiteralExpression(
                nil,
                structLiteral.StructType,
                initializers.ToImmutable(),
                if structLiteral.CopySource == nil {
                    default(BoundExpression?)
                } else {
                    spilledValues[0]
                },
                structLiteral.IsZeroInitialization
            )
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        private func SpillMapLiteral(mapLiteral BoundMapLiteralExpression) BoundSpillSequenceExpression {
            let kvExprs = ImmutableArray.CreateBuilder[BoundExpression](mapLiteral.Entries.Length * 2)
            for entry in mapLiteral.Entries {
                kvExprs.Add(entry.Key)
                kvExprs.Add(entry.Value)
            }
            let (locals, sideEffects, spilledKv) = SpillArgumentList(kvExprs.ToImmutable())
            if locals.Count == 0 && sideEffects.Count == 0 {
                return Trivial(mapLiteral)
            }
            let entries = ImmutableArray.CreateBuilder[BoundMapEntry](mapLiteral.Entries.Length)
            for var i = 0; i < mapLiteral.Entries.Length; i++ {
                entries.Add(BoundMapEntry(spilledKv[i * 2], spilledKv[(i * 2) + 1]))
            }
            let value = BoundMapLiteralExpression(nil, mapLiteral.MapType, entries.ToImmutable())
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        /// Spills a single-operand expression: if the operand has no await,
        /// returns the original expression unchanged (trivial); otherwise
        /// spills the operand and rebuilds via [`rebuild`](paramref).
        private func SpillOneOperand(
            original BoundExpression,
            operand BoundExpression,
            rebuild(BoundExpression) -> BoundExpression
        ) BoundSpillSequenceExpression {
            if !HasAwait(operand) {
                return Trivial(original)
            }
            let spilled = SpillExpression(operand)
            let value = rebuild(spilled.Value)
            return BoundSpillSequenceExpression(nil, spilled.Locals, spilled.SideEffects, value)
        }

        /// Spills two operands evaluated eagerly, left-to-right (no short
        /// circuiting) — mirrors the non-logical path of (cref:SpillBinary)
        /// and (cref:SpillIndexAssignment). If the second operand has
        /// an await, the first is spilled to a stable temp first (unless it's
        /// already pure/constant) so its value survives the suspension.
        private func SpillTwoOperand(
            original BoundExpression,
            a BoundExpression,
            b BoundExpression,
            rebuild(BoundExpression, BoundExpression) -> BoundExpression,
            preserveReceiverStorage bool = false
        ) BoundSpillSequenceExpression {
            let aHasAwait = HasAwait(a)
            let bHasAwait = HasAwait(b)
            if !aHasAwait && !bHasAwait {
                return Trivial(original)
            }
            let locals = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
            let sideEffects = ImmutableArray.CreateBuilder[BoundStatement]()
            var left = a
            if aHasAwait {
                let spilledA = SpillExpression(a)
                locals.AddRange(spilledA.Locals)
                sideEffects.AddRange(spilledA.SideEffects)
                left = spilledA.Value
            }
            if bHasAwait {
                if preserveReceiverStorage && SideEffectSpiller.IsInPlaceStorageWriteReceiver(left) {
                    // This pass also lifts control-flow blocks before SideEffectSpiller runs.
                    left = propertyReceiverSpiller.CapturePropertyStorageReceiver(
                        left,
                        sideEffects,
                        captureComponents: true
                    )
                    propertyReceiverSpiller.ProbeStorageReceiver(left, sideEffects)
                } else if !CanDeferAcrossLift(left) {
                    left = StoreOperand(left, locals, sideEffects)
                }
            }
            var right = if preserveReceiverStorage {
                SideEffectSpiller.SubstituteReceiver(b, a, left)
            } else {
                b
            }
            if bHasAwait {
                let spilledB = SpillExpression(right)
                locals.AddRange(spilledB.Locals)
                sideEffects.AddRange(spilledB.SideEffects)
                right = spilledB.Value
            }
            let value = rebuild(left, right)
            return BoundSpillSequenceExpression(nil, locals.ToImmutable(), sideEffects.ToImmutable(), value)
        }

        /// Spills a list of arguments. When argument K contains an await,
        /// all previous arguments (0..K-1) that are not pure/constant are
        /// spilled to temps to preserve evaluation order.
        private func SpillArgumentList(
            arguments ImmutableArray[BoundExpression],
            spillEveryPreAwaitOperand bool = false
        )(
            Locals ImmutableArray[LocalVariableSymbol].Builder,
            SideEffects ImmutableArray[BoundStatement].Builder,
            Args ImmutableArray[BoundExpression].Builder
        ) {
            let locals = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
            let sideEffects = ImmutableArray.CreateBuilder[BoundStatement]()
            let args = ImmutableArray.CreateBuilder[BoundExpression](arguments.Length)
            // First pass: determine which args have await. Cache the per-argument
            // result in a set so the main loop below reuses it instead of
            // re-walking each argument's subtree a second time (issue #1625).
            let awaitIndices = List[int32]()
            let argsWithAwait = HashSet[int32]()
            for var i = 0; i < arguments.Length; i++ {
                if HasAwait(arguments[i]) {
                    awaitIndices.Add(i)
                    argsWithAwait.Add(i)
                }
            }
            if awaitIndices.Count == 0 {
                // No awaits in arguments.
                for var i = 0; i < arguments.Length; i++ {
                    args.Add(arguments[i])
                }
                return (locals, sideEffects, args)
            }
            // We need to spill. Process args left-to-right.
            let firstAwaitIdx = awaitIndices[0]
            for var i = 0; i < arguments.Length; i++ {
                let arg = arguments[i]
                if argsWithAwait.Contains(i) {
                    // Spill this argument's await.
                    let spilledArg = SpillExpression(arg)
                    locals.AddRange(spilledArg.Locals)
                    sideEffects.AddRange(spilledArg.SideEffects)
                    var hasLaterAwait = false
                    for awaitIndex in awaitIndices {
                        hasLaterAwait |= awaitIndex > i
                    }
                    if hasLaterAwait && !CanDeferAcrossLift(spilledArg.Value) {
                        args.Add(StoreOperand(spilledArg.Value, locals, sideEffects))
                    } else {
                        args.Add(spilledArg.Value)
                    }
                } else if i < firstAwaitIdx && (spillEveryPreAwaitOperand || !CanDeferAcrossLift(arg)) {
                    // This arg precedes an await — spill to temp.
                    args.Add(StoreOperand(arg, locals, sideEffects))
                } else if i > firstAwaitIdx && (spillEveryPreAwaitOperand || !CanDeferAcrossLift(arg)) {
                    // Between awaits, we also need to check if there's a
                    // later await that would require this to be spilled.
                    var needsSpill = false
                    for awIdx in awaitIndices {
                        if awIdx > i {
                            needsSpill = true
                            break
                        }
                    }
                    if needsSpill {
                        args.Add(StoreOperand(arg, locals, sideEffects))
                    } else {
                        args.Add(arg)
                    }
                } else {
                    args.Add(arg)
                }
            }
            return (locals, sideEffects, args)
        }

        private func MakeSpillTemp(type TypeSymbol) LocalVariableSymbol {
            let name = GeneratedNames.SpillTempField(spillOrdinal++, spillTempDomain)
            return LocalVariableSymbol(name, isReadOnly: false, type)
        }

        /// Issue #4965 (ADR-0202): stores a spilled operand in a fresh temp and
        /// returns the read of it. An operand of the bottom (`never`) type — a
        /// throw expression, or a block, if or switch every path of which exits
        /// — is never stored: it runs as a statement, and the operand becomes
        /// the unreachable `throw nil` trap. Nothing after it runs, so no
        /// later operand, await or call is reached; even a state machine's
        /// resume edge into the rest of the sequence only reaches a `throw`.
        /// `never` has no CLR form, so a temp of that type could not be
        /// encoded (GS9998).
        /// @param value The operand to store.
        /// @param locals The spill locals of the current sequence.
        /// @param sideEffects The side effects of the current sequence.
        /// @returns The expression that reads the stored operand.
        private func StoreOperand(
            value BoundExpression,
            locals ImmutableArray[LocalVariableSymbol].Builder,
            sideEffects ImmutableArray[BoundStatement].Builder
        ) BoundExpression {
            if value.Type == TypeSymbol.Never {
                sideEffects.Add(BoundExpressionStatement(nil, value))
                return BoundThrowExpression(nil, BoundLiteralExpression(nil, value: nil))
            }
            let temp = MakeSpillTemp(value.Type)
            locals.Add(temp)
            sideEffects.Add(BoundVariableDeclaration(nil, temp, value))
            return BoundVariableExpression(nil, temp)
        }

        private func MakeLabel() BoundLabel {
            return BoundLabel("<>spill_label${spillOrdinal++}")
        }

        private func HasAwait(statement BoundStatement) bool -> AsyncBoundTreeQueries.HasAwait(statement, awaitMemo) ||
            (
            includeYieldInBlockExpressions && SpillSequenceSpiller.HasYieldInBlockExpression(
                statement,
                yieldInBlockMemo
            )
        ) ||
            (
            includeControlFlowInBlockExpressions && SpillSequenceSpiller.HasControlFlowInBlockExpression(
                statement,
                controlFlowInBlockMemo
            )
        )

        private func HasAwait(expression BoundExpression) bool -> AsyncBoundTreeQueries.HasAwait(
            expression,
            awaitMemo
        ) ||
            (
            includeYieldInBlockExpressions && SpillSequenceSpiller.HasYieldInBlockExpression(
                expression,
                yieldInBlockMemo
            )
        ) ||
            (
            includeControlFlowInBlockExpressions && SpillSequenceSpiller.HasControlFlowInBlockExpression(
                expression,
                controlFlowInBlockMemo
            )
        )

        shared {
            private func IsRectangularArrayType(type TypeSymbol) bool -> type is RectangularArrayTypeSymbol ||
                (type.ClrType is {IsArray: true} clrArray && clrArray.GetArrayRank() > 1)

            private func CanDeferAcrossLift(expression BoundExpression) bool -> expression is BoundLiteralExpression ||
                expression is BoundDefaultExpression

            private func Trivial(value BoundExpression) BoundSpillSequenceExpression {
                return BoundSpillSequenceExpression(
                    nil,
                    ImmutableArray[LocalVariableSymbol].Empty,
                    ImmutableArray[BoundStatement].Empty,
                    value
                )
            }

            private func FlushSideEffects(
                spill BoundSpillSequenceExpression,
                builder ImmutableArray[BoundStatement].Builder
            ) {
                // Emit variable declarations for the spill locals (they need IL slots).
                for local in spill.Locals {
                    // Only emit a declaration if the local isn't already declared as part
                    // of the side-effects (the await spill already uses BoundVariableDeclaration).
                    var alreadyDeclared = false
                    for stmt in spill.SideEffects {
                        if stmt is BoundVariableDeclaration decl && decl.Variable == local {
                            alreadyDeclared = true
                            break
                        }
                    }
                    if !alreadyDeclared {
                        builder.Add(BoundVariableDeclaration(nil, local, BoundDefaultExpression(nil, local.Type)))
                    }
                }
                for stmt in spill.SideEffects {
                    builder.Add(stmt)
                }
            }
        }
    }

    /// Rewrites [`body`](paramref) so that all awaits are at statement top-level.
    /// @param body The lowered async method body.
    /// @returns The spilled body (no (cref:BoundSpillSequenceExpression) nodes survive).
    func Rewrite(body BoundBlockStatement) BoundBlockStatement {
        if !AsyncBoundTreeQueries.HasAwait(body) {
            return body
        }
        let spiller = Spiller()
        let result = spiller.RewriteBlock(body)
        return result
    }

    /// Issue #3355: lifts block expressions containing `yield` statements
    /// to statement level before iterator state-machine rewriting. This keeps
    /// suspension points from branching out while a parent expression has
    /// partially populated the IL evaluation stack.
    /// @param body Lowered iterator body.
    /// @returns Body with yield-bearing block expressions lifted to statement level.
    func RewriteIteratorBlocks(body BoundBlockStatement) BoundBlockStatement {
        if !HasYieldInBlockExpression(body) {
            return body
        }
        return Spiller(includeYieldInBlockExpressions: true).RewriteBlock(body)
    }

    /// Issue #3355: lifts block expressions containing non-local control flow
    /// before emission so return/goto paths never abandon a partially-filled
    /// parent-expression evaluation stack.
    /// @param body Lowered function body.
    /// @returns Body with control-flow-bearing block expressions lifted to statement level.
    func RewriteControlFlowBlocks(body BoundBlockStatement) BoundBlockStatement {
        if !HasControlFlowInBlockExpression(body) {
            return body
        }
        return Spiller(includeControlFlowInBlockExpressions: true).RewriteBlock(body)
    }

    private func HasYieldInBlockExpression(node BoundNode, memo Dictionary[BoundNode, bool]? = nil) bool {
        if memo != nil && memo.TryGetValue(node, out var cached) {
            return cached
        }
        let walker = YieldInBlockExpressionWalker()
        walker.Visit(node)
        memo?.Add(node, walker.Found)
        return walker.Found
    }

    private func HasControlFlowInBlockExpression(node BoundNode, memo Dictionary[BoundNode, bool]? = nil) bool {
        if memo != nil && memo.TryGetValue(node, out var cached) {
            return cached
        }
        let walker = ControlFlowInBlockExpressionWalker()
        walker.Visit(node)
        memo?.Add(node, walker.Found)
        return walker.Found
    }
}
