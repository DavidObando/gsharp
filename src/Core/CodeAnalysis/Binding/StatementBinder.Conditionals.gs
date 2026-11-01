// <copyright file="StatementBinder.Conditionals.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import System.Collections
import System.Diagnostics.CodeAnalysis
import System.Threading

internal partial class StatementBinder {
    /// The narrowing frames an `if` condition implies for its then- and
    /// else-branches. Shared by the `if` statement and, for its guard, the
    /// `if let` statement (issue #4961 / ADR-0201). [`removedFacts`](paramref) are the facts that the
    /// condition's own effects removed (ADR-0208 R18), so a type test of such a path is classified against the
    /// type the path has now.
    private func ClassifyIfConditionNarrowing(
        condition BoundExpression,
        removedFacts Dictionary[AccessPath, TypeSymbol]? = nil
    )(Then Dictionary[AccessPath, TypeSymbol]?, Else Dictionary[AccessPath, TypeSymbol]?) {
        // Phase 3.C.4/6.6: recognise one top-level nullable guard. Boolean
        // conjunction/disjunction flow (for example `s != nil && IsValid(s)`)
        // is intentionally deferred for the nil-guard classifier.
        var thenNarrow Dictionary[AccessPath, TypeSymbol]?
        var elseNarrow Dictionary[AccessPath, TypeSymbol]?
        thenNarrow, elseNarrow = TryClassifyNilGuard(condition)
        if thenNarrow == nil && elseNarrow == nil {
            thenNarrow, elseNarrow = TryClassifyBoolCallNarrowing(condition)
        }
        // ADR-0069 / issue #700: smart-cast type-test narrowing on
        // `x is T`, `x !is T`, and `&&` chains thereof. Compose with the
        // nullable / `[NotNullWhen]` frames computed above so a condition
        // that combines both styles narrows on both axes.
        let (typeThen, typeElse) = TryClassifyTypeTestNarrowing(condition, removedFacts)
        return (MergeNarrowingFrames(thenNarrow, typeThen), MergeNarrowingFrames(elseNarrow, typeElse))
    }

    private func BindIfStatement(syntax IfStatementSyntax) BoundStatement {
        if syntax.Initializer == nil {
            let condition = bindExpressionWithTargetType(syntax.Condition, TypeSymbol.Bool)
            let removedFacts = ApplyConditionEffectsToNarrowings(syntax.Condition, condition)
            testAliases = AliasesBeforeHeader(ApplyHeaderCallableEffects(condition), syntax.Condition)
            let (thenNarrow, elseNarrow) = ClassifyIfConditionNarrowing(condition, removedFacts)
            testAliases = nil
            // ADR-0166: pattern variables are in scope in the branch their
            // match dominates: when-true in the then-branch, when-false in the
            // else-branch (`if !(x is T t) { ... } else { use(t) }`).
            let (patternThen, patternElse) = PatternVariables.Classify(condition)
            let callableEntry = CaptureExternalCallableAliases()
            let shadowFlow = ShadowBegin(condition)
            let joinEntry = binderCtx.Narrowing
            let joinExits = List[NarrowingState]()
            let outerConditionKills = if syntax.ElseClause == nil {
                conditionKillJournal
            } else {
                BeginThenBranchConditionKills()
            }
            let thenStatement = BindWithPatternVariables(
                patternThen,
                () -> {
                    return BindStatementWithNarrowing(syntax.ThenStatement, thenNarrow)
                }
            )
            let restoredConditionKills = if syntax.ElseClause == nil {
                default(List[(Frame NarrowingFrame, Path AccessPath, Type TypeSymbol)]?)
            } else {
                RestoreThenBranchConditionKills(outerConditionKills, joinEntry)
            }
            AddBranchExits(joinExits, thenStatement)
            ShadowAddBranch(shadowFlow, thenNarrow, thenStatement)
            let callableThenExit = CaptureExternalCallableAliases()
            RestoreExternalCallableAliases(callableEntry)
            ShadowBeginBranch(shadowFlow)
            let elseStatement = if syntax.ElseClause == nil {
                default(BoundStatement?)
            } else {
                BindWithPatternVariables(
                    patternElse,
                    () -> {
                        return BindStatementWithNarrowing(syntax.ElseClause!!.ElseStatement, elseNarrow)
                    }
                )
            }
            if restoredConditionKills != nil {
                EndThenBranchConditionKills(restoredConditionKills)
            }
            if elseStatement == nil {
                joinExits.Add(SkippedBranchExit(joinEntry, elseNarrow))
            } else {
                AddBranchExits(joinExits, elseStatement)
            }
            ShadowAddBranch(shadowFlow, elseNarrow, elseStatement)
            let callableElseExit = if syntax.ElseClause == nil {
                callableEntry
            } else {
                CaptureExternalCallableAliases()
            }
            RestoreJoinedExternalCallableAliases(callableThenExit, callableElseExit)
            let result = BoundIfStatement(syntax, condition, thenStatement, elseStatement)
            RecordIfExit(result, joinEntry, joinExits)
            ShadowFinish(shadowFlow, "if", syntax.Location, []BoundStatement{result}, false, false)
            // ADR-0069 / issue #700: record the else-frame so `BindBlockStatements`
            // can lift it into the enclosing block when the then-branch ends in
            // an unconditional exit (`return`/`throw`/`break`/`continue`).
            if elseNarrow != nil && elseNarrow.Count > 0 {
                binderCtx.PendingEarlyExitFrames[result] = elseNarrow
            }
            // ADR-0166: the same early-exit rule leaks pattern variables into
            // the statements that follow the `if` — `if !(x is T t) { return }`
            // makes `t` usable afterwards, and so does an else-branch that
            // always exits for the when-true variables. BindBlockStatements
            // declares them into the enclosing block scope.
            RecordPatternVariableLeak(result, patternThen, patternElse)
            return result
        }
        // `if init; cond { then } else { else }` lowers to a block that
        // scopes the initializer to both arms:
        //   {
        //     <init>
        //     if cond { then } else { else }
        //   }
        $scope = BoundScope($scope)
        let initializerAliasesAtEntry = externalCallableAliases.ToArray()
        let initStatement BoundStatement? = BindStatement(syntax.Initializer!!)
        if initStatement != nil {
            // ADR-0208 R18: the initializer runs before the condition and both branches, as the statement before
            // an `if` in the block this form lowers to.
            ApplyInitializerEffectsToNarrowings(syntax.Initializer!!, initStatement)
            UpdateExternalCallableAliases(initStatement, initializerAliasesAtEntry)
        }
        let initCondition = bindExpressionWithTargetType(syntax.Condition, TypeSymbol.Bool)
        let initRemovedFacts = ApplyConditionEffectsToNarrowings(syntax.Condition, initCondition)
        testAliases = AliasesBeforeHeader(ApplyHeaderCallableEffects(initCondition), syntax.Condition)
        let (initThenNarrow, initElseNarrow) = ClassifyIfConditionNarrowing(initCondition, initRemovedFacts)
        testAliases = nil
        let (initPatternThen, initPatternElse) = PatternVariables.Classify(initCondition)
        let initCallableEntry = CaptureExternalCallableAliases()
        let initShadowFlow = ShadowBegin(initCondition, initStatement)
        let initJoinEntry = binderCtx.Narrowing
        let initJoinExits = List[NarrowingState]()
        let initOuterConditionKills = if syntax.ElseClause == nil {
            conditionKillJournal
        } else {
            BeginThenBranchConditionKills()
        }
        let initThen = BindWithPatternVariables(
            initPatternThen,
            () -> {
                return BindStatementWithNarrowing(syntax.ThenStatement, initThenNarrow)
            }
        )
        let initRestoredConditionKills = if syntax.ElseClause == nil {
            default(List[(Frame NarrowingFrame, Path AccessPath, Type TypeSymbol)]?)
        } else {
            RestoreThenBranchConditionKills(initOuterConditionKills, initJoinEntry)
        }
        AddBranchExits(initJoinExits, initThen)
        ShadowAddBranch(initShadowFlow, initThenNarrow, initThen)
        let initCallableThenExit = CaptureExternalCallableAliases()
        RestoreExternalCallableAliases(initCallableEntry)
        ShadowBeginBranch(initShadowFlow)
        let initElse = if syntax.ElseClause == nil {
            default(BoundStatement?)
        } else {
            BindWithPatternVariables(
                initPatternElse,
                () -> {
                    return BindStatementWithNarrowing(syntax.ElseClause!!.ElseStatement, initElseNarrow)
                }
            )
        }
        if initRestoredConditionKills != nil {
            EndThenBranchConditionKills(initRestoredConditionKills)
        }
        if initElse == nil {
            initJoinExits.Add(SkippedBranchExit(initJoinEntry, initElseNarrow))
        } else {
            AddBranchExits(initJoinExits, initElse)
        }
        ShadowAddBranch(initShadowFlow, initElseNarrow, initElse)
        let initCallableElseExit = if syntax.ElseClause == nil {
            initCallableEntry
        } else {
            CaptureExternalCallableAliases()
        }
        RestoreJoinedExternalCallableAliases(initCallableThenExit, initCallableElseExit)
        $scope = $scope.Pop()
        let inner = BoundIfStatement(syntax, initCondition, initThen, initElse)
        if initElseNarrow != nil && initElseNarrow.Count > 0 {
            binderCtx.PendingEarlyExitFrames[inner] = initElseNarrow
        }
        let initResult = BoundBlockStatement(
            syntax,
            ImmutableArray.Create[BoundStatement](
                Invariant.Required(
                    initStatement,
                    "an if initializer has a bound statement",
                    expression: "initStatement"
                ),
                inner
            )
        )
        ShadowFinish(initShadowFlow, "if", syntax.Location, []BoundStatement{inner, initResult}, false, false)
        RecordIfExit(initResult, initJoinEntry, initJoinExits)
        return initResult
    }

    // ──────────────────────────────────────────────────────────────────────
    //  ADR-0071 / issue #708: `if let` and `guard let` binding statements.
    //
    //  Both forms strip one layer of nullability from the right-hand-side
    //  expression and introduce a fresh local for it. The lowering is
    //  expressed entirely in terms of existing bound-node kinds so the
    //  rewriter / walker / printer / spiller / emitter / interpreter
    //  surface needs no updates.
    // ──────────────────────────────────────────────────────────────────────
    /// ADR-0071 / issue #708, issue #4961 / ADR-0201: binds the `if let`
    /// STATEMENT. The header (bindings, optional guard, then-region) goes
    /// through (cref:IfLetBindingSupport.BindHeader), shared with the
    /// expression form, so a later initializer and the guard see earlier
    /// bindings narrowed and no binding is visible in the else branch. The
    /// lowering short-circuits left to right. Without an else branch (or with
    /// a single test) it stays in nested statements:
    ///
    /// ```
    /// if let a = e0, let b = e1 && g { T }
    /// =>
    /// { let a = e0; if a != nil { let b = e1; if b != nil && g { T } } }
    /// ```
    ///
    /// With an else branch and more than one test it lowers to forward
    /// conditional gotos to a single else label, so each branch appears
    /// exactly once and definite-assignment and return analysis see plain
    /// control flow.
    private func BindIfLetStatement(syntax IfLetStatementSyntax) BoundStatement {
        // The header (initializers and guard) runs before either branch, like
        // an `if` condition: fold its callable effects into the alias state
        // before the branches are bound, then join the branch exits, exactly as
        // BindIfStatement does.
        var callableEntry = CaptureExternalCallableAliases()
        var callableThenExit = callableEntry
        // The else-branch starts from the state before the header: the guard's facts hold only in the then-branch.
        let elseEntry = binderCtx.Narrowing
        var outerConditionKills = conditionKillJournal
        var thenKillsStarted = false
        let header = List[(Syntax SyntaxNode, Bound BoundExpression)]()
        let aliasesBeforeHeader = callableEntry
        let (clauses, guard_, thenStatement) = IfLetBindingSupport.BindHeader(
            binderCtx,
            syntax.Bindings,
            syntax.Guard,
            Diagnostics,
            conversions,
            bindTypeClause,
            (initializer ExpressionSyntax) -> {
                let bound = bindExpression(initializer, false)
                ApplyHeaderCallableEffects(bound)
                header.Add((initializer, bound))
                return bound
            },
            (identifier SyntaxToken, isReadOnly bool, type TypeSymbol) -> bindLocalVariable(
                identifier,
                isReadOnly,
                type
            ),
            (guardSyntax ExpressionSyntax) -> {
                let bound = bindExpressionWithTargetType(guardSyntax, TypeSymbol.Bool)
                testAliases = AliasesBeforeHeader(ApplyHeaderCallableEffects(bound), guardSyntax)
                header.Add((guardSyntax, bound))
                return bound
            },
            (boundGuard BoundExpression) -> {
                let guardThen = ClassifyIfConditionNarrowing(boundGuard).Then
                testAliases = nil
                return guardThen
            },
            () -> {
                callableEntry = CaptureExternalCallableAliases()
                if syntax.ElseClause != nil {
                    outerConditionKills = BeginThenBranchConditionKills()
                    thenKillsStarted = true
                }
                let then = BindStatementWithNarrowing(syntax.ThenStatement, nil)
                callableThenExit = CaptureExternalCallableAliases()
                RestoreExternalCallableAliases(callableEntry)
                return then
            }
        )
        testAliases = nil
        // ADR-0208 R18: as for an `if` statement, the else-branch is bound without the facts that the conditions in
        // the then-branch removed. The header runs on the else path too, so a fact that it can remove stays removed.
        let restoredConditionKills = if thenKillsStarted {
            RestoreThenBranchConditionKills(outerConditionKills, elseEntry, header, aliasesBeforeHeader)
        } else {
            default(List[(Frame NarrowingFrame, Path AccessPath, Type TypeSymbol)]?)
        }
        // Bound AFTER the header scope is popped: the else branch never sees
        // the bindings.
        let elseStatement = if syntax.ElseClause == nil {
            default(BoundStatement?)
        } else {
            BindStatement(syntax.ElseClause.ElseStatement)
        }
        if restoredConditionKills != nil {
            EndThenBranchConditionKills(restoredConditionKills)
        }
        let callableElseExit = if syntax.ElseClause == nil {
            callableEntry
        } else {
            CaptureExternalCallableAliases()
        }
        RestoreJoinedExternalCallableAliases(callableThenExit, callableElseExit)
        if !clauses.Any((clause IfLetBindingSupport.BoundIfLetClause) -> clause.Binding.IsValid) {
            // Every initializer was an error: keep the declarations so the
            // user still sees diagnostics, but no synthetic if-shape leaks.
            return BoundBlockStatement(
                syntax,
                clauses.Select(
                    (clause IfLetBindingSupport.BoundIfLetClause) -> cast[BoundStatement](DeclareIfLetClause(clause))
                )
                    .ToImmutableArray()
            )
        }
        let usableGuard = if guard_ is BoundErrorExpression {
            default(BoundExpression?)
        } else {
            guard_
        }
        // One `if` per valid non-final binding, plus the final `if` when the
        // final binding is valid or a guard is present.
        let last = clauses.Length - 1
        var ifCount = 0
        for var i = 0; i < last; i++ {
            if clauses[i].Binding.IsValid {
                ifCount++
            }
        }
        if clauses[last].Binding.IsValid || usableGuard != nil {
            ifCount++
        }
        if elseStatement == nil || ifCount == 1 {
            return BoundBlockStatement(
                syntax,
                LowerIfLetClauses(syntax, clauses, 0, usableGuard, thenStatement, elseStatement)
            )
        }
        // More than one test and an else branch: lower to forward conditional
        // gotos so each branch appears exactly once and every analysis
        // (definite assignment, return/reachability) sees plain control flow:
        //
        //   let a = e0
        //   if a == nil goto <else>
        //   let b = e1
        //   if b == nil goto <else>
        //   if !g goto <else>
        //   T
        //   goto <end>
        // <else>:
        //   F
        // <end>:
        //
        // (ADR-0071's matched flag hid the branch structure, so a statement
        // whose arms both return reported GS0100; a short-circuit block
        // condition lost which initializers ran, so an out argument of a later
        // initializer was not definitely assigned in the then-branch.) An
        // erroneous clause has already reported; it contributes only its
        // declaration.
        binderCtx.LabelCounter++
        let elseLabel = BoundLabel("ifLetElse${binderCtx.LabelCounter}")
        let endLabel = BoundLabel("ifLetEnd${binderCtx.LabelCounter}")
        let lowered = ImmutableArray.CreateBuilder[BoundStatement]()
        for clause in clauses {
            lowered.Add(DeclareIfLetClause(clause))
            if clause.Binding.IsValid {
                let test = Invariant.Required(
                    IfLetBindingSupport.BuildNilCheckChain(clause.Syntax, []VariableSymbol{clause.Binding.Variable}),
                    "a valid if-let binding has a nil check",
                    expression: "IfLetBindingSupport.BuildNilCheckChain(clause.Syntax, new[] { clause.Binding.Variable })"
                )
                lowered.Add(BoundConditionalGotoStatement(syntax, elseLabel, test, jumpIfTrue: false))
            }
        }
        if usableGuard != nil {
            lowered.Add(BoundConditionalGotoStatement(syntax, elseLabel, usableGuard, jumpIfTrue: false))
        }
        lowered.Add(thenStatement)
        lowered.Add(BoundGotoStatement(syntax, endLabel))
        lowered.Add(BoundLabelStatement(syntax, elseLabel))
        lowered.Add(Invariant.Required(elseStatement, "the goto shape has an else branch", expression: "elseStatement"))
        lowered.Add(BoundLabelStatement(syntax, endLabel))
        return BoundBlockStatement(syntax, lowered.ToImmutable())
    }

    /// Issue #4961 / ADR-0201: lowers clauses `index..` of an `if let`
    /// statement into nested statements, assuming every earlier binding
    /// matched: the clause's declaration, then an `if` on its nil test (an
    /// erroneous clause has no test) wrapping the remaining clauses. The final
    /// clause's test is conjoined with the guard. `elseStatement` is non-null
    /// only when the caller knows exactly one `if` is produced.
    private func LowerIfLetClauses(
        syntax IfLetStatementSyntax,
        clauses ImmutableArray[IfLetBindingSupport.BoundIfLetClause],
        index int32,
        $guard BoundExpression?,
        thenStatement BoundStatement,
        elseStatement BoundStatement?
    ) ImmutableArray[BoundStatement] {
        let clause = clauses[index]
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.Add(DeclareIfLetClause(clause))
        let test BoundExpression? = if clause.Binding.IsValid {
            IfLetBindingSupport.BuildNilCheckChain(clause.Syntax, []VariableSymbol{clause.Binding.Variable})
        } else {
            nil
        }
        if index == clauses.Length - 1 {
            var condition = test
            if $guard != nil {
                condition = if condition == nil {
                    $guard
                } else {
                    let andOp = Invariant.Required(
                        BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool),
                        "boolean if-let tests support logical conjunction",
                        expression: "BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool)"
                    )
                    BoundBinaryExpression(syntax, condition, andOp, $guard)
                }
            }
            if condition == nil {
                statements.Add(thenStatement)
            } else {
                statements.Add(BoundIfStatement(syntax, condition, thenStatement, elseStatement))
            }
            return statements.ToImmutable()
        }
        let rest = LowerIfLetClauses(
            syntax,
            clauses,
            index + 1,
            $guard,
            thenStatement,
            if test == nil {
                elseStatement
            } else {
                nil
            }
        )
        if test == nil {
            statements.AddRange(rest)
        } else {
            statements.Add(BoundIfStatement(syntax, test, BoundBlockStatement(syntax, rest), elseStatement))
        }
        return statements.ToImmutable()
    }

    private func DeclareIfLetClause(
        clause IfLetBindingSupport.BoundIfLetClause
    ) BoundVariableDeclaration -> BoundVariableDeclaration(
        clause.Syntax,
        clause.Binding.Variable,
        clause.Binding.Initializer
    )

    /// ADR-0071: bind a single `let name [T] = expr`
    /// binding clause inside an `if let` or `guard let` header.
    /// Returns the synthesized variable (or `null` when the clause is
    /// erroneous), its underlying non-null type, and the resulting decl.
    /// The variable is declared in the binder's current scope; callers
    /// control that scope to scope the binding to a then-block or enclosing
    /// block as appropriate. The nullable-stripping rules
    /// themselves live in (cref:IfLetBindingSupport), shared with the
    /// ADR-0151 `if let` expression and ADR-0163 `while let`.
    private func BindIfLetBindingClause(binding IfLetBindingClauseSyntax)(
        Variable VariableSymbol?,
        Underlying TypeSymbol?,
        Declaration BoundStatement
    ) {
        let bound = IfLetBindingSupport.BindBindingClause(
            binding,
            Diagnostics,
            conversions,
            bindTypeClause,
            (syntax ExpressionSyntax) -> {
                return bindExpression(syntax, false)
            },
            (identifier SyntaxToken, isReadOnly bool, type TypeSymbol) -> {
                return bindLocalVariable(identifier, isReadOnly, type)
            }
        )
        let declaration = BoundVariableDeclaration(binding, bound.Variable, bound.Initializer)
        return if bound.IsValid {
            (bound.Variable, bound.Underlying, declaration)
        } else {
            (nil, nil, declaration)
        }
    }

    /// ADR-0071 / issue #708: standalone fallback for binding
    /// `guard let` when it appears outside a block (for example as a
    /// stray statement at the top of a function body when the outer
    /// dispatch routes through (cref:BindStatement)). The normal
    /// path goes through (cref:BindGuardLetStatementInBlock), which
    /// integrates with the enclosing block's narrowing frame.
    private func BindGuardLetStatement(syntax GuardLetStatementSyntax) BoundStatement {
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        let pseudoFrame = NarrowingFrame()
        BindGuardLetStatementInBlock(syntax, statements, pseudoFrame)
        return BoundBlockStatement(syntax, statements.ToImmutable())
    }

    /// ADR-0071 / issue #708: bind `guard let` into the enclosing
    /// statement builder so the synthesized locals and the narrowings
    /// extend the enclosing block. Each binding becomes a let-decl
    /// followed by an `if x == nil { else }` whose else-block is the
    /// user's exit clause; the existing
    /// (cref:ApplyEarlyExitNarrowings) path lifts each binding's
    /// non-nil narrowing into [`persistentFrame`](paramref).
    private func BindGuardLetStatementInBlock(
        syntax GuardLetStatementSyntax,
        statements ImmutableArray[BoundStatement].Builder,
        persistentFrame NarrowingFrame
    ) {
        // The else block must be re-bound once per binding arm because the
        // ControlFlowGraph builder demands that each BoundStatement appear
        // at most once in the tree (it keys block lookup by statement
        // identity). Re-binding the same syntax repeatedly would otherwise
        // report every diagnostic inside the else block once per arm
        // (issue #1637), so only the first bind's diagnostics are kept;
        // subsequent re-binds are truncated back to that point.
        var hasBoundElseOnce = false
        for binding in syntax.Bindings {
            let (variable, underlying, decl) = BindIfLetBindingClause(binding)
            statements.Add(decl)
            // The initializer ran before the else block and the next binding: a getter in it can clear
            // storage that a guarded alias names (ADR-0208 R12).
            InvalidateNarrowingsForAssignedVariables(binding, decl)
            if variable == nil || underlying == nil {
                continue
            }
            // Bind a fresh copy of the else block for this arm so that the
            // ControlFlowGraph builder sees a unique BoundStatement
            // instance per arm.
            let diagMark = Diagnostics.Count
            let armElse = BindStatement(syntax.ElseStatement)
            if hasBoundElseOnce {
                Diagnostics.TruncateTo(diagMark)
            } else {
                hasBoundElseOnce = true
                if !EndsInUnconditionalExit(armElse) {
                    Diagnostics.ReportGuardLetElseMustExit(syntax.ElseStatement.Location)
                }
            }
            // Build `if <var> == nil { else }`.
            let read = BoundVariableExpression(binding, variable)
            let nilLiteral = BoundLiteralExpression(binding, nil, TypeSymbol.Null)
            let eqOp = Invariant.Required(
                BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, variable.Type, TypeSymbol.Null),
                "a guard-let variable supports nil equality",
                expression: "BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, variable.Type, TypeSymbol.Null)"
            )
            let condition = BoundBinaryExpression(binding, read, eqOp, nilLiteral)
            let ifStmt = BoundIfStatement(
                binding,
                condition,
                Invariant.Required(armElse, "a guard-let else arm has a bound statement", expression: "armElse"),
                elseStatement: nil
            )
            // Manually thread the persistent-frame narrowing for this
            // binding. We *cannot* round-trip through
            // ApplyEarlyExitNarrowings because that helper consumes
            // entries from PendingEarlyExitFrames keyed by the if node;
            // we have the data inline here, so just promote directly.
            //
            // Issue #4285: this is the exact same early-exit-lift hazard
            // ApplyEarlyExitNarrowings guards against — `guard let p = b.Pet
            // else { goto Skip }` structurally "exits" via the goto, but a
            // goto elsewhere in the function could land at `Skip:` (or
            // anywhere past this guard-let) without that exit ever having
            // been taken. Since this call site never goes through
            // ApplyEarlyExitNarrowings, it needs its own copy of the same
            // whole-function suppression.
            if !binderCtx.FunctionContainsUserGotoOrLabel {
                persistentFrame[variable] = underlying
            }
            statements.Add(ifStmt)
        }
        // If every arm's binding clause failed (all `continue`d above), the
        // else block was never bound and its diagnostics -- including
        // GS0297 -- would silently vanish. Bind it once here, purely for
        // diagnostics; it isn't wired into any statement since there's no
        // successful binding left to guard.
        if !hasBoundElseOnce {
            let armElse = BindStatement(syntax.ElseStatement)
            if !EndsInUnconditionalExit(armElse) {
                Diagnostics.ReportGuardLetElseMustExit(syntax.ElseStatement.Location)
            }
        }
    }

    /// ADR-0166: binds a statement with the given pattern variables declared in
    /// a fresh child scope (see (cref:PatternVariables.BindInScope{T})).
    private func BindWithPatternVariables(
        variables ImmutableArray[LocalVariableSymbol],
        bind() -> BoundStatement
    ) BoundStatement -> PatternVariables.BindInScope(binderCtx, variables, bind)

    /// ADR-0166: parks the pattern variables that [`ifStatement`](paramref)
    /// leaks into the statements following it: the condition's when-false
    /// variables when the then-branch always exits, plus its when-true
    /// variables when the else-branch always exits. Consumed by
    /// (cref:ApplyEarlyExitPatternVariables) from
    /// `BindBlockStatements`, so an `else if` (which is not a direct
    /// block statement) never leaks — the outer condition's other path could
    /// reach the following statements without the match.
    private func RecordPatternVariableLeak(
        ifStatement BoundIfStatement,
        whenTrue ImmutableArray[LocalVariableSymbol],
        whenFalse ImmutableArray[LocalVariableSymbol]
    ) {
        if whenTrue.IsDefaultOrEmpty && whenFalse.IsDefaultOrEmpty {
            return
        }
        let leaked = ImmutableArray.CreateBuilder[LocalVariableSymbol]()
        if !whenFalse.IsDefaultOrEmpty && EndsInUnconditionalExit(ifStatement.ThenStatement) {
            leaked.AddRange(whenFalse)
        }
        if !whenTrue.IsDefaultOrEmpty &&
            ifStatement.ElseStatement != nil &&
            EndsInUnconditionalExit(ifStatement.ElseStatement) {
            leaked.AddRange(whenTrue)
        }
        if leaked.Count > 0 {
            binderCtx.PendingPatternVariableLeaks[ifStatement] = leaked.ToImmutable()
        }
    }

    /// ADR-0166: declares the pattern variables parked by
    /// (cref:RecordPatternVariableLeak) into the current (enclosing
    /// block) scope. A name that is already declared in that scope is reported
    /// once, at the designation.
    private func ApplyEarlyExitPatternVariables(statement BoundStatement?) {
        if statement is not BoundIfStatement ifStatement || !binderCtx.PendingPatternVariableLeaks.TryGetValue(
            ifStatement,
            out var leaked
        ) {
            return
        }
        binderCtx.PendingPatternVariableLeaks.Remove(ifStatement)
        // Issue #4285: same hazard as ApplyEarlyExitNarrowings — a goto
        // elsewhere in the function can jump directly to a point after this
        // if-statement without ever taking the exiting arm, so the "leaked"
        // pattern variable would be declared-in-scope but never actually
        // assigned on that path (reading it is worse than a narrowing bug:
        // an uninitialized/default-valued read, not merely a wrongly-
        // narrowed nilable one). Suppress the leak under the same
        // whole-function conservative rule.
        if binderCtx.FunctionContainsUserGotoOrLabel {
            return
        }
        for variable in leaked {
            if !$scope.TryDeclareVariable(variable) && variable.DeclaringSyntax is SyntaxNode declaring {
                Diagnostics.ReportSymbolAlreadyDeclared(declaring.Location, variable.Name)
            }
        }
    }

    /// ADR-0069 / issue #700: classify `is` / `!is` tests (and
    /// `&&` chains thereof) on a local-variable or parameter
    /// receiver into per-branch narrowing frames.
    /// @param condition The bound condition expression.
    /// @returns A pair of narrowing frames — the first applies to the
    /// then-branch, the second to the else-branch. Either may be
    /// `null` if the corresponding branch has no narrowing.
    private func TryClassifyTypeTestNarrowing(
        condition BoundExpression,
        removedFacts Dictionary[AccessPath, TypeSymbol]? = nil
    )(Then Dictionary[AccessPath, TypeSymbol]?, Else Dictionary[AccessPath, TypeSymbol]?) {
        switch condition {
            case isExpr is BoundIsExpression {
                {
                    if TestMayRemoveItsOperandFact(isExpr) {
                        return (nil, nil)
                    }
                    let operandType = TypeTestOperandTypeAfterEffects(isExpr, removedFacts)
                    if isExpr.Pattern is BoundNotPattern notPattern {
                        return (
                            nil,
                            TryClassifyPatternNarrowing(
                                isExpr.Expression,
                                notPattern.Pattern,
                                allowReadOnlyGlobals: false,
                                operandType
                            )
                        )
                    }
                    return (
                        TryClassifyPatternNarrowing(
                            isExpr.Expression,
                            isExpr.Pattern,
                            allowReadOnlyGlobals: false,
                            operandType
                        ),
                        nil
                    )
                }
            }
            case unary is BoundUnaryExpression when unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation {
                {
                    let (inThen, inElse) = TryClassifyTypeTestNarrowing(unary.Operand, removedFacts)
                    return (inElse, inThen)
                }
            }
            case binary is BoundBinaryExpression when binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd {
                {
                    // De Morgan for `&&`: then = thenL ∧ thenR (both true → both narrowings apply).
                    // The else frame is intentionally dropped — either operand could have been
                    // the false one, so we cannot single out a per-variable narrowing.
                    let aliasesBeforeLeft = testAliases
                    let (leftThen, _) = TryClassifyTypeTestNarrowing(binary.Left, removedFacts)
                    testAliases = AliasesAfterTrue(binary.Left, aliasesBeforeLeft)
                    let (rightThen, _) = TryClassifyTypeTestNarrowing(binary.Right, removedFacts)
                    let combinedThen Dictionary[AccessPath, TypeSymbol]? = MergeNarrowingFrames(leftThen, rightThen)
                    if combinedThen == nil || combinedThen.Count == 0 {
                        return (nil, nil)
                    }
                    return (combinedThen, nil)
                }
            }
            case binary is BoundBinaryExpression when binary.Op.Kind == BoundBinaryOperatorKind.LogicalOr {
                {
                    // ADR-0069 addendum / issue #712: De Morgan dual of `&&` for `||`.
                    // For `A || B`:
                    //   • then = intersection of thenL and thenR — only narrowings present
                    //     in BOTH operands' then-frames with the same target type survive
                    //     (canonical example: `x is T || x is T` keeps `{x → T}`).
                    //   • else = elseL ∧ elseR — when the whole `||` is false, BOTH operands
                    //     were false, so both negative narrowings apply.
                    let aliasesBeforeLeft = testAliases
                    let (leftThen, leftElse) = TryClassifyTypeTestNarrowing(binary.Left, removedFacts)
                    testAliases = AliasesAfter(binary.Left, aliasesBeforeLeft)
                    let (rightThen, rightElse) = TryClassifyTypeTestNarrowing(binary.Right, removedFacts)
                    let combinedThen Dictionary[AccessPath, TypeSymbol]? = IntersectNarrowingFrames(leftThen, rightThen)
                    let combinedElse Dictionary[AccessPath, TypeSymbol]? = MergeNarrowingFrames(leftElse, rightElse)
                    if (combinedThen == nil || combinedThen.Count == 0) &&
                        (combinedElse == nil || combinedElse.Count == 0) {
                        return (nil, nil)
                    }
                    return (combinedThen, combinedElse)
                }
            }
        }
        return (nil, nil)
    }

    /// ADR-0208 R18 (#5534): the condition is bound before its effects apply, so the operand of a type test reads
    /// the fact from before the condition ran. When the condition's effects removed that fact (the operand still
    /// has the removed type), the test is classified against the declared type of the path, the type the path has
    /// after the effects. Otherwise the bound type is the current one and `nil` keeps it. Only a fact that strips
    /// `?` or `!` from a reference type qualifies: its read emits no conversion, so the test sees the current
    /// value. A subtype fact (`castclass`) or a nullable value (an unwrap) would test the stale read.
    private func TypeTestOperandTypeAfterEffects(
        isExpr BoundIsExpression,
        removedFacts Dictionary[AccessPath, TypeSymbol]?
    ) TypeSymbol? {
        if removedFacts == nil {
            return nil
        }
        let operand = isExpr.Expression
        if operand is BoundVariableExpression variable {
            return if removedFacts.TryGetValue(AccessPath.ForVariable(variable.Variable), out var removedType) &&
                operand.Type == removedType &&
                IsNullabilityOnlyFact(variable.Variable.Type, removedType) {
                variable.Variable.Type
            } else {
                default(TypeSymbol?)
            }
        }
        if SmartCastStability.TryGetStableMemberPath(operand, out var path, out var currentType) &&
            removedFacts.TryGetValue(path!!, out var removedMemberType) && currentType == removedMemberType {
            let declared = MemberLookup.GetDeclaredAccessPathType(path!!, currentType!!)
            return if IsNullabilityOnlyFact(declared, currentType!!) {
                declared
            } else {
                default(TypeSymbol?)
            }
        }
        return nil
    }

    /// ADR-0208 R18 (#5534): a pattern runs after its operand is read, and a getter with user code in a property
    /// sub-pattern can change the tested path (`x is Dog { P: 1 }` where `P` sets `x = nil`). Such a test proves
    /// nothing about the value a branch reads, so it narrows neither branch. The one statement rule
    /// (cref:StatementKillsPath) decides, applied to the effects of the test, which include a call in a constant
    /// pattern (`x is Read(h)`).
    private func TestMayRemoveItsOperandFact(isExpr BoundIsExpression) bool {
        let pattern = if isExpr.Pattern is BoundNotPattern notPattern {
            notPattern.Pattern
        } else {
            isExpr.Pattern
        }
        if RunsNoCode(pattern) {
            return false
        }
        var path AccessPath? = nil
        if isExpr.Expression is BoundVariableExpression variable {
            path = variable.Variable
        } else if !SmartCastStability.TryGetStableMemberPath(isExpr.Expression, out path, out _) {
            return false
        }
        CompilationMeasurements.Count("narrowing.pattern-effect-walks")
        if isExpr.Syntax is {} anchor {
            EnsureClosureAssignedNames(anchor)
        }
        let collector = NewCollector(nil, testAliases ?? externalCallableAliases)
        collector.Visit(isExpr)
        return StatementKillsPath(
            collector,
            path!!,
            collector.MayMutateMemberPaths,
            collector.MayMutateReferenceStorage
        )
    }

    /// ADR-0208 R18 (#5534): the callable aliases at the start of a condition, when its header effects removed
    /// some or it assigns a variable. A test reads the aliases at its own evaluation point
    /// (cref:AliasesAfterTrue), not after the whole condition: a later reassignment (`(x is action()) &&
    /// (action = f) ...`) does not change it, and an earlier one to an external callable (`(action = callback) is
    /// {} a && (x is action())`) does.
    private func AliasesBeforeHeader(removed HashSet[VariableSymbol]?, header SyntaxNode) HashSet[VariableSymbol]? {
        if (removed == nil || removed.Count == 0) && !header.DescendantNodesAndSelf().Any(
            (node SyntaxNode) -> node is AssignmentExpressionSyntax
        ) {
            return nil
        }
        let aliases = HashSet[VariableSymbol](externalCallableAliases)
        if removed != nil {
            aliases.UnionWith(removed)
        }
        return aliases
    }

    // The aliases after [`operand`](paramref) when it is true, from the aliases before it: the right operand of
    // `&&` runs only after the left one was true, so a chain is followed operand by operand. Each operand is read
    // once, at its evaluation point. The sets are replaced, never changed in place.
    private func AliasesAfterTrue(operand BoundExpression, before HashSet[VariableSymbol]?) HashSet[VariableSymbol]? {
        if before == nil {
            return nil
        }
        return if operand is BoundBinaryExpression binary && binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd {
            AliasesAfterTrue(binary.Right, AliasesAfterTrue(binary.Left, before))
        } else {
            AliasesAfter(operand, before)
        }
    }

    // The aliases after [`operand`](paramref) on every path, from the aliases before it. An assignment of an external
    // callable adds the alias.
    private func AliasesAfter(operand BoundExpression, before HashSet[VariableSymbol]?) HashSet[VariableSymbol]? {
        if before == nil {
            return nil
        }
        let collector = NewCollector(nil, before)
        collector.VisitExpression(operand)
        let after = HashSet[VariableSymbol](collector.DefinitelyExternalFunctionValues)
        if collector.MayMutateAnyRootViaPointer {
            after.Clear()
        }
        if collector.MayMutateAnyRoot || collector.MayRunEscapedClosure {
            after.RemoveWhere(NamesClosureAssignedStorage)
        }
        return after
    }

    // A pattern that reads no member and evaluates no expression: a discard, a literal, a type test, or `{}`.
    private func RunsNoCode(pattern BoundPattern) bool -> switch pattern {
        case BoundDiscardPattern: true
        case constantPattern is BoundConstantPattern: constantPattern.Value is BoundLiteralExpression
        case typePattern is BoundTypePattern: typePattern.PropertyPattern == nil ||
            RunsNoCode(typePattern.PropertyPattern)
        case propertyPattern is BoundPropertyPattern: propertyPattern.Fields.Length == 0
        default: false
    }

    private func IsNullabilityOnlyFact(declared TypeSymbol, fact TypeSymbol) bool -> switch declared {
        case nullable is NullableTypeSymbol: nullable.UnderlyingType == fact && !NullableLifting.IsValueTypeNullable(
            nullable
        ) &&
            !NullableLifting.IsUserValueTypeNullable(nullable)
        case platform is PlatformTypeSymbol: platform.UnderlyingType == fact
        default: false
    }

    private func TryClassifyNilGuard(condition BoundExpression)(
        NonNil Dictionary[AccessPath, TypeSymbol]?,
        Nil Dictionary[AccessPath, TypeSymbol]?
    ) {
        // ADR-0069 addendum / issue #712: compose nil-guard classification across
        // `!`, `&&`, and `||` so guards like `if a == nil || cond { ... } else { use(a) }`
        // narrow `a` to its non-nullable underlying type in the else-branch.
        switch condition {
            case unary is BoundUnaryExpression when unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation {
                {
                    let (inThen, inElse) = TryClassifyNilGuard(unary.Operand)
                    return (inElse, inThen)
                }
            }
            case bin is BoundBinaryExpression when bin.Op.Kind == BoundBinaryOperatorKind.LogicalAnd {
                {
                    let (leftThen, _) = TryClassifyNilGuard(bin.Left)
                    let (rightThen, _) = TryClassifyNilGuard(bin.Right)
                    let combinedThen Dictionary[AccessPath, TypeSymbol]? = MergeNarrowingFrames(leftThen, rightThen)
                    if combinedThen == nil || combinedThen.Count == 0 {
                        return (nil, nil)
                    }
                    return (combinedThen, nil)
                }
            }
            case bin is BoundBinaryExpression when bin.Op.Kind == BoundBinaryOperatorKind.LogicalOr {
                {
                    let (leftThen, leftElse) = TryClassifyNilGuard(bin.Left)
                    let (rightThen, rightElse) = TryClassifyNilGuard(bin.Right)
                    let combinedThen Dictionary[AccessPath, TypeSymbol]? = IntersectNarrowingFrames(leftThen, rightThen)
                    let combinedElse Dictionary[AccessPath, TypeSymbol]? = MergeNarrowingFrames(leftElse, rightElse)
                    if (combinedThen == nil || combinedThen.Count == 0) &&
                        (combinedElse == nil || combinedElse.Count == 0) {
                        return (nil, nil)
                    }
                    return (combinedThen, combinedElse)
                }
            }
        }
        // Phase 3.C.4: recognise the canonical narrowing patterns via the shared
        // leaf classifier (SmartCastStability.TryClassifyNilGuardLeaf), kept in
        // sync with ExpressionBinder.ClassifyTypeTestNarrowing (issue #1545). We
        // support only single-variable/stable-path guards here at the leaf;
        // conjunctions, disjunctions and pattern-based narrowing compose via the
        // cases above.
        if !SmartCastStability.TryClassifyNilGuardLeaf(
            condition,
            restrictBareVariableToLocalsAndParams: false,
            referenceNullableOnly: false,
            out var target,
            out var underlying,
            out var nonNilWhenTrue
        ) {
            return (nil, nil)
        }
        var nonNilFrame Dictionary[AccessPath, TypeSymbol]? = nil
        var nilFrame Dictionary[AccessPath, TypeSymbol]? = nil
        target = Invariant.Required(target, "a classified nil guard identifies its target", expression: "target")
        underlying = Invariant.Required(
            underlying,
            "a classified nil guard identifies its underlying type",
            expression: "underlying"
        )
        if nonNilWhenTrue {
            nonNilFrame = Dictionary[AccessPath, TypeSymbol]{[target] = underlying}
        } else {
            nilFrame = Dictionary[AccessPath, TypeSymbol]{[target] = underlying}
        }
        return (nonNilFrame, nilFrame)
    }

    private func TryClassifyBoolCallNarrowing(condition BoundExpression)(
        Then Dictionary[AccessPath, TypeSymbol]?,
        Else Dictionary[AccessPath, TypeSymbol]?
    ) {
        var negate = false
        var inner = condition
        if inner is BoundUnaryExpression unary && unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation {
            negate = true
            inner = unary.Operand
        }
        while inner is BoundBlockExpression block {
            inner = block.Expression
        }
        if inner is BoundImportedCallExpression importedCall && importedCall.Type == TypeSymbol.Bool {
            var (thenFrame, elseFrame) = ClassifyImportedBoolCallNarrowing(importedCall, negate)
            MergeClrMemberNotNullWhenNarrowings(importedCall.Function.Method, negate, &thenFrame, &elseFrame)
            return (thenFrame, elseFrame)
        }
        if inner is BoundImportedInstanceCallExpression importedInstanceCall &&
            importedInstanceCall.Type == TypeSymbol
            .Bool {
            var (thenFrame, elseFrame) = ClassifyImportedMethodBoolCallNarrowing(
                importedInstanceCall.Method.GetParameters(),
                importedInstanceCall.Arguments,
                negate
            )
            MergeClrMemberNotNullWhenNarrowings(importedInstanceCall.Method, negate, &thenFrame, &elseFrame)
            return (thenFrame, elseFrame)
        }
        if inner is BoundCallExpression userCall && userCall.Type == TypeSymbol.Bool {
            var (thenFrame, elseFrame) = ClassifyUserBoolCallNarrowing(userCall, negate)
            MergeUserMemberNotNullWhenNarrowings(userCall.Function.Attributes, negate, &thenFrame, &elseFrame)
            return (thenFrame, elseFrame)
        }
        if inner is BoundUserInstanceCallExpression userInstanceCall && userInstanceCall.Type == TypeSymbol.Bool {
            // Spelled with the declared `?` rather than `var (a, b) = (default(T),
            // default(T))`: the translated G# gives that tuple form the
            // non-null type `T`, which differs from these `ref T?` parameters
            // (GS0612, issue #4422).
            var thenFrame Dictionary[AccessPath, TypeSymbol]? = nil
            var elseFrame Dictionary[AccessPath, TypeSymbol]? = nil
            MergeUserMemberNotNullWhenNarrowings(userInstanceCall.Method.Attributes, negate, &thenFrame, &elseFrame)
            return (thenFrame, elseFrame)
        }
        return (nil, nil)
    }

    // Issue #208: merge [MemberNotNullWhen] field narrowings from a CLR-imported method.
    private func MergeClrMemberNotNullWhenNarrowings(
        method MethodInfo,
        negate bool,
        ref thenFrame Dictionary[AccessPath, TypeSymbol]?,
        ref elseFrame Dictionary[AccessPath, TypeSymbol]?
    ) {
        if !ClrNullability.TryGetMemberNotNullWhenData(method, out var returnValue, out var members) {
            return
        }
        let narrowThen = returnValue != negate
        let frame = if narrowThen {
            (
                (
                    if thenFrame == nil {
                        (thenFrame = Dictionary[AccessPath, TypeSymbol]())
                    } else {
                        thenFrame
                    }
                )!!
            )
        } else {
            (
                (
                    if elseFrame == nil {
                        (elseFrame = Dictionary[AccessPath, TypeSymbol]())
                    } else {
                        elseFrame
                    }
                )!!
            )
        }
        for name in members {
            NarrowFieldIfNullable(name, frame)
        }
    }

    // Issue #208: merge [MemberNotNullWhen] field narrowings from a user-declared method.
    private func MergeUserMemberNotNullWhenNarrowings(
        attributes ImmutableArray[BoundAttribute],
        negate bool,
        ref thenFrame Dictionary[AccessPath, TypeSymbol]?,
        ref elseFrame Dictionary[AccessPath, TypeSymbol]?
    ) {
        if attributes.IsDefaultOrEmpty {
            return
        }
        for attr in attributes {
            if !KnownAttributes.TryGetMemberNotNullWhenData(attr, out var returnValue, out var members) {
                continue
            }
            let narrowThen = returnValue != negate
            let frame = if narrowThen {
                (
                    (
                        if thenFrame == nil {
                            (thenFrame = Dictionary[AccessPath, TypeSymbol]())
                        } else {
                            thenFrame
                        }
                    )!!
                )
            } else {
                (
                    (
                        if elseFrame == nil {
                            (elseFrame = Dictionary[AccessPath, TypeSymbol]())
                        } else {
                            elseFrame
                        }
                    )!!
                )
            }
            for name in members {
                NarrowFieldIfNullable(name, frame)
            }
        }
    }

    private func BindStatementWithNarrowing(
        syntax StatementSyntax,
        frame Dictionary[AccessPath, TypeSymbol]?
    ) BoundStatement {
        let inheritedFallthrough = currentStatementListFallsThrough
        let inheritedPotentialReachabilityLabel = binderCtx.PotentialReachabilityLabel
        try {
            if frame == nil {
                return Invariant.Required(
                    BindStatement(syntax),
                    "a narrowed statement has a bound statement",
                    expression: "BindStatement(syntax)"
                )
            }
            binderCtx.PushNarrowingFrame(frame)
            try {
                return Invariant.Required(
                    BindStatement(syntax),
                    "a narrowed statement has a bound statement",
                    expression: "BindStatement(syntax)"
                )
            } finally {
                binderCtx.EndNarrowingProof()
            }
        } finally {
            currentStatementListFallsThrough = inheritedFallthrough
            this.binderCtx.PotentialReachabilityLabel = inheritedPotentialReachabilityLabel
        }
    }

    // Issue #991: bind a switch-arm `when` guard as a boolean expression under
    // the arm's pattern-narrowing frame. A non-bool guard surfaces the standard
    // conversion diagnostic.
    private func BindGuardExpressionWithNarrowing(
        syntax ExpressionSyntax,
        frame Dictionary[AccessPath, TypeSymbol]?
    ) BoundExpression {
        if frame == nil {
            return bindExpressionWithTargetType(syntax, TypeSymbol.Bool)
        }
        binderCtx.PushNarrowingFrame(frame)
        try {
            return bindExpressionWithTargetType(syntax, TypeSymbol.Bool)
        } finally {
            binderCtx.EndNarrowingProof()
        }
    }

    private func BindMultiAssignmentStatement(syntax MultiAssignmentStatementSyntax) BoundStatement {
        let targets = syntax.Targets.ToImmutableArray()
        let values = syntax.Values.ToImmutableArray()
        let isShortDecl = syntax.OperatorToken.Kind == SyntaxKind.ColonEqualsToken
        if isShortDecl {
            if targets.Length != values.Length {
                Diagnostics.ReportMultiAssignmentMismatch(syntax.Location, targets.Length, values.Length)
                return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
            }
            let declarations = ImmutableArray.CreateBuilder[BoundStatement]()
            for var i = 0; i < targets.Length; i++ {
                if targets[i] is not NameExpressionSyntax nameExpr {
                    Diagnostics.ReportInvalidMultiAssignmentTarget(targets[i].Location)
                    let _ = bindExpression(values[i], false)
                    continue
                }
                let initializer = bindExpression(values[i], false)
                if IsDiscard(nameExpr.IdentifierToken) {
                    continue
                }
                let variable = bindLocalVariable(nameExpr.IdentifierToken, false, initializer.Type)
                declarations.Add(BoundVariableDeclaration(syntax, variable, initializer))
            }
            return BoundBlockStatement(syntax, declarations.ToImmutable())
        }
        if values.Length == 1 && targets.Length > 1 {
            return BindTupleValuedMultiAssignment(syntax, targets, values[0])
        }
        if targets.Length != values.Length {
            Diagnostics.ReportMultiAssignmentMismatch(syntax.Location, targets.Length, values.Length)
            return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
        }
        let captures = ImmutableArray.CreateBuilder[BoundStatement]()
        let plans = ImmutableArray.CreateBuilder[MultiAssignmentTargetPlan](targets.Length)
        for var i = 0; i < targets.Length; i++ {
            plans.Add(
                if IsDiscardTarget(targets[i]) {
                    MultiAssignmentTargetPlan(bindExpression(values[i], false), createWrite: nil)
                } else {
                    (
                        if targets[i] is MultiAssignmentDeclarationExpressionSyntax declaration {
                            MultiAssignmentTargetPlan(bindExpression(values[i], false), createWrite: nil, declaration)
                        } else {
                            BindMultiAssignmentTarget(targets[i], values[i], syntax.OperatorToken, captures)
                        }
                    )
                }
            )
        }
        return BuildMultiAssignmentBlock(syntax, captures, plans)
    }

    private func BindTupleValuedMultiAssignment(
        syntax MultiAssignmentStatementSyntax,
        targets ImmutableArray[ExpressionSyntax],
        valueSyntax ExpressionSyntax
    ) BoundStatement {
        var tupleValue BoundExpression
        if IsChannelReceiveSyntax(valueSyntax, out var receive) {
            // ADR-0174 D3: `v, ok = <-ch` (and ADR-0168's mixed `let v, ok = <-ch`,
            // which declares `v` and assigns the existing `ok`) is the two-value
            // receive — the element (its zero value once closed) and whether the
            // channel delivered it. It is a `(T, bool)` tuple from here on, so
            // the ordinary multi-assignment machinery does the rest.
            if targets.Length != 2 {
                Diagnostics.ReportChannelBindingTargetCount(
                    syntax.Location,
                    "value, ok = <-ch",
                    "two targets",
                    targets.Length
                )
                return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
            }
            let received BoundExpression? = BindTwoValueReceive(receive, out _)
            if received == nil {
                return BoundExpressionStatement(syntax, BoundErrorExpression(nil))
            }
            tupleValue = received
        } else {
            tupleValue = bindExpression(valueSyntax, false)
        }
        if tupleValue.Type == TypeSymbol.Error {
            return BoundExpressionStatement(syntax, tupleValue)
        }
        if tupleValue.Type is not TupleTypeSymbol tupleType {
            Diagnostics.ReportMultiAssignmentMismatch(syntax.Location, targets.Length, 1)
            return BoundExpressionStatement(syntax, tupleValue)
        }
        if targets.Length != tupleType.Arity {
            Diagnostics.ReportMultiAssignmentMismatch(syntax.Location, targets.Length, tupleType.Arity)
            return BoundExpressionStatement(syntax, tupleValue)
        }
        let (tupleTemp, tupleElements) = CreateTupleDeconstructionPlan(valueSyntax, tupleType)
        let captures = ImmutableArray.CreateBuilder[BoundStatement]()
        let plans = ImmutableArray.CreateBuilder[MultiAssignmentTargetPlan](targets.Length)
        for var i = 0; i < targets.Length; i++ {
            if IsDiscardTarget(targets[i]) {
                plans.Add(MultiAssignmentTargetPlan(assignedValue: nil, createWrite: nil))
                continue
            }
            if targets[i] is MultiAssignmentDeclarationExpressionSyntax declaration {
                plans.Add(MultiAssignmentTargetPlan(tupleElements[i], createWrite: nil, declaration))
                continue
            }
            let source = DeclareMultiAssignmentTemp("element$i", tupleType.ElementTypes[i])
            let sourceToken = SyntaxToken(
                syntax.SyntaxTree,
                SyntaxKind.IdentifierToken,
                valueSyntax.Location.Span.Start,
                source.Name,
                source.Name
            )
            let sourceSyntax = NameExpressionSyntax(syntax.SyntaxTree, sourceToken)
            var plan = BindMultiAssignmentTarget(targets[i], sourceSyntax, syntax.OperatorToken, captures)
            if plan.AssignedValue != nil {
                plan = plan.WithAssignedValue(
                    MultiAssignmentTupleElementRewriter(source, tupleElements[i]).Replace(plan.AssignedValue)
                )
            }
            plans.Add(plan)
        }
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.AddRange(captures)
        statements.Add(BoundVariableDeclaration(syntax, tupleTemp, tupleValue))
        AppendMultiAssignmentValuesAndWrites(syntax, plans, statements)
        return BoundBlockStatement(syntax, statements.ToImmutable())
    }

    private func BuildMultiAssignmentBlock(
        syntax MultiAssignmentStatementSyntax,
        captures ImmutableArray[BoundStatement].Builder,
        plans ImmutableArray[MultiAssignmentTargetPlan].Builder
    ) BoundStatement {
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.AddRange(captures)
        AppendMultiAssignmentValuesAndWrites(syntax, plans, statements)
        return BoundBlockStatement(syntax, statements.ToImmutable())
    }

    private func AppendMultiAssignmentValuesAndWrites(
        syntax MultiAssignmentStatementSyntax,
        plans ImmutableArray[MultiAssignmentTargetPlan].Builder,
        statements ImmutableArray[BoundStatement].Builder
    ) {
        let valueTemps = [plans.Count]LocalVariableSymbol?
        for var i = 0; i < plans.Count; i++ {
            let assignedValue BoundExpression? = plans[i].AssignedValue
            if assignedValue == nil {
                continue
            }
            if assignedValue.Type == TypeSymbol.Error {
                statements.Add(BoundExpressionStatement(syntax, assignedValue))
                continue
            }
            let valueTemp = DeclareMultiAssignmentTemp("value$i", assignedValue.Type)
            valueTemps[i] = valueTemp
            statements.Add(BoundVariableDeclaration(syntax, valueTemp, assignedValue))
        }
        for var i = 0; i < plans.Count; i++ {
            if valueTemps[i] is not{} valueTemp {
                continue
            }
            let value = BoundVariableExpression(nil, valueTemp)
            if plans[i].Declaration is {} declaration {
                let variable = bindLocalVariable(
                    declaration.Identifier,
                    declaration.Keyword.Kind == SyntaxKind.LetKeyword,
                    valueTemp.Type
                )
                statements.Add(BoundVariableDeclaration(declaration, variable, value))
                continue
            }
            if plans[i].CreateWrite is {} createWrite {
                statements.Add(BoundExpressionStatement(syntax, createWrite(value)))
            }
        }
    }

    private func BindMultiAssignmentTarget(
        target ExpressionSyntax,
        value ExpressionSyntax,
        equalsToken SyntaxToken,
        captures ImmutableArray[BoundStatement].Builder
    ) MultiAssignmentTargetPlan {
        if !AssignmentTargetSyntaxFacts.TryCreateAssignment(target, equalsToken, value, out var assignmentSyntax) {
            Diagnostics.ReportInvalidMultiAssignmentTarget(target.Location)
            return MultiAssignmentTargetPlan(bindExpression(value, false), createWrite: nil)
        }
        let diagnosticCount = Diagnostics.Count
        let bound = bindExpression(assignmentSyntax, false)
        if TryCreateMultiAssignmentTargetPlan(bound, target, captures, out var plan) {
            return plan
        }
        if Diagnostics.Count == diagnosticCount {
            Diagnostics.ReportInvalidMultiAssignmentTarget(target.Location)
        }
        return MultiAssignmentTargetPlan(bound, createWrite: nil)
    }

    private func TryCreateMultiAssignmentTargetPlan(
        bound BoundExpression,
        targetSyntax ExpressionSyntax,
        captures ImmutableArray[BoundStatement].Builder,
        out plan MultiAssignmentTargetPlan
    ) bool {
        var bound = bound
        while bound is BoundBlockExpression block {
            captures.AddRange(block.Statements)
            bound = block.Expression
        }
        switch bound {
            case assignment is BoundAssignmentExpression {
                plan = MultiAssignmentTargetPlan(
                    assignment.Expression,
                    func (value BoundExpression) BoundExpression {
                        return BoundAssignmentExpression(
                            assignment.Syntax,
                            assignment.Variable,
                            value,
                            assignment.AssignedValueType
                        )
                    }
                )
                return true
            }
            case field is BoundFieldAssignmentExpression {
                let fieldReceiver = field.ReceiverExpression ??
                    (
                    if field.Receiver == nil {
                        default(BoundVariableExpression?)
                    } else {
                        BoundVariableExpression(nil, field.Receiver)
                    }
                )
                var fieldAccess BoundFieldAccessExpression
                if field.InterfaceType != nil {
                    fieldAccess = BoundFieldAccessExpression(targetSyntax, field.Field, field.InterfaceType)
                } else {
                    fieldAccess = BoundFieldAccessExpression(
                        targetSyntax,
                        fieldReceiver,
                        field.StructType,
                        field.Field,
                        field.ResultType
                    )
                }
                plan = CreateAddressedMultiAssignmentTarget(field.Value, fieldAccess, targetSyntax, captures)
                return true
            }
            case property is BoundPropertyAssignmentExpression {
                let propertyReceiver = if property.Receiver == nil {
                    default(BoundExpression?)
                } else {
                    CaptureMultiAssignmentReceiver(property.Receiver, targetSyntax, captures)
                }
                plan = MultiAssignmentTargetPlan(
                    property.Value,
                    func (value BoundExpression) BoundExpression {
                        return BoundPropertyAssignmentExpression(
                            property.Syntax,
                            propertyReceiver,
                            property.StructType,
                            property.Property,
                            value,
                            property.SubstitutedType,
                            property.InterfaceType
                        )
                    }
                )
                return true
            }
            case clrProperty is BoundClrPropertyAssignmentExpression {
                let clrPropertyReceiver = if clrProperty.Receiver == nil {
                    default(BoundExpression?)
                } else {
                    CaptureMultiAssignmentReceiver(clrProperty.Receiver, targetSyntax, captures)
                }
                plan = MultiAssignmentTargetPlan(
                    clrProperty.Value,
                    func (value BoundExpression) BoundExpression {
                        return BoundClrPropertyAssignmentExpression(
                            clrProperty.Syntax,
                            clrPropertyReceiver,
                            clrProperty.Member,
                            value,
                            clrProperty.Type,
                            clrProperty.StaticContainerType,
                            clrProperty.ConstrainedReceiverTypeParameter,
                            clrProperty.ConstrainedInterfaceType
                        )
                    }
                )
                return true
            }
            case index is BoundIndexAssignmentExpression {
                let indexTarget = index.TargetExpression ??
                    BoundVariableExpression(
                    nil,
                    Invariant.Required(index.Target, "an index assignment has a target", expression: "index.Target")
                )
                if indexTarget.Type is MapTypeSymbol {
                    let capturedTarget = CaptureMultiAssignmentValue(indexTarget, targetSyntax, captures)
                    let capturedIndex = CaptureMultiAssignmentValue(index.Index, targetSyntax, captures)
                    plan = MultiAssignmentTargetPlan(
                        index.Value,
                        func (value BoundExpression) BoundExpression {
                            return BoundIndexAssignmentExpression.WithExpressionTarget(
                                index.Syntax,
                                capturedTarget,
                                capturedIndex,
                                value,
                                index.Type
                            )
                        }
                    )
                    return true
                }
                let element = BoundIndexExpression(targetSyntax, indexTarget, index.Indices, index.Type)
                plan = CreateAddressedMultiAssignmentTarget(index.Value, element, targetSyntax, captures)
                return true
            }
            case clrIndex is BoundClrIndexAssignmentExpression {
                let clrIndexTarget = clrIndex.TargetExpression ??
                    BoundVariableExpression(
                    nil,
                    Invariant.Required(
                        clrIndex.Target,
                        "a CLR index assignment has a target",
                        expression: "clrIndex.Target"
                    )
                )
                let capturedClrTarget = CaptureMultiAssignmentReceiver(clrIndexTarget, targetSyntax, captures)
                let capturedArguments = ImmutableArray.CreateBuilder[BoundExpression](clrIndex.Arguments.Length)
                for argument in clrIndex.Arguments {
                    capturedArguments.Add(CaptureMultiAssignmentValue(argument, targetSyntax, captures))
                }
                plan = MultiAssignmentTargetPlan(
                    clrIndex.Value,
                    func (value BoundExpression) BoundExpression {
                        return BoundClrIndexAssignmentExpression.WithExpressionTarget(
                            clrIndex.Syntax,
                            capturedClrTarget,
                            clrIndex.Indexer,
                            capturedArguments.ToImmutable(),
                            value,
                            clrIndex.Type,
                            clrIndex.ConstrainedReceiverTypeParameter,
                            clrIndex.ConstrainedInterfaceType
                        )
                    }
                )
                return true
            }
            case indirect is BoundIndirectAssignmentExpression {
                let dereference = BoundDereferenceExpression(targetSyntax, indirect.Pointer)
                plan = CreateAddressedMultiAssignmentTarget(indirect.Value, dereference, targetSyntax, captures)
                return true
            }
            default {
                plan = MultiAssignmentTargetPlan(bound, createWrite: nil)
                return false
            }
        }
    }

    private func CreateAddressedMultiAssignmentTarget(
        assignedValue BoundExpression,
        storage BoundExpression,
        targetSyntax ExpressionSyntax,
        captures ImmutableArray[BoundStatement].Builder
    ) MultiAssignmentTargetPlan {
        let address = CaptureMultiAssignmentAddress(storage, targetSyntax, captures)
        return MultiAssignmentTargetPlan(
            assignedValue,
            func (value BoundExpression) BoundExpression {
                return BoundIndirectAssignmentExpression(targetSyntax, BoundVariableExpression(nil, address), value)
            }
        )
    }

    private func CaptureMultiAssignmentAddress(
        storage BoundExpression,
        targetSyntax ExpressionSyntax,
        captures ImmutableArray[BoundStatement].Builder
    ) LocalVariableSymbol {
        var storage = storage
        while storage is BoundBlockExpression block {
            captures.AddRange(block.Statements)
            storage = block.Expression
        }
        storage = PrepareMultiAssignmentStorage(storage, targetSyntax, captures)
        let address = DeclareMultiAssignmentTemp("target", ByRefTypeSymbol.Get(storage.Type))
        captures.Add(BoundVariableDeclaration(targetSyntax, address, BoundAddressOfExpression(targetSyntax, storage)))
        return address
    }

    private func PrepareMultiAssignmentStorage(
        storage BoundExpression,
        targetSyntax ExpressionSyntax,
        captures ImmutableArray[BoundStatement].Builder
    ) BoundExpression {
        var storage = storage
        while storage is BoundBlockExpression block {
            captures.AddRange(block.Statements)
            storage = block.Expression
        }
        switch storage {
            case field is BoundFieldAccessExpression when field.Receiver != nil {
                let receiver = PrepareMultiAssignmentStorageReceiver(field.Receiver!!, targetSyntax, captures)
                return if field.InterfaceType != nil {
                    field
                } else {
                    BoundFieldAccessExpression(
                        field.Syntax,
                        receiver,
                        field.StructType,
                        field.Field,
                        field.SubstitutedType,
                        field.NarrowedType
                    )
                }
            }
            case index is BoundIndexExpression {
                let capturedIndexTarget = CaptureMultiAssignmentValue(index.Target, targetSyntax, captures)
                let capturedIndices = ImmutableArray.CreateBuilder[BoundExpression](index.Indices.Length)
                for indexExpression in index.Indices {
                    capturedIndices.Add(CaptureMultiAssignmentValue(indexExpression, targetSyntax, captures))
                }
                return BoundIndexExpression(
                    index.Syntax,
                    capturedIndexTarget,
                    capturedIndices.MoveToImmutable(),
                    index.Type
                )
            }
            case dereference is BoundDereferenceExpression {
                return BoundDereferenceExpression(
                    dereference.Syntax,
                    CaptureMultiAssignmentValue(dereference.Operand, targetSyntax, captures)
                )
            }
            default {
                return storage
            }
        }
    }

    private func PrepareMultiAssignmentStorageReceiver(
        receiver BoundExpression,
        targetSyntax ExpressionSyntax,
        captures ImmutableArray[BoundStatement].Builder
    ) BoundExpression {
        let receiverType = if receiver.Type is NullableTypeSymbol nullable {
            nullable.UnderlyingType
        } else {
            receiver.Type
        }
        if Binder.IsReferenceTypeForConstraint(receiverType) {
            return CaptureMultiAssignmentValue(receiver, targetSyntax, captures)
        }
        return if isLvalue(receiver) {
            PrepareMultiAssignmentStorage(receiver, targetSyntax, captures)
        } else {
            CaptureMultiAssignmentValue(receiver, targetSyntax, captures)
        }
    }

    private func CaptureMultiAssignmentReceiver(
        receiver BoundExpression,
        targetSyntax ExpressionSyntax,
        captures ImmutableArray[BoundStatement].Builder
    ) BoundExpression {
        var receiver = receiver
        while receiver is BoundBlockExpression block {
            captures.AddRange(block.Statements)
            receiver = block.Expression
        }
        // The constructor receiver is stable across the RHS. Keep its identity:
        // readonly backing-field stores must use this, not a captured alias.
        if getCurrentFunction() is {Name: ".ctor", ThisParameter: {} thisParameter} &&
            receiver is BoundVariableExpression variableReceiver &&
            object.ReferenceEquals(variableReceiver.Variable, thisParameter) {
            return receiver
        }
        let receiverType = if receiver.Type is NullableTypeSymbol nullable {
            nullable.UnderlyingType
        } else {
            receiver.Type
        }
        if Binder.IsReferenceTypeForConstraint(receiverType) {
            return CaptureMultiAssignmentValue(receiver, targetSyntax, captures)
        }
        if !isLvalue(receiver) {
            return CaptureMultiAssignmentValue(receiver, targetSyntax, captures)
        }
        let address = CaptureMultiAssignmentAddress(receiver, targetSyntax, captures)
        return BoundDereferenceExpression(targetSyntax, BoundVariableExpression(nil, address))
    }

    private func CaptureMultiAssignmentValue(
        value BoundExpression,
        targetSyntax ExpressionSyntax,
        captures ImmutableArray[BoundStatement].Builder
    ) BoundExpression {
        let temp = DeclareMultiAssignmentTemp("component", value.Type)
        captures.Add(BoundVariableDeclaration(targetSyntax, temp, value))
        return BoundVariableExpression(nil, temp)
    }

    private func DeclareMultiAssignmentTemp(role string, type TypeSymbol) LocalVariableSymbol {
        let id = Interlocked.Increment(&binderCtx.SyntheticLocalCounter)
        let temp = LocalVariableSymbol("<>multi_${role}_$id", isReadOnly: true, type)
        if !$scope.TryDeclareVariable(temp) {
            throw InvalidOperationException("Failed to declare synthesized multi-assignment local '${temp.Name}'.")
        }
        return temp
    }

    private class MultiAssignmentTargetPlan {
        init(
            assignedValue BoundExpression?,
            createWrite((BoundExpression) -> BoundExpression)?,
            declaration MultiAssignmentDeclarationExpressionSyntax? = nil
        ) {
            AssignedValue = assignedValue
            CreateWrite = createWrite
            Declaration = declaration
        }

        prop AssignedValue BoundExpression? {
            get;
        }

        prop CreateWrite((BoundExpression) -> BoundExpression)? {
            get;
        }

        prop Declaration MultiAssignmentDeclarationExpressionSyntax? {
            get;
        }

        func WithAssignedValue(assignedValue BoundExpression) MultiAssignmentTargetPlan -> MultiAssignmentTargetPlan(
            assignedValue,
            CreateWrite,
            Declaration
        )
    }

    private class MultiAssignmentTupleElementRewriter : BoundTreeRewriter {
        private let source VariableSymbol
        private let replacement BoundExpression

        init(source VariableSymbol, replacement BoundExpression) {
            this.source = source
            this.replacement = replacement
        }

        func Replace(expression BoundExpression) BoundExpression -> RewriteExpression(expression)

        protected override func RewriteVariableExpression(
            node BoundVariableExpression
        ) BoundExpression -> if object.ReferenceEquals(node.Variable, source) {
            replacement
        } else {
            base.RewriteVariableExpression(node)
        }
    }

    shared {
        /// ADR-0071 / issue #708: build a left-folded `&&` chain of
        /// `variable != nil` tests for the given bindings. With a single
        /// binding this is just `variable != nil`.
        private func BuildNilCheckChain(
            syntax SyntaxNode,
            bindings List[(Variable VariableSymbol, Underlying TypeSymbol)]
        ) BoundExpression? -> IfLetBindingSupport
            .BuildNilCheckChain(
            syntax,
            bindings.Select((b(Variable VariableSymbol, Underlying TypeSymbol)) -> b.Variable)
        )

        private func MergeNarrowingFrames(
            a Dictionary[AccessPath, TypeSymbol]?,
            b Dictionary[AccessPath, TypeSymbol]?
        ) Dictionary[AccessPath, TypeSymbol]? {
            if a == nil || a.Count == 0 {
                return if (b == nil || b.Count == 0) {
                    default(Dictionary[AccessPath, TypeSymbol]?)
                } else {
                    b
                }
            }
            if b == nil || b.Count == 0 {
                return a
            }
            let merged = Dictionary[AccessPath, TypeSymbol](a)
            for kv in b {
                // Later (more specific) wins on conflict. The type-test path passes
                // its frame as `b`, so a type-test narrowing supersedes a coincident
                // nil-guard narrowing on the same variable.
                merged[kv.Key] = kv.Value
            }
            return merged
        }

        /// ADR-0069 addendum / issue #712: intersect two narrowing frames. Only
        /// variables present in both frames AND narrowed to the same type
        /// survive. Used by the `||` then-frame classifier where a
        /// narrowing is only sound if both operands prove the same fact.
        private func IntersectNarrowingFrames(
            a Dictionary[AccessPath, TypeSymbol]?,
            b Dictionary[AccessPath, TypeSymbol]?
        ) Dictionary[AccessPath, TypeSymbol]? {
            if a == nil || a.Count == 0 || b == nil || b.Count == 0 {
                return nil
            }
            var result Dictionary[AccessPath, TypeSymbol]? = nil
            for kv in a {
                if b.TryGetValue(kv.Key, out var other) && other == kv.Value {
                    result ??= Dictionary[AccessPath, TypeSymbol]()
                    result!![kv.Key] = kv.Value
                }
            }
            return result
        }

        private func IsNarrowableVariable(expr BoundExpression, out variable VariableSymbol?) bool {
            variable = nil
            if expr is not BoundVariableExpression bve {
                return false
            }
            // ADR-0069 narrows locals and parameters only — never fields,
            // properties, or implicit-field/property reads. Those receivers
            // can be mutated by aliasing or another thread between the test
            // and the use, so narrowing would be unsound.
            if (bve.Variable is LocalVariableSymbol or ParameterSymbol) {
                variable = bve.Variable
                return true
            }
            return false
        }

        /// ADR-0069 addendum / issue #712: stability rule for switch-pattern
        /// narrowing. We narrow non-mutable receivers — locals, parameters,
        /// and read-only globals (`let`). Mutable globals are excluded
        /// because they can be reassigned between the test and the use under
        /// aliasing or another thread.
        private func IsStableNarrowableVariable(variable VariableSymbol) bool {
            return switch variable {
                case _ is LocalVariableSymbol: true
                case g is GlobalVariableSymbol: g.IsReadOnly
                default: false
            }
        }

        private func StripNullable(type TypeSymbol) TypeSymbol {
            return if type is NullableTypeSymbol nullable {
                nullable.UnderlyingType
            } else {
                type
            }
        }

        private func IsStrictlyNarrower(declared TypeSymbol, candidate TypeSymbol) bool {
            // Shared with the short-circuit (`x is T && …`) classifier in
            // ExpressionBinder so `if`-statement and `&&` narrowing agree. Handles
            // the subtype lattice (issue #1636) and the type-parameter/interface
            // operand tested against an interface (issue #2165).
            return SmartCastStability.IsTypeTestNarrowing(declared, candidate)
        }

        private func ClassifyImportedBoolCallNarrowing(call BoundImportedCallExpression, negate bool)(
            Then Dictionary[AccessPath, TypeSymbol]?,
            Else Dictionary[AccessPath, TypeSymbol]?
        ) {
            let parameters = call.Function.Method.GetParameters()
            var result = ClassifyImportedMethodBoolCallNarrowing(parameters, call.Arguments, negate)
            // Issue #4216: preserve established unannotated IsNullOrEmpty
            // extensions while preferring explicit CLR nullability contracts.
            if MemberLookup.HasExtensionAttribute(call.Function.Method) &&
                !HasClrNullabilityContract(parameters.FirstOrDefault()) &&
                IsNullOrEmptyCompatibilityCandidate(call.Function.Name, parameters, call.Arguments) {
                result = MergeNotNullWhenFalseReceiver(result, call.Arguments[0], negate)
            }
            return result
        }

        private func ClassifyImportedMethodBoolCallNarrowing(
            parameters[]ParameterInfo,
            arguments ImmutableArray[BoundExpression],
            negate bool
        )(Then Dictionary[AccessPath, TypeSymbol]?, Else Dictionary[AccessPath, TypeSymbol]?) {
            var thenFrame Dictionary[AccessPath, TypeSymbol]? = nil
            var elseFrame Dictionary[AccessPath, TypeSymbol]? = nil
            let count = Math.Min(parameters.Length, arguments.Length)
            for var i = 0; i < count; i++ {
                let parameter = parameters[i]
                // [MaybeNullWhen(rv)] on a non-nullable argument widens the caller's
                // variable to its nullable counterpart on the arm where the call returns
                // rv. The argument may be a plain variable or an address-of expression
                // (&var) when the CLR parameter is declared `out T`.
                if ClrNullability.TryGetMaybeNullWhen(parameter, out var maybeNullWhenReturnValue) {
                    let rawArg = arguments[i]
                    let widenArg = if rawArg is BoundAddressOfExpression addrOf {
                        addrOf.Operand
                    } else {
                        rawArg
                    }
                    if widenArg is BoundVariableExpression widenVarExpr &&
                        !(widenVarExpr.Variable.Type is NullableTypeSymbol) &&
                        widenVarExpr
                        .Variable
                        .Type != TypeSymbol
                        .Null {
                        let widenThen = maybeNullWhenReturnValue != negate
                        let widenFrame = if widenThen {
                            (
                                (
                                    if thenFrame == nil {
                                        (thenFrame = Dictionary[AccessPath, TypeSymbol]())
                                    } else {
                                        thenFrame
                                    }
                                )!!
                            )
                        } else {
                            (
                                (
                                    if elseFrame == nil {
                                        (elseFrame = Dictionary[AccessPath, TypeSymbol]())
                                    } else {
                                        elseFrame
                                    }
                                )!!
                            )
                        }
                        widenFrame[widenVarExpr.Variable] = NullableTypeSymbol.Get(widenVarExpr.Variable.Type)
                    }
                    continue
                }
                if !ClrNullability.TryGetNotNullWhen(parameter, out var returnValue) ||
                    !TryGetNullableNarrowingTarget(arguments[i], out var target, out var underlying) {
                    continue
                }
                let narrowThen = returnValue != negate
                let frame = if narrowThen {
                    (
                        (
                            if thenFrame == nil {
                                (thenFrame = Dictionary[AccessPath, TypeSymbol]())
                            } else {
                                thenFrame
                            }
                        )!!
                    )
                } else {
                    (
                        (
                            if elseFrame == nil {
                                (elseFrame = Dictionary[AccessPath, TypeSymbol]())
                            } else {
                                elseFrame
                            }
                        )!!
                    )
                }
                frame[target!!] = underlying!!
            }
            return (thenFrame, elseFrame)
        }

        private func ClassifyUserBoolCallNarrowing(call BoundCallExpression, negate bool)(
            Then Dictionary[AccessPath, TypeSymbol]?,
            Else Dictionary[AccessPath, TypeSymbol]?
        ) {
            // Issue #178 / ADR-0047 §6: a user-declared function may carry the
            // same [NotNullWhen] / [MaybeNullWhen] postconditions C# uses.
            // Recognition is type-identity based via KnownAttributes so renaming
            // or shadowing the source name cannot bypass the narrowing rule.
            let parameters = call.Function.Parameters
            var thenFrame Dictionary[AccessPath, TypeSymbol]? = nil
            var elseFrame Dictionary[AccessPath, TypeSymbol]? = nil
            let count = Math.Min(parameters.Length, call.Arguments.Length)
            for var i = 0; i < count; i++ {
                let parameter = parameters[i]
                let attributes = parameter.Attributes
                if attributes.IsDefaultOrEmpty {
                    continue
                }
                var notNullWhenReturnValue = default(bool?)
                var maybeNullWhenReturnValue = default(bool?)
                for attribute in attributes {
                    if KnownAttributes.TryGetNotNullWhenReturnValue(attribute, out var rv) {
                        notNullWhenReturnValue = rv
                    } else if KnownAttributes.TryGetMaybeNullWhenReturnValue(attribute, out var mrv) {
                        maybeNullWhenReturnValue = mrv
                    }
                }
                let argExpr = call.Arguments[i]
                // [NotNullWhen(rv)]: narrow a nullable argument to its underlying
                // non-nullable type on the arm where the call returns rv.
                if (notNullWhenReturnValue != nil) &&
                    TryGetNullableNarrowingTarget(argExpr, out var target, out var underlying) {
                    let narrowThen = notNullWhenReturnValue != negate
                    let frame = if narrowThen {
                        (
                            (
                                if thenFrame == nil {
                                    (thenFrame = Dictionary[AccessPath, TypeSymbol]())
                                } else {
                                    thenFrame
                                }
                            )!!
                        )
                    } else {
                        (
                            (
                                if elseFrame == nil {
                                    (elseFrame = Dictionary[AccessPath, TypeSymbol]())
                                } else {
                                    elseFrame
                                }
                            )!!
                        )
                    }
                    frame[target!!] = underlying!!
                }
                // [MaybeNullWhen(rv)]: widen a non-nullable argument to its nullable
                // counterpart on the arm where the call returns rv.
                let widenVarExpr BoundVariableExpression? = argExpr as BoundVariableExpression
                if (maybeNullWhenReturnValue != nil) &&
                    widenVarExpr != nil &&
                    !(widenVarExpr.Variable.Type is NullableTypeSymbol) &&
                    widenVarExpr
                    .Variable
                    .Type != TypeSymbol
                    .Null {
                    let widenThen = maybeNullWhenReturnValue != negate
                    let widenFrame = if widenThen {
                        (
                            (
                                if thenFrame == nil {
                                    (thenFrame = Dictionary[AccessPath, TypeSymbol]())
                                } else {
                                    thenFrame
                                }
                            )!!
                        )
                    } else {
                        (
                            (
                                if elseFrame == nil {
                                    (elseFrame = Dictionary[AccessPath, TypeSymbol]())
                                } else {
                                    elseFrame
                                }
                            )!!
                        )
                    }
                    widenFrame[widenVarExpr.Variable] = NullableTypeSymbol.Get(widenVarExpr.Variable.Type)
                }
            }
            var result = (Then: thenFrame, Else: elseFrame)
            // Issue #4216: user extensions use the same compatibility rule as
            // imported extensions; an explicit receiver contract wins.
            if call
                .Function
                .IsExtension &&
                !HasUserNullabilityContract(parameters.FirstOrDefault()) &&
                IsNullOrEmptyCompatibilityCandidate(call.Function.Name, parameters, call.Arguments) {
                result = MergeNotNullWhenFalseReceiver(result, call.Arguments[0], negate)
            }
            return result
        }

        private func IsNullOrEmptyCompatibilityCandidate(
            name string,
            parameters ImmutableArray[ParameterSymbol],
            arguments ImmutableArray[BoundExpression]
        ) bool -> IsNullOrEmptyCompatibilityShape(name, parameters.Length, arguments.Length) &&
            parameters[0].Type is NullableTypeSymbol nullable &&
            IsNullOrEmptyReceiverType(nullable.UnderlyingType)

        private func IsNullOrEmptyCompatibilityCandidate(
            name string,
            parameters[]ParameterInfo,
            arguments ImmutableArray[BoundExpression]
        ) bool -> IsNullOrEmptyCompatibilityShape(name, parameters.Length, arguments.Length) &&
            ClrNullability.GetParameterTypeSymbol(parameters[0]) is NullableTypeSymbol &&
            IsNullOrEmptyReceiverType(parameters[0].ParameterType)

        private func IsNullOrEmptyCompatibilityShape(
            name string,
            parameterCount int32,
            argumentCount int32
        ) bool -> string.Equals(name, "IsNullOrEmpty", StringComparison.Ordinal) &&
            parameterCount == 1 &&
            argumentCount == 1

        // The DECLARED receiver must be a NULLABLE string or sequence. Judging
        // eligibility from the call-site argument would let an unconstrained
        // generic receiver (`func (value T?) IsNullOrEmpty[T]() bool`) inherit the
        // contract at any sequence-typed call site.
        private func IsNullOrEmptyReceiverType(receiverType TypeSymbol) bool -> receiverType == TypeSymbol.String ||
            receiverType is SequenceTypeSymbol ||
            (receiverType.ClrType != nil && IsNullOrEmptyReceiverType(receiverType.ClrType))

        private func IsNullOrEmptyReceiverType(receiverType Type) bool -> !receiverType.IsGenericParameter &&
            (
            ClrTypeUtilities.AreSame(receiverType, typeof(string)) || ClrLoadContext.Satisfies(
                receiverType,
                typeof(IEnumerable)
            )
        )

        private func HasClrNullabilityContract(parameter ParameterInfo?) bool -> parameter != nil &&
            (ClrNullability.TryGetNotNullWhen(parameter, out _) || ClrNullability.TryGetMaybeNullWhen(parameter, out _))

        private func HasUserNullabilityContract(parameter ParameterSymbol?) bool {
            if parameter == nil || parameter.Attributes.IsDefaultOrEmpty {
                return false
            }
            for attribute in parameter.Attributes {
                if KnownAttributes.TryGetNotNullWhenReturnValue(attribute, out _) ||
                    KnownAttributes.TryGetMaybeNullWhenReturnValue(attribute, out _) {
                    return true
                }
            }
            return false
        }

        private func MergeNotNullWhenFalseReceiver(
            frames(Then Dictionary[AccessPath, TypeSymbol]?, Else Dictionary[AccessPath, TypeSymbol]?),
            receiver BoundExpression,
            negate bool
        )(Then Dictionary[AccessPath, TypeSymbol]?, Else Dictionary[AccessPath, TypeSymbol]?) {
            if !TryGetNullableNarrowingTarget(receiver, out var target, out var underlying) {
                return frames
            }
            var thenFrame Dictionary[AccessPath, TypeSymbol]? = frames.Then
            var elseFrame Dictionary[AccessPath, TypeSymbol]? = frames.Else
            let narrowThen = negate
            let frame = if narrowThen {
                (
                    (
                        if thenFrame == nil {
                            (thenFrame = Dictionary[AccessPath, TypeSymbol]())
                        } else {
                            thenFrame
                        }
                    )!!
                )
            } else {
                (
                    (
                        if elseFrame == nil {
                            (elseFrame = Dictionary[AccessPath, TypeSymbol]())
                        } else {
                            elseFrame
                        }
                    )!!
                )
            }
            frame[target] = underlying
            return (thenFrame, elseFrame)
        }

        private func TryGetNullableNarrowingTarget(
            expression BoundExpression,
            @System.Diagnostics.CodeAnalysis.NotNullWhen(true) out target AccessPath?,
            @System.Diagnostics.CodeAnalysis.NotNullWhen(true) out underlying TypeSymbol?
        ) bool {
            var expression = expression
            while expression is BoundConversionExpression conversion && IsFlowTransparentConversion(conversion) {
                expression = conversion.Expression
            }
            if expression is BoundAddressOfExpression address {
                expression = address.Operand
            }
            if expression.Type is not NullableTypeSymbol nullable {
                target = nil
                underlying = nil
                return false
            }
            target = if expression is BoundVariableExpression bve {
                AccessPath.ForVariable(bve.Variable)
            } else {
                SmartCastStability.TryGetStablePath(expression)
            }
            if target == nil {
                underlying = nil
                return false
            }
            underlying = nullable.UnderlyingType
            return true
        }

        internal func IsFlowTransparentConversion(conversion BoundConversionExpression) bool {
            if object.ReferenceEquals(conversion.Type, conversion.Expression.Type) {
                return true
            }
            if conversion.Type is NullableTypeSymbol widened && widened.UnderlyingType == conversion.Expression.Type {
                return true
            }
            return conversion
                .Type
                ?.ClrType != nil &&
                conversion
                .Expression
                .Type
                ?.ClrType != nil &&
                ClrTypeUtilities.AreSame(conversion.Type.ClrType, conversion.Expression.Type.ClrType)
        }

        internal func IsNilLiteral(expr BoundExpression) bool {
            var expr = expr
            while expr is BoundConversionExpression conversion {
                expr = conversion.Expression
            }
            return expr is BoundLiteralExpression lit && lit.Type == TypeSymbol.Null
        }

        /// [`operandType`](paramref) replaces the bound type of [`discriminant`](paramref) when the narrowing
        /// facts changed after it was bound (ADR-0208 R18).
        internal func TryClassifyPatternNarrowing(
            discriminant BoundExpression,
            pattern BoundPattern?,
            allowReadOnlyGlobals bool = true,
            operandType TypeSymbol? = nil
        ) Dictionary[AccessPath, TypeSymbol]? {
            if pattern == nil {
                return nil
            }
            // ADR-0069 addendum / issue #712: only narrow non-mutable receivers
            // (locals, parameters, and read-only globals). ADR-0069 addendum /
            // issue #1180 extends this to stable immutable member paths
            // (`switch x.shape { case c is Circle: ... }`). Mutable receivers could
            // be reassigned or mutated between the test and the use.
            var discriminantPath AccessPath
            if discriminant is BoundVariableExpression variableExpression &&
                (
                if allowReadOnlyGlobals {
                    IsStableNarrowableVariable(variableExpression.Variable)
                } else {
                    (variableExpression.Variable is LocalVariableSymbol or ParameterSymbol)
                }
            ) {
                discriminantPath = variableExpression.Variable
            } else {
                var memberPath AccessPath?
                if !SmartCastStability.TryGetStableMemberPath(discriminant, out memberPath, out _) {
                    return nil
                }
                discriminantPath = Invariant.Required(
                    memberPath,
                    "a successful stable-member lookup identifies its path",
                    expression: "memberPath"
                )
            }
            let discriminantType = operandType ?? discriminant.Type
            var narrowedType TypeSymbol? = nil
            switch pattern {
                case typePattern is BoundTypePattern {
                    let targetType = StripNullable(typePattern.TargetType)
                    if SmartCastStability.IsTypeTestNarrowing(discriminantType, targetType) {
                        narrowedType = targetType
                    }
                }
                case constantPattern is BoundConstantPattern when discriminantType is NullableTypeSymbol nullable &&
                    !IsNilLiteral(constantPattern.Value) {
                    narrowedType = nullable.UnderlyingType
                }
                case BoundDiscardPattern { }
                case binaryPattern is BoundBinaryPattern when binaryPattern.IsConjunction {
                    // Issue #992: `and` — both sub-patterns hold, so the union of
                    // their narrowings is sound.
                    {
                        let left = TryClassifyPatternNarrowing(
                            discriminant,
                            binaryPattern.Left,
                            allowReadOnlyGlobals,
                            operandType
                        )
                        let right = TryClassifyPatternNarrowing(
                            discriminant,
                            binaryPattern.Right,
                            allowReadOnlyGlobals,
                            operandType
                        )
                        return MergeNarrowingFrames(left, right)
                    }
                }
                case binaryPattern is BoundBinaryPattern {
                    // Issue #992: `or` — only narrowings proven by BOTH branches
                    // (same variable, same type) survive. This keeps the smart-cast
                    // sound: `x is Cat or x is Dog` narrows nothing.
                    {
                        let left = TryClassifyPatternNarrowing(
                            discriminant,
                            binaryPattern.Left,
                            allowReadOnlyGlobals,
                            operandType
                        )
                        let right = TryClassifyPatternNarrowing(
                            discriminant,
                            binaryPattern.Right,
                            allowReadOnlyGlobals,
                            operandType
                        )
                        return IntersectNarrowingFrames(left, right)
                    }
                }
                case BoundNotPattern { }
                // ADR-0208 R18 (#5534): a property pattern does not match nil. It restores only a fact that the
                // condition's own effects removed; `operandType` is then a nullable reference or platform type.
                case BoundPropertyPattern when operandType is NullableTypeSymbol restoredNullable {
                    narrowedType = restoredNullable.UnderlyingType
                }
                case BoundPropertyPattern when operandType is PlatformTypeSymbol restoredPlatform {
                    narrowedType = restoredPlatform.UnderlyingType
                }
                case BoundRelationalPattern, BoundPropertyPattern, BoundListPattern { }
            }
            return if narrowedType == nil {
                default(Dictionary[AccessPath, TypeSymbol]?)
            } else {
                Dictionary[AccessPath, TypeSymbol]{[discriminantPath] = narrowedType}
            }
        }

        private func IsDiscardTarget(target ExpressionSyntax) bool -> switch target {
            case name is NameExpressionSyntax: IsDiscard(name.IdentifierToken)
            case declaration is MultiAssignmentDeclarationExpressionSyntax: IsDiscard(declaration.Identifier)
            default: false
        }
    }
}
