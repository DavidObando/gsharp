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
    /// else-branches. Shared by the `if` statement, `if`-expression, conditional
    /// expression, and `if let` guard (issue #4961 / ADR-0201, #5545).
    /// [`removedFacts`](paramref) are the facts that the condition's own effects
    /// removed (ADR-0208 R18), so a type test of such a path is classified against
    /// the type the path has now.
    private func ClassifyIfConditionNarrowing(
        condition BoundExpression,
        removedFacts Dictionary[AccessPath, TypeSymbol]? = nil,
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil,
        allowBoolCall bool = true,
        header SyntaxNode? = nil
    )(Then Dictionary[AccessPath, TypeSymbol]?, Else Dictionary[AccessPath, TypeSymbol]?) {
        let aliases = HashSet[VariableSymbol](callableAliases ?? externalCallableAliases)
        let (thenNarrow, elseNarrow, _, _) = ComputeConditionNarrowingInOrder(
            condition,
            aliases,
            removedFacts,
            forShortCircuitOperand: false,
            allowBoolCall: allowBoolCall,
            keepBoolCallInLogicalOps: allowBoolCall,
            shortCircuitInComposedOps: !allowBoolCall,
            header: header
        )
        return (thenNarrow, elseNarrow)
    }

    private func BindIfStatement(syntax IfStatementSyntax) BoundStatement {
        if syntax.Initializer == nil {
            let (condition, thenNarrow, elseNarrow) = BindConditionWithEffects(syntax.Condition)
            let removedFacts = conditionRemovedFacts
            conditionRemovedFacts = nil
            let callableWhenTrue = lastConditionWhenTrueAliases ?? CaptureExternalCallableAliases()
            let callableWhenFalse = lastConditionWhenFalseAliases ?? CaptureExternalCallableAliases()
            lastConditionWhenTrueAliases = nil
            lastConditionWhenFalseAliases = nil
            // ADR-0166: pattern variables are in scope in the branch their
            // match dominates: when-true in the then-branch, when-false in the
            // else-branch (`if !(x is T t) { ... } else { use(t) }`).
            let (patternThen, patternElse) = PatternVariables.Classify(condition)
            let shadowFlow = ShadowBegin(condition)
            let joinEntry = binderCtx.Narrowing
            let joinExits = List[NarrowingState]()
            let outerConditionKills = if syntax.ElseClause == nil {
                conditionKillJournal
            } else {
                BeginThenBranchConditionKills()
            }
            RestoreExternalCallableAliases(callableWhenTrue)
            let thenStatement = BindWithPatternVariables(
                patternThen,
                () -> {
                    return BindStatementWithNarrowing(syntax.ThenStatement, thenNarrow)
                },
                syntax.ThenStatement
            )
            let restoredConditionKills = if syntax.ElseClause == nil {
                default(List[(Frame NarrowingFrame, Path AccessPath, Type TypeSymbol)]?)
            } else {
                RestoreThenBranchConditionKills(outerConditionKills, joinEntry)
            }
            AddBranchExits(joinExits, thenStatement)
            ShadowAddBranch(shadowFlow, thenNarrow, thenStatement)
            let callableThenExit = CaptureExternalCallableAliases()
            RestoreExternalCallableAliases(callableWhenFalse)
            ShadowBeginBranch(shadowFlow)
            let elseStatement = if syntax.ElseClause == nil {
                default(BoundStatement?)
            } else {
                BindWithPatternVariables(
                    patternElse,
                    () -> {
                        return BindStatementWithNarrowing(syntax.ElseClause!!.ElseStatement, elseNarrow)
                    },
                    syntax.ElseClause.ElseStatement
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
                callableWhenFalse
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
                if removedFacts != nil && removedFacts.Count > 0 {
                    earlyExitRemovedFacts[result] = Dictionary[AccessPath, TypeSymbol](removedFacts)
                }
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
            ApplyInitializerEffectsToNarrowings(syntax.Initializer!!, initStatement, initializerAliasesAtEntry)
            UpdateExternalCallableAliases(initStatement, initializerAliasesAtEntry)
        }
        let (initCondition, initThenNarrow, initElseNarrow) = BindConditionWithEffects(syntax.Condition)
        let initRemovedFacts = conditionRemovedFacts
        conditionRemovedFacts = nil
        let initCallableWhenTrue = lastConditionWhenTrueAliases ?? CaptureExternalCallableAliases()
        let initCallableWhenFalse = lastConditionWhenFalseAliases ?? CaptureExternalCallableAliases()
        lastConditionWhenTrueAliases = nil
        lastConditionWhenFalseAliases = nil
        let (initPatternThen, initPatternElse) = PatternVariables.Classify(initCondition)
        let initShadowFlow = ShadowBegin(initCondition, initStatement)
        let initJoinEntry = binderCtx.Narrowing
        let initJoinExits = List[NarrowingState]()
        let initOuterConditionKills = if syntax.ElseClause == nil {
            conditionKillJournal
        } else {
            BeginThenBranchConditionKills()
        }
        RestoreExternalCallableAliases(initCallableWhenTrue)
        let initThen = BindWithPatternVariables(
            initPatternThen,
            () -> {
                return BindStatementWithNarrowing(syntax.ThenStatement, initThenNarrow)
            },
            syntax.ThenStatement
        )
        let initRestoredConditionKills = if syntax.ElseClause == nil {
            default(List[(Frame NarrowingFrame, Path AccessPath, Type TypeSymbol)]?)
        } else {
            RestoreThenBranchConditionKills(initOuterConditionKills, initJoinEntry)
        }
        AddBranchExits(initJoinExits, initThen)
        ShadowAddBranch(initShadowFlow, initThenNarrow, initThen)
        let initCallableThenExit = CaptureExternalCallableAliases()
        RestoreExternalCallableAliases(initCallableWhenFalse)
        ShadowBeginBranch(initShadowFlow)
        let initElse = if syntax.ElseClause == nil {
            default(BoundStatement?)
        } else {
            BindWithPatternVariables(
                initPatternElse,
                () -> {
                    return BindStatementWithNarrowing(syntax.ElseClause!!.ElseStatement, initElseNarrow)
                },
                syntax.ElseClause.ElseStatement
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
            initCallableWhenFalse
        } else {
            CaptureExternalCallableAliases()
        }
        RestoreJoinedExternalCallableAliases(initCallableThenExit, initCallableElseExit)
        $scope = $scope.Pop()
        let inner = BoundIfStatement(syntax, initCondition, initThen, initElse)
        if initElseNarrow != nil && initElseNarrow.Count > 0 {
            binderCtx.PendingEarlyExitFrames[inner] = initElseNarrow
            if initRemovedFacts != nil && initRemovedFacts.Count > 0 {
                earlyExitRemovedFacts[inner] = Dictionary[AccessPath, TypeSymbol](initRemovedFacts)
            }
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
    /// ADR-0071 / issue #708, issue #4961 / ADR-0201, #5545: binds the header (bindings and optional guard) and
    /// branches of an `if let` statement or expression. Each initializer and the guard apply their narrowing and
    /// callable-alias effects before the next binding, guard and branches are bound.
    internal func BindIfLetBranches[TBranch](
        bindings SeparatedSyntaxList[IfLetBindingClauseSyntax],
        guardSyntax ExpressionSyntax?,
        hasElse bool,
        allowGuardBoolCall bool,
        thenSyntax SyntaxNode?,
        bindThen() -> TBranch,
        bindElse() -> TBranch
    )(
        Clauses ImmutableArray[IfLetBindingSupport.BoundIfLetClause],
        Guard BoundExpression?,
        Then TBranch,
        Else TBranch
    ) {
        let callableEntry = CaptureExternalCallableAliases()
        var callableThenExit = callableEntry
        var callableWhenFalse HashSet[VariableSymbol]? = nil
        var clauseEntryAliases = callableEntry
        // The else-branch starts from the state before the header: the guard's facts hold only in the then-branch.
        let elseEntry = binderCtx.Narrowing
        var outerConditionKills = conditionKillJournal
        var thenKillsStarted = false
        let header = List[(Syntax SyntaxNode, Bound BoundExpression)]()
        let aliasesBeforeHeader = callableEntry
        var guardThenFrame Dictionary[AccessPath, TypeSymbol]? = nil
        let (clauses, guard_, thenBranch) = IfLetBindingSupport.BindHeader(
            binderCtx,
            bindings,
            guardSyntax,
            Diagnostics,
            conversions,
            bindTypeClause,
            (initializer ExpressionSyntax) -> {
                clauseEntryAliases = CaptureExternalCallableAliases()
                let bound = bindExpression(initializer, false)
                RestoreExternalCallableAliases(clauseEntryAliases)
                return bound
            },
            (identifier SyntaxToken, isReadOnly bool, type TypeSymbol) -> bindLocalVariable(
                identifier,
                isReadOnly,
                type
            ),
            (guardExprSyntax ExpressionSyntax) -> {
                let (bound, guardThen, _) = BindConditionWithEffects(guardExprSyntax, allowGuardBoolCall)
                let guardWhenTrue = lastConditionWhenTrueAliases ?? CaptureExternalCallableAliases()
                let guardWhenFalse = lastConditionWhenFalseAliases ?? CaptureExternalCallableAliases()
                lastConditionWhenTrueAliases = nil
                lastConditionWhenFalseAliases = nil
                RestoreExternalCallableAliases(guardWhenTrue)
                callableWhenFalse = if callableWhenFalse == nil {
                    guardWhenFalse
                } else {
                    JoinAliases(callableWhenFalse, guardWhenFalse)
                }
                guardThenFrame = guardThen
                header.Add((guardExprSyntax, bound))
                return bound
            },
            (_ BoundExpression) -> {
                let frame = guardThenFrame
                guardThenFrame = nil
                return frame
            },
            () -> {
                if hasElse {
                    outerConditionKills = BeginThenBranchConditionKills()
                    thenKillsStarted = true
                }
                let then = bindThen()
                callableThenExit = CaptureExternalCallableAliases()
                RestoreExternalCallableAliases(callableWhenFalse ?? callableEntry)
                return then
            },
            thenSyntax,
            (clauseSyntax IfLetBindingClauseSyntax, bound IfLetBindingSupport.BoundIfLetBinding) -> {
                RestoreExternalCallableAliases(clauseEntryAliases)
                ApplyTrailingConditionEffects(clauseSyntax.Initializer, bound.Initializer)
                RestoreExternalCallableAliases(clauseEntryAliases)
                EnsureClosureAssignedNames(clauseSyntax)
                let (_, _, initWhenTrue, initWhenFalse) = ComputeConditionNarrowingInOrder(
                    bound.Initializer,
                    clauseEntryAliases,
                    header: clauseSyntax
                )
                RestoreExternalCallableAliases(initWhenTrue)
                callableWhenFalse = if callableWhenFalse == nil {
                    initWhenFalse
                } else {
                    JoinAliases(callableWhenFalse, initWhenFalse)
                }
                header.Add((clauseSyntax.Initializer, bound.Initializer))
            }
        )
        let callableElseEntry = callableWhenFalse ?? callableEntry
        // ADR-0208 R18: as for an `if` statement, the else-branch is bound without the facts that the conditions in
        // the then-branch removed. The header runs on the else path too, so a fact that it can remove stays removed.
        let restoredConditionKills = if thenKillsStarted {
            RestoreThenBranchConditionKills(outerConditionKills, elseEntry, header, aliasesBeforeHeader)
        } else {
            default(List[(Frame NarrowingFrame, Path AccessPath, Type TypeSymbol)]?)
        }
        // Bound AFTER the header scope is popped: the else branch never sees
        // the bindings.
        let elseBranch = bindElse()
        if restoredConditionKills != nil {
            EndThenBranchConditionKills(restoredConditionKills)
        }
        let callableElseExit = if !hasElse {
            callableElseEntry
        } else {
            CaptureExternalCallableAliases()
        }
        RestoreJoinedExternalCallableAliases(callableThenExit, callableElseExit)
        return (clauses, guard_, thenBranch, elseBranch)
    }

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
        let (clauses, guard_, thenStatement, elseStatement) = BindIfLetBranches[BoundStatement?](
            syntax.Bindings,
            syntax.Guard,
            syntax.ElseClause != nil,
            true,
            syntax.ThenStatement,
            () -> BindStatementWithNarrowing(syntax.ThenStatement, nil),
            () -> if syntax.ElseClause == nil {
                default(BoundStatement?)
            } else {
                BindStatement(syntax.ElseClause.ElseStatement)
            }
        )
        let thenStmt = Invariant.Required(
            thenStatement,
            "an if-let then-branch has a bound statement",
            expression: "thenStatement"
        )
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
                LowerIfLetClauses(syntax, clauses, 0, usableGuard, thenStmt, elseStatement)
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
        lowered.Add(thenStmt)
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
    private func BindIfLetBindingClause(binding IfLetBindingClauseSyntax, isFinalBeforeGuard bool = false)(
        Variable VariableSymbol?,
        Underlying TypeSymbol?,
        Declaration BoundStatement
    ) {
        let reportNonNullable = if isFinalBeforeGuard {
            (
                (clause IfLetBindingClauseSyntax, initializer BoundExpression) -> {
                    IfLetBindingSupport.ReportFinalInitializerBeforeGuard(Diagnostics, clause, initializer)
                }
            )
        } else {
            default(((IfLetBindingClauseSyntax, BoundExpression) -> void)?)
        }
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
            },
            reportNonNullable
        )
        if bound.IsValid &&
            isFinalBeforeGuard &&
            binding.Initializer is not ParenthesizedExpressionSyntax &&
            IfLetBindingSupport
            .HasAmbiguousBooleanContinuation(bound.Initializer, binding.Initializer) {
            Diagnostics.ReportIfLetGuardSplitsInitializer(
                binding.Initializer.Location,
                binding.Identifier.ValueText,
                bound.Initializer.Type
            )
        }
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
        let savedScope = $scope
        $scope = BoundScope(savedScope)
        let pseudoFrame = binderCtx.PushNarrowingFrame(Dictionary[AccessPath, TypeSymbol]())
        try {
            let _ = BindGuardLetStatementInBlock(syntax, statements, pseudoFrame)
        } finally {
            binderCtx.EndNarrowingProof()
            $scope = savedScope
        }
        return BoundBlockStatement(syntax, statements.ToImmutable())
    }

    private func BindGuardLetElseBranch(
        elseSyntax StatementSyntax,
        aliasesForElse IReadOnlyCollection[VariableSymbol]
    ) BoundStatement? {
        let savedAliases = CaptureExternalCallableAliases()
        let savedFrames = List[(Frame NarrowingFrame, Entries List[KeyValuePair[AccessPath, TypeSymbol]])](
            binderCtx.NarrowedVariables.Count
        )
        for var f = 0; f < binderCtx.NarrowedVariables.Count; f++ {
            let frame = binderCtx.NarrowedVariables[f]
            savedFrames.Add((frame, List[KeyValuePair[AccessPath, TypeSymbol]](frame)))
        }
        let savedShadowOverlay = binderCtx.ShadowOverlay
        let savedShadowBase = binderCtx.ShadowOverlayBase
        let savedShadowSuppressed = Dictionary[AccessPath, int32](binderCtx.ShadowSuppressed)
        try {
            RestoreExternalCallableAliases(HashSet[VariableSymbol](aliasesForElse))
            return BindStatement(elseSyntax)
        } finally {
            for (frame, entries) in savedFrames {
                frame.Clear()
                for kv in entries {
                    frame[kv.Key] = kv.Value
                }
            }
            binderCtx.ShadowOverlay = savedShadowOverlay
            binderCtx.ShadowOverlayBase = savedShadowBase
            binderCtx.ShadowSuppressed.Clear()
            for kv in savedShadowSuppressed {
                binderCtx.ShadowSuppressed[kv.Key] = kv.Value
            }
            RestoreExternalCallableAliases(savedAliases)
        }
    }

    /// ADR-0071 / issue #708, issue #4968 / ADR-0201: bind `guard let` into the enclosing
    /// statement builder so the synthesized locals, the bindings' narrowings, and any facts
    /// or pattern variables proven by an optional `&& guard` extend the enclosing block.
    private func BindGuardLetStatementInBlock(
        syntax GuardLetStatementSyntax,
        statements ImmutableArray[BoundStatement].Builder,
        persistentFrame NarrowingFrame
    ) Dictionary[AccessPath, TypeSymbol]? {
        // The else block must be re-bound once per binding arm because the
        // ControlFlowGraph builder demands that each BoundStatement appear
        // at most once in the tree (it keys block lookup by statement
        // identity). Re-binding the same syntax repeatedly would otherwise
        // report every diagnostic inside the else block once per arm
        // (issue #1637), so only the first bind's diagnostics are kept;
        // subsequent re-binds are truncated back to that point.
        var hasBoundElseOnce = false
        var allExits = true
        var lastElse BoundStatement? = nil
        var lastElseAliases IReadOnlyCollection[VariableSymbol]? = nil
        let headerBindings = List[(Variable VariableSymbol, Underlying TypeSymbol)]()
        let savedFrameEntries = List[(Path AccessPath, Previous TypeSymbol?, HadPrevious bool)]()
        for var i = 0; i < syntax.Bindings.Count; i++ {
            let binding = syntax.Bindings[i]
            let aliasesAtEntry = externalCallableAliases.ToArray()
            let isFinalBeforeGuard = syntax.Guard != nil && i == syntax.Bindings.Count - 1
            let (variable, underlying, decl) = BindIfLetBindingClause(binding, isFinalBeforeGuard)
            statements.Add(decl)
            // The initializer ran before the else block and the next binding: a getter in it can clear
            // storage that a guarded alias names (ADR-0208 R12).
            InvalidateNarrowingsForAssignedVariables(binding, decl, aliasesAtEntry: aliasesAtEntry)
            UpdateExternalCallableAliases(decl, aliasesAtEntry)
            let aliasesAfterInitializer = externalCallableAliases.ToArray()
            if variable == nil || underlying == nil {
                continue
            }
            // Bind a fresh copy of the else block for this arm so that the
            // ControlFlowGraph builder sees a unique BoundStatement
            // instance per arm.
            let diagMark = Diagnostics.Count
            let armElse = BindGuardLetElseBranch(syntax.ElseStatement, aliasesAfterInitializer)
            if hasBoundElseOnce {
                Diagnostics.TruncateTo(diagMark)
            } else {
                hasBoundElseOnce = true
                if !EndsInUnconditionalExit(armElse) {
                    Diagnostics.ReportGuardLetElseMustExit(syntax.ElseStatement.Location)
                }
            }
            lastElse = armElse
            lastElseAliases = aliasesAfterInitializer
            if !EndsInUnconditionalExit(armElse) {
                allExits = false
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
            // Narrow the binding in persistentFrame immediately so later initializers
            // and an optional `&& guard` observe earlier bindings at their non-null
            // underlying types (ADR-0201 / #4968).
            let path = AccessPath.ForVariable(variable)
            let hadPrevious = persistentFrame.TryGetValue(path, out var previousType)
            savedFrameEntries.Add((path, previousType, hadPrevious))
            persistentFrame[path] = underlying
            headerBindings.Add((variable, underlying))
            statements.Add(ifStmt)
        }
        var guardThenNarrow Dictionary[AccessPath, TypeSymbol]? = nil
        var guardPatternThen = ImmutableArray[LocalVariableSymbol].Empty
        if syntax.Guard != nil {
            let (guardCondition, thenNarrow, _) = BindConditionWithEffects(syntax.Guard)
            conditionRemovedFacts = nil
            let callableWhenTrue = lastConditionWhenTrueAliases ?? CaptureExternalCallableAliases()
            let callableWhenFalse = lastConditionWhenFalseAliases ?? CaptureExternalCallableAliases()
            lastConditionWhenTrueAliases = nil
            lastConditionWhenFalseAliases = nil
            guardThenNarrow = thenNarrow
            guardPatternThen = PatternVariables.Classify(guardCondition).WhenTrue
            let diagMark = Diagnostics.Count
            let guardElse = BindGuardLetElseBranch(syntax.ElseStatement, callableWhenFalse)
            if hasBoundElseOnce {
                Diagnostics.TruncateTo(diagMark)
            } else {
                hasBoundElseOnce = true
                if !EndsInUnconditionalExit(guardElse) {
                    Diagnostics.ReportGuardLetElseMustExit(syntax.ElseStatement.Location)
                }
            }
            RestoreExternalCallableAliases(callableWhenTrue)
            lastElse = guardElse
            lastElseAliases = callableWhenFalse
            if !EndsInUnconditionalExit(guardElse) {
                allExits = false
            }
            let negatedGuard BoundExpression = if guardCondition.Type == TypeSymbol.Bool && BoundUnaryOperator.Bind(
                SyntaxKind.BangToken,
                TypeSymbol.Bool
            ) is {} notOp {
                BoundUnaryExpression(nil, notOp, guardCondition)
            } else {
                guardCondition
            }
            let guardIfStmt = BoundIfStatement(
                syntax,
                negatedGuard,
                Invariant.Required(guardElse, "a guard-let else arm has a bound statement", expression: "guardElse"),
                elseStatement: nil
            )
            statements.Add(guardIfStmt)
        }
        // If every arm's binding clause failed (all `continue`d above) and there was no guard,
        // the else block was never bound and its diagnostics -- including GS0297 -- would
        // silently vanish. Bind it once here, purely for diagnostics.
        if !hasBoundElseOnce {
            let armElse = BindStatement(syntax.ElseStatement)
            if !EndsInUnconditionalExit(armElse) {
                Diagnostics.ReportGuardLetElseMustExit(syntax.ElseStatement.Location)
            }
            allExits = false
        }
        if !allExits {
            for var i = savedFrameEntries.Count - 1; i >= 0; i-- {
                let entry = savedFrameEntries[i]
                if entry.HadPrevious && entry.Previous is {} previousType {
                    persistentFrame[entry.Path] = previousType
                } else {
                    persistentFrame.Remove(entry.Path)
                }
            }
            return nil
        }
        if !guardPatternThen.IsDefaultOrEmpty &&
            !binderCtx.FunctionContainsUserGotoOrLabel &&
            (lastElse == nil || !ContainsUserLabel(lastElse)) {
            let block = syntax.Parent as BlockStatementSyntax
            for variable in guardPatternThen {
                if !$scope.TryDeclareVariable(variable) {
                    if variable.DeclaringSyntax is SyntaxNode declaring {
                        Diagnostics.ReportSymbolAlreadyDeclared(declaring.Location, variable.Name)
                    }
                    continue
                }
                if variable is PatternVariableSymbol patternVariable && block != nil {
                    patternVariable.AddRegion(block, syntax.Span.End, block.Span.End)
                }
            }
        }
        let lifts = Dictionary[AccessPath, TypeSymbol]()
        for (variable, underlying) in headerBindings {
            lifts[AccessPath.ForVariable(variable)] = underlying
        }
        if guardThenNarrow != nil && (lastElse == nil || !ContainsUserLabel(lastElse)) {
            var elseCollector AssignedRootsCollector? = nil
            var elseDropAllMemberPaths = false
            if lastElse != nil {
                EnsureClosureAssignedNames(syntax.ElseStatement)
                let candidateCollector = NewCollector(nil, lastElseAliases ?? externalCallableAliases)
                candidateCollector.Visit(lastElse)
                if !EndsInUnconditionalExit(lastElse, gotoExits: false) || candidateCollector.HasEscapingJump() {
                    elseCollector = candidateCollector
                    elseDropAllMemberPaths = SyntaxMayMutateMemberPaths(syntax.ElseStatement) ||
                        candidateCollector.MayMutateMemberPaths
                }
            }
            for kv in guardThenNarrow {
                if elseCollector != nil &&
                    StatementKillsPath(
                    elseCollector,
                    kv.Key,
                    elseDropAllMemberPaths,
                    elseCollector.MayMutateReferenceStorage
                ) {
                    continue
                }
                SetPersistentNarrowing(persistentFrame, kv.Key, kv.Value)
                lifts[kv.Key] = kv.Value
            }
        }
        return if lifts.Count > 0 {
            lifts
        } else {
            default(Dictionary[AccessPath, TypeSymbol]?)
        }
    }

    /// ADR-0166: binds a statement with the given pattern variables declared in
    /// a fresh child scope (see (cref:PatternVariables.BindInScope{T})).
    private func BindWithPatternVariables(
        variables ImmutableArray[LocalVariableSymbol],
        bind() -> BoundStatement,
        regionSyntax SyntaxNode? = nil
    ) BoundStatement -> PatternVariables.BindInScope(binderCtx, variables, bind, regionSyntax)

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
            if !$scope.TryDeclareVariable(variable) {
                if variable.DeclaringSyntax is SyntaxNode declaring {
                    Diagnostics.ReportSymbolAlreadyDeclared(declaring.Location, variable.Name)
                }
                continue
            }
            if variable is PatternVariableSymbol patternVariable &&
                ifStatement.Syntax is {} ifSyntax &&
                EnclosingBlockSyntax(ifSyntax) is {} block {
                patternVariable.AddRegion(block, ifSyntax.Span.End, block.Span.End)
            }
        }
    }

    private func EnclosingBlockSyntax(node SyntaxNode) SyntaxNode? {
        var current SyntaxNode? = node.Parent
        while current != nil {
            if current is BlockStatementSyntax or BlockExpressionSyntax {
                return current
            }
            if current is GlobalStatementSyntax {
                return node.SyntaxTree.Root
            }
            if current.Parent is CompilationUnitSyntax && current is MemberSyntax {
                return nil
            }
            current = current.Parent
        }
        return nil
    }

    internal func TryClassifyActiveIsExpressionNarrowing(
        isExpr BoundIsExpression,
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil
    )(Then Dictionary[AccessPath, TypeSymbol]?, Else Dictionary[AccessPath, TypeSymbol]?) ->
    TryClassifyTypeTestNarrowing(isExpr, activeConditionRemovedFacts, callableAliases)

    /// ADR-0069 / issue #700: classify an `is` or `!is` leaf test on a
    /// local-variable, parameter, or stable member-path receiver into
    /// per-branch narrowing frames. Boolean negation, conjunction, and
    /// disjunction compose in (cref:ComputeConditionNarrowingInOrder).
    /// @param condition The bound leaf condition expression.
    /// @param removedFacts Optional narrowing facts removed by condition effects.
    /// @param callableAliases Optional callable aliases active at the test.
    /// @returns A pair of narrowing frames — the first applies to the
    /// then-branch, the second to the else-branch. Either may be
    /// `null` if the corresponding branch has no narrowing.
    private func TryClassifyTypeTestNarrowing(
        condition BoundExpression,
        removedFacts Dictionary[AccessPath, TypeSymbol]? = nil,
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil
    )(Then Dictionary[AccessPath, TypeSymbol]?, Else Dictionary[AccessPath, TypeSymbol]?) {
        switch condition {
            case block is BoundBlockExpression {
                {
                    var nextAliases = callableAliases
                    if nextAliases == nil && testAliasesAt is {} aliasesAt && aliasesAt.TryGetValue(
                        block.Expression,
                        out var atExpr
                    ) {
                        nextAliases = atExpr
                    } else if !block.Statements.IsDefaultOrEmpty {
                        nextAliases = AliasesAfterBlockPrefix(
                            block,
                            HashSet[VariableSymbol](callableAliases ?? externalCallableAliases)
                        )
                    }
                    return TryClassifyTypeTestNarrowing(block.Expression, removedFacts, nextAliases)
                }
            }
            case isExpr is BoundIsExpression {
                {
                    if TestMayRemoveItsOperandFact(isExpr, callableAliases) {
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
                    let (inThen, inElse) = TryClassifyTypeTestNarrowing(unary.Operand, removedFacts, callableAliases)
                    return (inElse, inThen)
                }
            }
            case binary is BoundBinaryExpression when binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd {
                {
                    // De Morgan for `&&`: then = thenL ∧ thenR (both true → both narrowings apply).
                    // The else frame is intentionally dropped — either operand could have been
                    // the false one, so we cannot single out a per-variable narrowing.
                    var (leftThen, _) = TryClassifyTypeTestNarrowing(binary.Left, removedFacts, callableAliases)
                    leftThen = FilterLeftConditionNarrowings(binary.Right, leftThen, callableAliases)
                    let (rightThen, _) = TryClassifyTypeTestNarrowing(binary.Right, removedFacts, callableAliases)
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
                    var (leftThen, leftElse) = TryClassifyTypeTestNarrowing(binary.Left, removedFacts, callableAliases)
                    leftElse = FilterLeftConditionNarrowings(binary.Right, leftElse, callableAliases)
                    let (rightThen, rightElse) = TryClassifyTypeTestNarrowing(
                        binary.Right,
                        removedFacts,
                        callableAliases
                    )
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

    private func FilterLeftConditionNarrowings(
        rightOperand BoundExpression,
        leftFrame Dictionary[AccessPath, TypeSymbol]?,
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil
    ) Dictionary[AccessPath, TypeSymbol]? {
        if leftFrame == nil || leftFrame.Count == 0 {
            return nil
        }
        var aliases = callableAliases
        if aliases == nil && testAliasesAt is {} aliasesAt && aliasesAt.TryGetValue(rightOperand, out var atRight) {
            aliases = atRight
        }
        let filtered = Dictionary[AccessPath, TypeSymbol](leftFrame)
        ClearAssignedRootsForConditionOperand(rightOperand, filtered, aliases)
        return if filtered.Count == 0 {
            default(Dictionary[AccessPath, TypeSymbol]?)
        } else {
            filtered
        }
    }

    /// ADR-0208 R18 (#5534, #5545): when the condition's effects removed a fact on the path that [`isExpr`](paramref)
    /// tests, returns the declared type of the path so a property pattern (`x is {}`) restores the removed nullability
    /// fact.
    private func TypeTestOperandTypeAfterEffects(
        isExpr BoundIsExpression,
        removedFacts Dictionary[AccessPath, TypeSymbol]?
    ) TypeSymbol? {
        if removedFacts == nil {
            return nil
        }
        let operand = isExpr.Expression
        if operand is BoundVariableExpression variable {
            if removedFacts.TryGetValue(AccessPath.ForVariable(variable.Variable), out var removedType) {
                if IsNullabilityOnlyFact(variable.Variable.Type, removedType) &&
                    (operand.Type == removedType || operand.Type == variable.Variable.Type) {
                    return variable.Variable.Type
                }
                if operand.Type == removedType {
                    return removedType
                }
            }
            return nil
        }
        if SmartCastStability.TryGetStableMemberPath(operand, out var path, out var currentType) &&
            removedFacts
            .TryGetValue(path!!, out var removedMemberType) {
            let declared = MemberLookup.GetDeclaredAccessPathType(path!!, currentType!!)
            if IsNullabilityOnlyFact(declared, removedMemberType) &&
                (currentType == removedMemberType || currentType == declared) {
                return declared
            }
            if currentType == removedMemberType {
                return removedMemberType
            }
        }
        return nil
    }

    /// ADR-0208 R18 (#5534, #5606): a pattern runs after its operand is read, and a getter with user code in a property
    /// sub-pattern can change the tested path (`x is Dog { P: 1 }` where `P` sets `x = nil`). Such a test proves
    /// nothing about the value a branch reads, so it narrows neither branch. The one statement rule
    /// (cref:StatementKillsPath) decides, applied to the effects of the pattern, which include a call in a constant
    /// pattern (`x is Read(h)`).
    private func TestMayRemoveItsOperandFact(
        isExpr BoundIsExpression,
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil
    ) bool {
        let pattern = if isExpr.Pattern is BoundNotPattern notPattern {
            notPattern.Pattern
        } else {
            isExpr.Pattern
        }
        if RunsNoCode(pattern) {
            return false
        }
        let patternAliases = AliasesAfter(
            isExpr.Expression,
            HashSet[VariableSymbol](callableAliases ?? externalCallableAliases),
            isExpr.Syntax
        )
        return EffectsMayRemoveFactOf(isExpr.Expression, isExpr.Pattern, isExpr, patternAliases)
    }

    /// The one rule of (cref:TestMayRemoveItsOperandFact): whether the effects of [`effects`](paramref) can remove
    /// the fact of the variable or stable member path that [`operand`](paramref) reads, by
    /// (cref:StatementKillsPath). A switch arm's test and guard use it too (#5629).
    private func EffectsMayRemoveFactOf(
        operand BoundExpression,
        effects BoundNode,
        test BoundIsExpression?,
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil
    ) bool {
        var path AccessPath? = nil
        if operand is BoundVariableExpression variable {
            path = variable.Variable
        } else if !SmartCastStability.TryGetStableMemberPath(operand, out path, out _) {
            return false
        }
        CompilationMeasurements.Count("narrowing.pattern-effect-walks")
        if (effects.Syntax ?? test?.Syntax) is {} anchor {
            EnsureClosureAssignedNames(anchor)
        }
        let aliases IReadOnlyCollection[VariableSymbol] = callableAliases ?? externalCallableAliases
        let collector = NewCollector(nil, aliases)
        collector.Visit(effects)
        return StatementKillsPath(
            collector,
            path!!,
            collector.MayMutateMemberPaths,
            collector.MayMutateReferenceStorage
        )
    }

    /// ADR-0208 R18 (#5534, #5606): the callable aliases at each operand of a condition, when its header effects
    /// removed some or it assigns a variable (otherwise `nil`), and the aliases after the condition when it is true
    /// and when it is false. A test reads the aliases at its own evaluation point, not after the whole condition: a
    /// later reassignment (`(x is action()) && (action = f) ...`) does not change it, and an earlier one to an
    /// external callable (`(action = callback) is {} a && (x is action())`) does. One walk in evaluation order visits
    /// each operand once.
    private func AliasesAtTests(removed HashSet[VariableSymbol]?, header SyntaxNode, condition BoundExpression)(
        AtTests Dictionary[BoundExpression, HashSet[VariableSymbol]]?,
        WhenTrue HashSet[VariableSymbol],
        WhenFalse HashSet[VariableSymbol]
    ) {
        if (removed == nil || removed.Count == 0) && !header.DescendantNodesAndSelf().Any(
            (node SyntaxNode) -> node is AssignmentExpressionSyntax or BlockExpressionSyntax
        ) {
            let current = CaptureExternalCallableAliases()
            return (nil, current, HashSet[VariableSymbol](current))
        }
        EnsureClosureAssignedNames(header)
        let entry = HashSet[VariableSymbol](externalCallableAliases)
        if removed != nil {
            entry.UnionWith(removed)
        }
        let aliasesAt = Dictionary[BoundExpression, HashSet[VariableSymbol]]()
        let (whenTrue, whenFalse) = WalkTestAliases(condition, entry, aliasesAt, header)
        return (aliasesAt, whenTrue, whenFalse)
    }

    // Records the aliases before each operand and returns the aliases after [`expression`](paramref) when it is true
    // and when it is false. The right operand of `&&` runs after a true left operand, the right operand of `||`
    // after a false one, and a join keeps only the aliases of both paths. The sets are never changed in place.
    private func WalkTestAliases(
        expression BoundExpression,
        before HashSet[VariableSymbol],
        aliasesAt Dictionary[BoundExpression, HashSet[VariableSymbol]],
        header SyntaxNode? = nil
    )(WhenTrue HashSet[VariableSymbol], WhenFalse HashSet[VariableSymbol]) {
        aliasesAt[expression] = before
        switch expression {
            case block is BoundBlockExpression {
                {
                    let afterPrefix = AliasesAfterBlockPrefix(block, before, header)
                    return WalkTestAliases(block.Expression, afterPrefix, aliasesAt, header)
                }
            }
            case binary is BoundBinaryExpression when binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd {
                {
                    let (leftTrue, leftFalse) = WalkTestAliases(binary.Left, before, aliasesAt, header)
                    let (rightTrue, rightFalse) = WalkTestAliases(binary.Right, leftTrue, aliasesAt, header)
                    return (rightTrue, JoinAliases(leftFalse, rightFalse))
                }
            }
            case binary is BoundBinaryExpression when binary.Op.Kind == BoundBinaryOperatorKind.LogicalOr {
                {
                    let (leftTrue, leftFalse) = WalkTestAliases(binary.Left, before, aliasesAt, header)
                    let (rightTrue, rightFalse) = WalkTestAliases(binary.Right, leftFalse, aliasesAt, header)
                    return (JoinAliases(leftTrue, rightTrue), rightFalse)
                }
            }
            case unary is BoundUnaryExpression when unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation {
                {
                    let (operandTrue, operandFalse) = WalkTestAliases(unary.Operand, before, aliasesAt, header)
                    return (operandFalse, operandTrue)
                }
            }
            default {
                {
                    let after = AliasesAfter(expression, before, header)
                    return (after, after)
                }
            }
        }
    }

    private func JoinAliases(first HashSet[VariableSymbol], second HashSet[VariableSymbol]) HashSet[VariableSymbol] {
        if object.ReferenceEquals(first, second) {
            return first
        }
        let joined = HashSet[VariableSymbol](first)
        joined.IntersectWith(second)
        return joined
    }

    private func AliasesAfterBlockPrefix(
        block BoundBlockExpression,
        before HashSet[VariableSymbol],
        header SyntaxNode? = nil
    ) HashSet[VariableSymbol] {
        if block.Statements.IsDefaultOrEmpty {
            return before
        }
        let prefixShell = BoundBlockExpression(block.Syntax, block.Statements, BoundLiteralExpression(nil, 0))
        return AliasesAfter(prefixShell, before, header)
    }

    // The aliases after [`operand`](paramref) on every path, from the aliases before it. An assignment of an external
    // callable adds the alias.
    private func AliasesAfter(
        operand BoundExpression,
        before HashSet[VariableSymbol],
        header SyntaxNode? = nil
    ) HashSet[VariableSymbol] {
        if ContainsUserLabel(operand) {
            return HashSet[VariableSymbol]()
        }
        let operandSyntax = operand.Syntax
        if before.Count == 0 && operandSyntax != nil && !operandSyntax.DescendantNodesAndSelf().Any(
            (node SyntaxNode) -> node is AssignmentExpressionSyntax or VariableDeclarationSyntax
        ) {
            return before
        }
        let collector = NewCollector(nil, before)
        collector.VisitExpression(operand)
        let after = HashSet[VariableSymbol](collector.DefinitelyExternalFunctionValues)
        if collector.MayMutateAnyRootViaPointer {
            after.Clear()
        }
        RemoveCollectorFilterAffectedAliases(after, operand.Syntax ?? header, collector)
        return after
    }

    // A pattern that reads no member and evaluates no expression: a discard, a literal whose test calls no user `Equals`,
    // a type test, or `{}`.
    private func RunsNoCode(pattern BoundPattern) bool -> switch pattern {
        case BoundDiscardPattern: true
        case constantPattern is BoundConstantPattern: constantPattern.Value is BoundLiteralExpression &&
            !ConstantPatternRunsUserCode(constantPattern)
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

    private func TryClassifyNilGuard(condition BoundExpression, forShortCircuitOperand bool = false)(
        NonNil Dictionary[AccessPath, TypeSymbol]?,
        Nil Dictionary[AccessPath, TypeSymbol]?
    ) {
        // Phase 3.C.4: recognise the canonical narrowing patterns via the shared
        // leaf classifier (SmartCastStability.TryClassifyNilGuardLeaf).
        // Conjunctions, disjunctions and negations compose in ComputeConditionNarrowingInOrder.
        if !SmartCastStability.TryClassifyNilGuardLeaf(
            condition,
            restrictBareVariableToLocalsAndParams: forShortCircuitOperand,
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

    private func TryClassifyBoolCallNarrowing(
        condition BoundExpression,
        callableAliases IReadOnlyCollection[VariableSymbol]? = nil
    )(Then Dictionary[AccessPath, TypeSymbol]?, Else Dictionary[AccessPath, TypeSymbol]?) {
        switch condition {
            case block is BoundBlockExpression {
                var nextAliases = callableAliases
                if nextAliases == nil && testAliasesAt is {} aliasesAt && aliasesAt.TryGetValue(
                    block.Expression,
                    out var atExpr
                ) {
                    nextAliases = atExpr
                } else if !block.Statements.IsDefaultOrEmpty {
                    nextAliases = AliasesAfterBlockPrefix(
                        block,
                        HashSet[VariableSymbol](callableAliases ?? externalCallableAliases)
                    )
                }
                return TryClassifyBoolCallNarrowing(block.Expression, nextAliases)
            }
            case unary is BoundUnaryExpression when unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation {
                let (inThen, inElse) = TryClassifyBoolCallNarrowing(unary.Operand, callableAliases)
                return (inElse, inThen)
            }
            case bin is BoundBinaryExpression when bin.Op.Kind == BoundBinaryOperatorKind.LogicalAnd {
                let (leftThenRaw, leftElse) = TryClassifyBoolCallNarrowing(bin.Left, callableAliases)
                let leftThen = FilterLeftConditionNarrowings(bin.Right, leftThenRaw, callableAliases)
                let (rightThen, rightElse) = TryClassifyBoolCallNarrowing(bin.Right, callableAliases)
                return CombineLogicalAndNarrowings(leftThenRaw, leftThen, leftElse, rightThen, rightElse)
            }
            case bin is BoundBinaryExpression when bin.Op.Kind == BoundBinaryOperatorKind.LogicalOr {
                let (leftThen, leftElseRaw) = TryClassifyBoolCallNarrowing(bin.Left, callableAliases)
                let leftElse = FilterLeftConditionNarrowings(bin.Right, leftElseRaw, callableAliases)
                let (rightThen, rightElse) = TryClassifyBoolCallNarrowing(bin.Right, callableAliases)
                return CombineLogicalOrNarrowings(leftThen, leftElseRaw, leftElse, rightThen, rightElse)
            }
        }
        var aliases = callableAliases
        if aliases == nil && testAliasesAt is {} aliasesAt && aliasesAt.TryGetValue(condition, out var atCond) {
            aliases = atCond
        }
        return TryClassifyBoolCallNarrowingLeaf(
            condition,
            $scope,
            restrictBareVariableToLocalsAndParams: false,
            aliases ?? externalCallableAliases,
            (
                node BoundNode,
                state Dictionary[AccessPath, TypeSymbol],
                callAliases IReadOnlyCollection[VariableSymbol]?
            ) -> ClearAssignedRoots(node, state, callAliases),
            (expr BoundExpression, current HashSet[VariableSymbol]) -> AliasesAfter(expr, current)
        )
    }

    private func BindStatementWithNarrowing(
        syntax StatementSyntax,
        frame Dictionary[AccessPath, TypeSymbol]?
    ) BoundStatement {
        let inheritedFallthrough = currentStatementListFallsThrough
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
                    let badInitializer = bindExpression(values[i], false)
                    ApplySubExpressionNarrowingEffects(values[i], badInitializer)
                    continue
                }
                var initializer = bindExpression(values[i], false)
                ApplySubExpressionNarrowingEffects(values[i], initializer)
                if IsDiscard(nameExpr.IdentifierToken) {
                    continue
                }
                let varType = TupleTypeSymbol.ResolveNilElements(initializer.Type)
                if !object.ReferenceEquals(varType, initializer.Type) {
                    initializer = conversions.BindConversion(values[i].Location, initializer, varType)
                }
                let variable = bindLocalVariable(nameExpr.IdentifierToken, false, varType)
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
        let targetSnapshots = [targets.Length]NarrowingBindSnapshot
        for var i = 0; i < targets.Length; i++ {
            targetSnapshots[i] = CaptureNarrowingBindSnapshot()
            ApplyMultiAssignmentTargetCaptureEffects(targets[i], values[i], syntax.OperatorToken)
        }
        var valueSnapshot = CaptureNarrowingBindSnapshot()
        for var i = 0; i < targets.Length; i++ {
            let unwrappedTarget = AssignmentTargetSyntaxFacts.UnwrapParentheses(targets[i])
            let isSimpleTarget = IsDiscardTarget(unwrappedTarget) ||
                unwrappedTarget is MultiAssignmentDeclarationExpressionSyntax ||
                unwrappedTarget is NameExpressionSyntax
            let prevPendingSyntax = pendingMultiAssignmentValueSyntax
            let prevPendingSnapshot = pendingMultiAssignmentValueSnapshot
            if isSimpleTarget {
                RestoreNarrowingBindSnapshot(valueSnapshot)
            } else {
                RestoreNarrowingBindSnapshot(targetSnapshots[i])
                pendingMultiAssignmentValueSyntax = values[i]
                pendingMultiAssignmentValueSnapshot = valueSnapshot
            }
            var plan MultiAssignmentTargetPlan
            try {
                plan = if IsDiscardTarget(targets[i]) {
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
            } finally {
                if pendingMultiAssignmentValueSyntax != nil && object.ReferenceEquals(
                    pendingMultiAssignmentValueSyntax,
                    values[i]
                ) {
                    RestoreNarrowingBindSnapshot(valueSnapshot)
                }
                pendingMultiAssignmentValueSyntax = prevPendingSyntax
                pendingMultiAssignmentValueSnapshot = prevPendingSnapshot
            }
            ApplySubExpressionNarrowingEffects(values[i], plan.AssignedValue)
            valueSnapshot = CaptureNarrowingBindSnapshot()
            plans.Add(plan)
        }
        return BuildMultiAssignmentBlock(syntax, captures, plans)
    }

    private func ApplyMultiAssignmentTargetCaptureEffects(
        target ExpressionSyntax,
        valueSyntax ExpressionSyntax? = nil,
        equalsToken SyntaxToken? = nil
    ) {
        let unwrapped = AssignmentTargetSyntaxFacts.UnwrapParentheses(target)
        if IsDiscardTarget(unwrapped) ||
            unwrapped is MultiAssignmentDeclarationExpressionSyntax ||
            unwrapped is NameExpressionSyntax {
            return
        }
        let preTarget = CaptureNarrowingBindSnapshot()
        let diagMark = Diagnostics.Count
        $scope = BoundScope($scope)
        try {
            var effectiveValueSyntax = valueSyntax
            let boundTargetExpr = bindExpression(unwrapped, false)
            RestoreNarrowingBindSnapshot(preTarget)
            Diagnostics.TruncateTo(diagMark)
            if effectiveValueSyntax == nil && equalsToken != nil {
                if boundTargetExpr is not BoundErrorExpression &&
                    boundTargetExpr.Type != nil &&
                    boundTargetExpr.Type != TypeSymbol
                    .Error {
                    let probeLocal = LocalVariableSymbol("$$macap_probe", isReadOnly: true, boundTargetExpr.Type)
                    $scope.TryDeclareVariable(probeLocal)
                    effectiveValueSyntax = NameExpressionSyntax(
                        unwrapped.SyntaxTree,
                        SyntaxToken(
                            unwrapped.SyntaxTree,
                            SyntaxKind.IdentifierToken,
                            unwrapped.Span.Start,
                            "$$macap_probe",
                            nil
                        )
                    )
                } else {
                    effectiveValueSyntax = DefaultExpressionSyntax(
                        unwrapped.SyntaxTree,
                        SyntaxToken(
                            unwrapped.SyntaxTree,
                            SyntaxKind.DefaultKeyword,
                            unwrapped.Span.Start,
                            "default",
                            nil
                        ),
                        nil,
                        nil,
                        nil
                    )
                }
            }
            if effectiveValueSyntax != nil && equalsToken != nil {
                let probeCaptures = ImmutableArray.CreateBuilder[BoundStatement]()
                let _ = BindMultiAssignmentTarget(unwrapped, effectiveValueSyntax, equalsToken, probeCaptures)
                RestoreNarrowingBindSnapshot(preTarget)
                if probeCaptures.Count > 0 {
                    for stmt in probeCaptures {
                        switch stmt {
                            case decl is BoundVariableDeclaration {
                                ApplySubExpressionNarrowingEffects(unwrapped, decl.Initializer)
                            }
                            case exprStmt is BoundExpressionStatement {
                                ApplySubExpressionNarrowingEffects(unwrapped, exprStmt.Expression)
                            }
                        }
                    }
                    return
                }
            }
            if boundTargetExpr is not BoundErrorExpression {
                switch boundTargetExpr {
                    case indexExpr is BoundIndexExpression {
                        ApplySubExpressionNarrowingEffects(unwrapped, indexExpr.Target)
                        for arg in indexExpr.Indices {
                            ApplySubExpressionNarrowingEffects(unwrapped, arg)
                        }
                        return
                    }
                    case clrIndex is BoundClrIndexExpression {
                        ApplySubExpressionNarrowingEffects(unwrapped, clrIndex.Target)
                        for arg in clrIndex.Arguments {
                            ApplySubExpressionNarrowingEffects(unwrapped, arg)
                        }
                        return
                    }
                    case deref is BoundDereferenceExpression {
                        ApplySubExpressionNarrowingEffects(unwrapped, deref)
                        return
                    }
                }
            }
            if AssignmentTargetSyntaxFacts.TryLiftTrailingIndexer(unwrapped, out var indexed) && indexed != nil {
                let boundTarget = bindExpression(indexed.Target, false)
                ApplySubExpressionNarrowingEffects(indexed.Target, boundTarget)
                let convertToInt = boundTarget.Type is ArrayTypeSymbol or
                    SliceTypeSymbol ||
                    NativeSliceTypes.TryGetElement(boundTarget.Type, out _, out _)
                for indexSyntax in indexed.Indices {
                    var boundIndex = bindExpression(indexSyntax, false)
                    if convertToInt && boundIndex is not BoundErrorExpression && boundIndex.Type != TypeSymbol.Int32 {
                        boundIndex = conversions.BindConversion(indexSyntax.Location, boundIndex, TypeSymbol.Int32)
                    }
                    ApplySubExpressionNarrowingEffects(indexSyntax, boundIndex)
                }
            } else if AssignmentTargetSyntaxFacts.TryLiftTrailingMemberAccess(
                unwrapped,
                out var receiver,
                out _,
                out _
            ) {
                let boundReceiver = bindExpression(receiver, false)
                ApplySubExpressionNarrowingEffects(receiver, boundReceiver)
            } else if unwrapped is UnaryExpressionSyntax dereference &&
                dereference
                .OperatorToken
                .Kind == SyntaxKind
                .StarToken {
                let boundOperand = bindExpression(dereference.Operand, false)
                ApplySubExpressionNarrowingEffects(dereference.Operand, boundOperand)
            }
        } finally {
            $scope = $scope.Pop()
            Diagnostics.TruncateTo(diagMark)
        }
    }

    private func BindTupleValuedMultiAssignment(
        syntax MultiAssignmentStatementSyntax,
        targets ImmutableArray[ExpressionSyntax],
        valueSyntax ExpressionSyntax
    ) BoundStatement {
        let targetSnapshots = [targets.Length]NarrowingBindSnapshot
        for var i = 0; i < targets.Length; i++ {
            targetSnapshots[i] = CaptureNarrowingBindSnapshot()
            ApplyMultiAssignmentTargetCaptureEffects(targets[i], equalsToken: syntax.OperatorToken)
        }
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
        ApplySubExpressionNarrowingEffects(valueSyntax, tupleValue)
        let afterTupleValueSnapshot = CaptureNarrowingBindSnapshot()
        if tupleValue.Type == TypeSymbol.Error {
            return BoundExpressionStatement(syntax, tupleValue)
        }
        if tupleValue.Type is not TupleTypeSymbol rawTupleType {
            Diagnostics.ReportMultiAssignmentMismatch(syntax.Location, targets.Length, 1)
            return BoundExpressionStatement(syntax, tupleValue)
        }
        if targets.Length != rawTupleType.Arity {
            Diagnostics.ReportMultiAssignmentMismatch(syntax.Location, targets.Length, rawTupleType.Arity)
            return BoundExpressionStatement(syntax, tupleValue)
        }
        let captures = ImmutableArray.CreateBuilder[BoundStatement]()
        let sources = [targets.Length]LocalVariableSymbol?
        let rawPlans = [targets.Length]MultiAssignmentTargetPlan
        let resolvedElements = ImmutableArray.CreateBuilder[TypeSymbol](targets.Length)
        for var i = 0; i < targets.Length; i++ {
            let rawElement = rawTupleType.ElementTypes[i]
            if IsDiscardTarget(targets[i]) {
                rawPlans[i] = MultiAssignmentTargetPlan(assignedValue: nil, createWrite: nil)
                resolvedElements.Add(
                    if rawElement == TypeSymbol.Null {
                        cast[TypeSymbol](NullableTypeSymbol.Get(TypeSymbol.Object))
                    } else {
                        TupleTypeSymbol.ResolveNilElements(rawElement)
                    }
                )
                continue
            }
            if targets[i] is MultiAssignmentDeclarationExpressionSyntax declaration {
                rawPlans[i] = MultiAssignmentTargetPlan(assignedValue: nil, createWrite: nil, declaration)
                resolvedElements.Add(
                    if rawElement == TypeSymbol.Null {
                        cast[TypeSymbol](NullableTypeSymbol.Get(TypeSymbol.Object))
                    } else {
                        TupleTypeSymbol.ResolveNilElements(rawElement)
                    }
                )
                continue
            }
            let source = DeclareMultiAssignmentTemp("element$i", rawElement)
            sources[i] = source
            let sourceToken = SyntaxToken(
                syntax.SyntaxTree,
                SyntaxKind.IdentifierToken,
                valueSyntax.Location.Span.Start,
                source.Name,
                source.Name
            )
            let sourceSyntax = NameExpressionSyntax(syntax.SyntaxTree, sourceToken)
            RestoreNarrowingBindSnapshot(targetSnapshots[i])
            let plan = BindMultiAssignmentTarget(targets[i], sourceSyntax, syntax.OperatorToken, captures)
            rawPlans[i] = plan
            let sourceTargetType = FindMultiAssignmentSourceConversionType(plan.AssignedValue, source) ??
                plan
                .AssignedValue
                ?.Type
            if (rawElement == TypeSymbol.Null || rawElement is TupleTypeSymbol{HasNilElement: true}) &&
                sourceTargetType != nil &&
                sourceTargetType != TypeSymbol.Error &&
                !TypeSymbol
                .ContainsNullLiteralType(sourceTargetType) {
                resolvedElements.Add(TupleTypeSymbol.ResolveNilElements(rawElement, sourceTargetType))
            } else {
                resolvedElements.Add(TupleTypeSymbol.ResolveNilElements(rawElement))
            }
        }
        RestoreNarrowingBindSnapshot(afterTupleValueSnapshot)
        let tupleType = if rawTupleType.HasNames {
            TupleTypeSymbol.Get(resolvedElements.MoveToImmutable(), rawTupleType.ElementNames)
        } else {
            TupleTypeSymbol.Get(resolvedElements.MoveToImmutable())
        }
        tupleValue = conversions.BindConversion(valueSyntax.Location, tupleValue, tupleType)
        let (tupleTemp, tupleElements) = CreateTupleDeconstructionPlan(valueSyntax, tupleType)
        let plans = ImmutableArray.CreateBuilder[MultiAssignmentTargetPlan](targets.Length)
        for var i = 0; i < targets.Length; i++ {
            var plan = rawPlans[i]
            if plan.Declaration != nil {
                plans.Add(MultiAssignmentTargetPlan(tupleElements[i], createWrite: nil, plan.Declaration))
                continue
            }
            if plan.AssignedValue is {} assignedValue && sources[i] is {} source {
                plan = plan.WithAssignedValue(
                    MultiAssignmentTupleElementRewriter(
                        source,
                        tupleElements[i],
                        conversions,
                        targets[i].Location
                    ).Replace(assignedValue)
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
            if plans[i].AssignedValue is not{} initialValue {
                continue
            }
            if initialValue.Type == TypeSymbol.Error {
                statements.Add(BoundExpressionStatement(syntax, initialValue))
                continue
            }
            let assignedValue = if initialValue.Type is TupleTypeSymbol{HasNilElement: true} unresolvedTuple {
                let resolvedTuple = TupleTypeSymbol.ResolveNilElements(unresolvedTuple)
                conversions.BindConversion(
                    initialValue.Syntax?.Location ?? syntax.Location,
                    initialValue,
                    resolvedTuple
                )
            } else {
                initialValue
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
        private let conversions ConversionClassifier?
        private let location TextLocation

        init(
            source VariableSymbol,
            replacement BoundExpression,
            conversions ConversionClassifier? = nil,
            location TextLocation = default(TextLocation)
        ) {
            this.source = source
            this.replacement = replacement
            this.conversions = conversions
            this.location = location
        }

        func Replace(expression BoundExpression) BoundExpression -> RewriteExpression(expression)

        protected override func RewriteConversionExpression(node BoundConversionExpression) BoundExpression {
            if node.Expression is BoundVariableExpression v && object.ReferenceEquals(v.Variable, source) &&
                node.Type == replacement.Type {
                return replacement
            }
            return base.RewriteConversionExpression(node)
        }

        protected override func RewriteBlockExpression(node BoundBlockExpression) BoundExpression {
            if node
                .Statements
                .Length == 1 &&
                node.Statements[0] is BoundVariableDeclaration{Initializer: BoundVariableExpression v} &&
                object
                .ReferenceEquals(v.Variable, source) {
                if node.Type == replacement.Type {
                    return replacement
                }
                if conversions != nil && node.Type != TypeSymbol.Error {
                    return conversions.BindConversion(location, replacement, node.Type)
                }
            }
            return base.RewriteBlockExpression(node)
        }

        protected override func RewriteVariableExpression(
            node BoundVariableExpression
        ) BoundExpression -> if object.ReferenceEquals(node.Variable, source) {
            replacement
        } else {
            base.RewriteVariableExpression(node)
        }
    }

    private func FindMultiAssignmentSourceConversionType(
        expression BoundExpression?,
        source VariableSymbol
    ) TypeSymbol? {
        switch expression {
            case nil {
                return nil
            }
            case conv is BoundConversionExpression {
                if conv.Expression is BoundVariableExpression v && object.ReferenceEquals(v.Variable, source) {
                    return conv.Type
                }
                return FindMultiAssignmentSourceConversionType(conv.Expression, source)
            }
            case block is BoundBlockExpression {
                if block
                    .Statements
                    .Length == 1 &&
                    block.Statements[0] is BoundVariableDeclaration{Initializer: BoundVariableExpression v} &&
                    object.ReferenceEquals(v.Variable, source) {
                    return block.Type
                }
                return FindMultiAssignmentSourceConversionType(block.Expression, source)
            }
            case call is BoundCallExpression {
                for arg in call.Arguments {
                    if FindMultiAssignmentSourceConversionType(arg, source) is {} found {
                        return found
                    }
                }
                return nil
            }
            case clrConv is BoundClrConversionCallExpression {
                return FindMultiAssignmentSourceConversionType(clrConv.Source, source)
            }
            default {
                return nil
            }
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

        internal func MergeNarrowingFrames(
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
                if merged.TryGetValue(kv.Key, out var existing) &&
                    existing != kv.Value &&
                    !IsNullableWidening(kv.Key, kv.Value) &&
                    !IsNullableWidening(kv.Key, existing) {
                    let existingToNew = Conversion.ClassifyNonStructural(existing, kv.Value)
                    let newToExisting = Conversion.ClassifyNonStructural(kv.Value, existing)
                    if existingToNew.Exists &&
                        existingToNew.IsImplicit &&
                        !(newToExisting.Exists && newToExisting.IsImplicit) {
                        continue
                    }
                }
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

        internal func IsNullableWidening(path AccessPath, type TypeSymbol) bool -> !path.HasMembers &&
            !(path.Root.Type is NullableTypeSymbol) &&
            type is NullableTypeSymbol

        internal func CombineLogicalAndNarrowings(
            leftThenRaw Dictionary[AccessPath, TypeSymbol]?,
            leftThenFiltered Dictionary[AccessPath, TypeSymbol]?,
            leftElse Dictionary[AccessPath, TypeSymbol]?,
            rightThen Dictionary[AccessPath, TypeSymbol]?,
            rightElse Dictionary[AccessPath, TypeSymbol]?
        )(Then Dictionary[AccessPath, TypeSymbol]?, Else Dictionary[AccessPath, TypeSymbol]?) {
            var combinedThen = MergeNarrowingFrames(leftThenFiltered, PreserveNullableWidenings(leftThenRaw))
            combinedThen = MergeNarrowingFrames(combinedThen, rightThen)
            var combinedElse = IntersectNarrowingFrames(leftElse, MergeNarrowingFrames(leftThenFiltered, rightElse))
            if leftElse != nil {
                for kv in leftElse {
                    if IsNullableWidening(kv.Key, kv.Value) {
                        combinedElse ??= Dictionary[AccessPath, TypeSymbol]()
                        combinedElse!![kv.Key] = kv.Value
                    }
                }
            }
            if leftThenRaw != nil {
                for kv in leftThenRaw {
                    if IsNullableWidening(kv.Key, kv.Value) && !HasNonWideningRefinement(rightElse, kv.Key) {
                        combinedElse ??= Dictionary[AccessPath, TypeSymbol]()
                        combinedElse!![kv.Key] = kv.Value
                    }
                }
            }
            if rightElse != nil {
                for kv in rightElse {
                    if IsNullableWidening(kv.Key, kv.Value) {
                        combinedElse ??= Dictionary[AccessPath, TypeSymbol]()
                        combinedElse!![kv.Key] = kv.Value
                    }
                }
            }
            if (combinedThen == nil || combinedThen.Count == 0) && (combinedElse == nil || combinedElse.Count == 0) {
                return (nil, nil)
            }
            return (combinedThen, combinedElse)
        }

        internal func CombineLogicalOrNarrowings(
            leftThen Dictionary[AccessPath, TypeSymbol]?,
            leftElseRaw Dictionary[AccessPath, TypeSymbol]?,
            leftElseFiltered Dictionary[AccessPath, TypeSymbol]?,
            rightThen Dictionary[AccessPath, TypeSymbol]?,
            rightElse Dictionary[AccessPath, TypeSymbol]?
        )(Then Dictionary[AccessPath, TypeSymbol]?, Else Dictionary[AccessPath, TypeSymbol]?) {
            var combinedThen = IntersectNarrowingFrames(leftThen, MergeNarrowingFrames(leftElseFiltered, rightThen))
            if leftThen != nil {
                for kv in leftThen {
                    if IsNullableWidening(kv.Key, kv.Value) {
                        combinedThen ??= Dictionary[AccessPath, TypeSymbol]()
                        combinedThen!![kv.Key] = kv.Value
                    }
                }
            }
            if leftElseRaw != nil {
                for kv in leftElseRaw {
                    if IsNullableWidening(kv.Key, kv.Value) && !HasNonWideningRefinement(rightThen, kv.Key) {
                        combinedThen ??= Dictionary[AccessPath, TypeSymbol]()
                        combinedThen!![kv.Key] = kv.Value
                    }
                }
            }
            if rightThen != nil {
                for kv in rightThen {
                    if IsNullableWidening(kv.Key, kv.Value) {
                        combinedThen ??= Dictionary[AccessPath, TypeSymbol]()
                        combinedThen!![kv.Key] = kv.Value
                    }
                }
            }
            var combinedElse = MergeNarrowingFrames(leftElseFiltered, PreserveNullableWidenings(leftElseRaw))
            combinedElse = MergeNarrowingFrames(combinedElse, rightElse)
            if (combinedThen == nil || combinedThen.Count == 0) && (combinedElse == nil || combinedElse.Count == 0) {
                return (nil, nil)
            }
            return (combinedThen, combinedElse)
        }

        private func PreserveNullableWidenings(frame Dictionary[AccessPath, TypeSymbol]?) Dictionary[
            AccessPath,
            TypeSymbol
        ]? {
            if frame == nil || frame.Count == 0 {
                return nil
            }
            var result Dictionary[AccessPath, TypeSymbol]? = nil
            for kv in frame {
                if IsNullableWidening(kv.Key, kv.Value) {
                    result ??= Dictionary[AccessPath, TypeSymbol]()
                    result!![kv.Key] = kv.Value
                }
            }
            return result
        }

        private func HasNonWideningRefinement(
            frame Dictionary[AccessPath, TypeSymbol]?,
            path AccessPath
        ) bool -> frame != nil &&
            frame.TryGetValue(path, out var refined) && !IsNullableWidening(path, refined)

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

        internal func JoinCallableAliasSets(first HashSet[VariableSymbol], second HashSet[VariableSymbol]) HashSet[
            VariableSymbol
        ] {
            if object.ReferenceEquals(first, second) {
                return first
            }
            let joined = HashSet[VariableSymbol](first)
            joined.IntersectWith(second)
            return joined
        }

        internal func TryClassifyBoolCallNarrowingLeaf(
            condition BoundExpression,
            $scope BoundScope? = nil,
            restrictBareVariableToLocalsAndParams bool = false,
            callableAliases IReadOnlyCollection[VariableSymbol]? = nil,
            clearAssignedRoots(
                (BoundNode, Dictionary[AccessPath, TypeSymbol], IReadOnlyCollection[VariableSymbol]?) -> void
            )? = nil,
            evolveAliases((BoundExpression, HashSet[VariableSymbol]) -> HashSet[VariableSymbol])? = nil
        )(Then Dictionary[AccessPath, TypeSymbol]?, Else Dictionary[AccessPath, TypeSymbol]?) {
            var effectiveAliases = callableAliases
            var inner = condition
            while inner is BoundBlockExpression block {
                if !block.Statements.IsDefaultOrEmpty && evolveAliases != nil {
                    let currentAliases = if effectiveAliases != nil {
                        HashSet[VariableSymbol](effectiveAliases)
                    } else {
                        HashSet[VariableSymbol]()
                    }
                    let prefixShell = BoundBlockExpression(
                        block.Syntax,
                        block.Statements,
                        BoundLiteralExpression(nil, 0)
                    )
                    effectiveAliases = evolveAliases(prefixShell, currentAliases)
                }
                inner = block.Expression
            }
            if inner is BoundImportedCallExpression importedCall && importedCall.Type == TypeSymbol.Bool {
                return ClassifyImportedBoolCallNarrowing(
                    importedCall,
                    negate: false,
                    restrictBareVariableToLocalsAndParams,
                    effectiveAliases,
                    clearAssignedRoots,
                    evolveAliases
                )
            }
            if inner is BoundImportedInstanceCallExpression importedInstanceCall &&
                importedInstanceCall.Type == TypeSymbol
                .Bool {
                var (thenFrame, elseFrame) = ClassifyImportedMethodBoolCallNarrowing(
                    importedInstanceCall,
                    importedInstanceCall.Method.GetParameters(),
                    importedInstanceCall.Arguments,
                    negate: false,
                    restrictBareVariableToLocalsAndParams,
                    effectiveAliases,
                    clearAssignedRoots,
                    evolveAliases
                )
                MergeClrMemberNotNullWhenNarrowings(
                    importedInstanceCall,
                    negate: false,
                    $scope,
                    effectiveAliases,
                    clearAssignedRoots,
                    evolveAliases,
                    &thenFrame,
                    &elseFrame
                )
                return (thenFrame, elseFrame)
            }
            if inner is BoundCallExpression userCall && userCall.Type == TypeSymbol.Bool {
                return ClassifyUserBoolCallNarrowing(
                    userCall,
                    negate: false,
                    restrictBareVariableToLocalsAndParams,
                    effectiveAliases,
                    clearAssignedRoots,
                    evolveAliases
                )
            }
            if inner is BoundUserInstanceCallExpression userInstanceCall && userInstanceCall.Type == TypeSymbol.Bool {
                var (thenFrame, elseFrame) = ClassifyUserMethodBoolCallNarrowing(
                    userInstanceCall,
                    userInstanceCall.Method.Parameters,
                    userInstanceCall.Arguments,
                    negate: false,
                    restrictBareVariableToLocalsAndParams,
                    effectiveAliases,
                    clearAssignedRoots,
                    evolveAliases
                )
                MergeUserMemberNotNullWhenNarrowings(
                    userInstanceCall,
                    negate: false,
                    $scope,
                    restrictBareVariableToLocalsAndParams,
                    effectiveAliases,
                    clearAssignedRoots,
                    evolveAliases,
                    &thenFrame,
                    &elseFrame
                )
                return (thenFrame, elseFrame)
            }
            return (nil, nil)
        }

        // Issue #208: merge [MemberNotNullWhen] field narrowings from a CLR-imported method.
        private func MergeClrMemberNotNullWhenNarrowings(
            call BoundImportedInstanceCallExpression,
            negate bool,
            $scope BoundScope?,
            callableAliases IReadOnlyCollection[VariableSymbol]?,
            clearAssignedRoots(
                (BoundNode, Dictionary[AccessPath, TypeSymbol], IReadOnlyCollection[VariableSymbol]?) -> void
            )?,
            evolveAliases((BoundExpression, HashSet[VariableSymbol]) -> HashSet[VariableSymbol])?,
            ref thenFrame Dictionary[AccessPath, TypeSymbol]?,
            ref elseFrame Dictionary[AccessPath, TypeSymbol]?
        ) {
            if $scope == nil || !ClrNullability.TryGetMemberNotNullWhenData(
                call.Method,
                out var returnValue,
                out var members
            ) {
                return
            }
            let receiver = call.Receiver
            if SmartCastStability.TryGetStablePath(receiver) is not{} receiverPath ||
                !PreservesReceiverPath(
                call,
                call.Arguments,
                receiverPath,
                receiver.Type,
                callableAliases,
                clearAssignedRoots,
                evolveAliases
            ) {
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
                NarrowClrReceiverMember(receiver.Type, call.Method.DeclaringType, receiverPath, name, frame)
            }
        }

        // Issue #208: merge [MemberNotNullWhen] field narrowings from a user-declared method.
        private func MergeUserMemberNotNullWhenNarrowings(
            call BoundUserInstanceCallExpression,
            negate bool,
            $scope BoundScope?,
            restrictBareVariableToLocalsAndParams bool,
            callableAliases IReadOnlyCollection[VariableSymbol]?,
            clearAssignedRoots(
                (BoundNode, Dictionary[AccessPath, TypeSymbol], IReadOnlyCollection[VariableSymbol]?) -> void
            )?,
            evolveAliases((BoundExpression, HashSet[VariableSymbol]) -> HashSet[VariableSymbol])?,
            ref thenFrame Dictionary[AccessPath, TypeSymbol]?,
            ref elseFrame Dictionary[AccessPath, TypeSymbol]?
        ) {
            let attributes = call.Method.Attributes
            if $scope == nil || attributes.IsDefaultOrEmpty {
                return
            }
            let declaringStruct = call.Method.ReceiverType as StructSymbol
            if declaringStruct == nil {
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
                    NarrowUserFieldInScope(
                        $scope,
                        call,
                        declaringStruct,
                        name,
                        restrictBareVariableToLocalsAndParams,
                        callableAliases,
                        clearAssignedRoots,
                        evolveAliases,
                        frame
                    )
                }
            }
        }

        private func NarrowUserFieldInScope(
            $scope BoundScope,
            call BoundUserInstanceCallExpression,
            declaringStruct StructSymbol,
            fieldName string,
            restrictBareVariableToLocalsAndParams bool,
            callableAliases IReadOnlyCollection[VariableSymbol]?,
            clearAssignedRoots(
                (BoundNode, Dictionary[AccessPath, TypeSymbol], IReadOnlyCollection[VariableSymbol]?) -> void
            )?,
            evolveAliases((BoundExpression, HashSet[VariableSymbol]) -> HashSet[VariableSymbol])?,
            frame Dictionary[AccessPath, TypeSymbol]
        ) {
            let receiver = call.Receiver
            let (resolvedField, resolvedProperty, resolvedOwner) = ResolveDeclaredSourceMember(
                receiver.Type,
                declaringStruct,
                fieldName
            )
            if !restrictBareVariableToLocalsAndParams && $scope.TryLookupSymbol(
                fieldName
            ) is ImplicitFieldVariableSymbol fieldVar &&
                TargetsImplicitThis(receiver, fieldVar) &&
                resolvedField != nil &&
                resolvedOwner != nil &&
                object.ReferenceEquals(
                resolvedOwner.Definition ?? resolvedOwner,
                fieldVar.StructType.Definition ?? fieldVar.StructType
            ) &&
                fieldVar.Type is NullableTypeSymbol nullable &&
                PreservesReceiverPath(
                call,
                call.Arguments,
                AccessPath.ForVariable(fieldVar.Receiver),
                fieldVar.Receiver.Type,
                callableAliases,
                clearAssignedRoots,
                evolveAliases
            ) {
                frame[fieldVar] = nullable.UnderlyingType
            }
            if SmartCastStability.TryGetStablePath(receiver) is {} receiverPath &&
                PreservesReceiverPath(
                call,
                call.Arguments,
                receiverPath,
                receiver.Type,
                callableAliases,
                clearAssignedRoots,
                evolveAliases
            ) {
                if resolvedField != nil && SmartCastStability.IsStableField(resolvedField) &&
                    resolvedField.Type is NullableTypeSymbol fldNullable {
                    frame[receiverPath.Append(resolvedField)] = fldNullable.UnderlyingType
                } else if resolvedProperty != nil && SmartCastStability.IsStableProperty(resolvedProperty) &&
                    resolvedProperty.Type is NullableTypeSymbol propNullable {
                    frame[receiverPath.Append(resolvedProperty)] = propNullable.UnderlyingType
                }
            }
        }

        private func TargetsImplicitThis(receiver BoundExpression?, implicitField ImplicitFieldVariableSymbol) bool {
            var current = receiver
            while current is BoundConversionExpression conversion && IsFlowTransparentConversion(conversion) {
                current = conversion.Expression
            }
            return current is BoundVariableExpression variable && object.ReferenceEquals(
                variable.Variable,
                implicitField.Receiver
            )
        }

        private func ResolveDeclaredSourceMember(
            receiverType TypeSymbol,
            declaringStruct StructSymbol,
            memberName string
        )(Field FieldSymbol?, Property PropertySymbol?, Owner StructSymbol?) {
            let unwrappedType = if receiverType is NullableTypeSymbol nullableReceiver {
                nullableReceiver.UnderlyingType
            } else if receiverType is PlatformTypeSymbol platformReceiver {
                platformReceiver.UnderlyingType
            } else {
                receiverType
            }
            var startStruct = declaringStruct
            if unwrappedType is StructSymbol receiverStruct {
                for owner in receiverStruct.GetHierarchy() {
                    if object.ReferenceEquals(
                        owner.Definition ?? owner,
                        declaringStruct.Definition ?? declaringStruct
                    ) {
                        startStruct = owner
                        break
                    }
                }
            }
            for owner in startStruct.GetHierarchy() {
                if !owner.Fields.IsDefaultOrEmpty {
                    for fld in owner.Fields {
                        if !fld.IsStatic && fld.Name == memberName {
                            return (fld, nil, owner)
                        }
                    }
                }
                if !owner.Properties.IsDefaultOrEmpty {
                    for prop in owner.Properties {
                        if !prop.IsStatic && !prop.IsIndexer && prop.Name == memberName {
                            return (nil, prop, owner)
                        }
                    }
                }
            }
            return (nil, nil, nil)
        }

        private func NarrowClrReceiverMember(
            receiverType TypeSymbol,
            declaringClrType Type?,
            receiverPath AccessPath,
            memberName string,
            frame Dictionary[AccessPath, TypeSymbol]
        ) {
            if declaringClrType == nil {
                return
            }
            let unwrappedType = if receiverType is NullableTypeSymbol nullableReceiver {
                nullableReceiver.UnderlyingType
            } else if receiverType is PlatformTypeSymbol platformReceiver {
                platformReceiver.UnderlyingType
            } else {
                receiverType
            }
            let flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
            if declaringClrType.IsInterface {
                if ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(
                    declaringClrType,
                    memberName,
                    flags
                ) is {} ifaceProp {
                    if SmartCastStability.IsStableClrMember(ifaceProp) && MemberLookup.GetClrPropertyTypeSymbol(
                        unwrappedType,
                        ifaceProp
                    ) is NullableTypeSymbol ifacePropNullable {
                        frame[receiverPath.Append(ifaceProp)] = ifacePropNullable.UnderlyingType
                    }
                    return
                }
                if ClrTypeUtilities.SafeGetFieldIncludingInterfaces(
                    declaringClrType,
                    memberName,
                    flags
                ) is {} ifaceField {
                    if SmartCastStability.IsStableClrMember(ifaceField) && MemberLookup.GetClrFieldTypeSymbol(
                        unwrappedType,
                        ifaceField
                    ) is NullableTypeSymbol ifaceFieldNullable {
                        frame[receiverPath.Append(ifaceField)] = ifaceFieldNullable.UnderlyingType
                    }
                }
                return
            }
            let declaredFlags = BindingFlags.DeclaredOnly | flags
            for var current Type? = declaringClrType; current != nil; current = current?.BaseType {
                if ClrTypeUtilities.SafeGetField(current, memberName, declaredFlags) is {} clrField {
                    if SmartCastStability.IsStableClrMember(clrField) && MemberLookup.GetClrFieldTypeSymbol(
                        unwrappedType,
                        clrField
                    ) is NullableTypeSymbol clrFieldNullable {
                        frame[receiverPath.Append(clrField)] = clrFieldNullable.UnderlyingType
                    }
                    return
                }
                if ClrTypeUtilities.SafeGetProperty(current, memberName, declaredFlags) is {} clrProp {
                    if SmartCastStability.IsStableClrMember(clrProp) && MemberLookup.GetClrPropertyTypeSymbol(
                        unwrappedType,
                        clrProp
                    ) is NullableTypeSymbol clrPropNullable {
                        frame[receiverPath.Append(clrProp)] = clrPropNullable.UnderlyingType
                    }
                    return
                }
            }
        }

        private func ClassifyImportedBoolCallNarrowing(
            call BoundImportedCallExpression,
            negate bool,
            restrictBareVariableToLocalsAndParams bool,
            callableAliases IReadOnlyCollection[VariableSymbol]?,
            clearAssignedRoots(
                (BoundNode, Dictionary[AccessPath, TypeSymbol], IReadOnlyCollection[VariableSymbol]?) -> void
            )?,
            evolveAliases((BoundExpression, HashSet[VariableSymbol]) -> HashSet[VariableSymbol])?
        )(Then Dictionary[AccessPath, TypeSymbol]?, Else Dictionary[AccessPath, TypeSymbol]?) {
            let parameters = call.Function.Method.GetParameters()
            var result = ClassifyImportedMethodBoolCallNarrowing(
                call,
                parameters,
                call.Arguments,
                negate,
                restrictBareVariableToLocalsAndParams,
                callableAliases,
                clearAssignedRoots,
                evolveAliases
            )
            // Issue #4216: preserve established unannotated IsNullOrEmpty
            // extensions while preferring explicit CLR nullability contracts.
            if MemberLookup.HasExtensionAttribute(call.Function.Method) &&
                !HasClrNullabilityContract(parameters.FirstOrDefault()) &&
                IsNullOrEmptyCompatibilityCandidate(call.Function.Name, parameters, call.Arguments) {
                result = MergeNotNullWhenFalseReceiver(
                    result,
                    call,
                    call.Arguments,
                    call.Arguments[0],
                    IsByRefArgument(
                        call.Arguments[0],
                        parameters.Length > 0 ? RefCapabilities.GetParameterRefKind(parameters[0]): RefKind.None
                    ),
                    negate,
                    restrictBareVariableToLocalsAndParams,
                    callableAliases,
                    clearAssignedRoots,
                    evolveAliases
                )
            }
            return result
        }

        private func ClassifyImportedMethodBoolCallNarrowing(
            call BoundExpression,
            parameters[]ParameterInfo,
            arguments ImmutableArray[BoundExpression],
            negate bool,
            restrictBareVariableToLocalsAndParams bool,
            callableAliases IReadOnlyCollection[VariableSymbol]?,
            clearAssignedRoots(
                (BoundNode, Dictionary[AccessPath, TypeSymbol], IReadOnlyCollection[VariableSymbol]?) -> void
            )?,
            evolveAliases((BoundExpression, HashSet[VariableSymbol]) -> HashSet[VariableSymbol])?
        )(Then Dictionary[AccessPath, TypeSymbol]?, Else Dictionary[AccessPath, TypeSymbol]?) {
            var thenFrame Dictionary[AccessPath, TypeSymbol]? = nil
            var elseFrame Dictionary[AccessPath, TypeSymbol]? = nil
            let count = Math.Min(parameters.Length, arguments.Length)
            for var i = 0; i < count; i++ {
                let parameter = parameters[i]
                let isByRef = IsByRefArgument(arguments[i], RefCapabilities.GetParameterRefKind(parameter))
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
                        (!restrictBareVariableToLocalsAndParams || widenVarExpr.Variable is LocalVariableSymbol) &&
                        !(widenVarExpr.Variable.Type is NullableTypeSymbol) &&
                        !widenVarExpr
                        .Variable
                        .Type
                        .IsValueType &&
                        NullabilityImportRule.ClassifyArgument(widenVarExpr.Variable.Type) != TypeArgumentKind.Value &&
                        widenVarExpr
                        .Variable
                        .Type != TypeSymbol
                        .Null {
                        let widenedType = NullableTypeSymbol.Get(widenVarExpr.Variable.Type)
                        let preserved = PreservesArgumentTarget(
                            call,
                            arguments,
                            i,
                            isByRef,
                            AccessPath.ForVariable(widenVarExpr.Variable),
                            widenedType,
                            callableAliases,
                            clearAssignedRoots,
                            evolveAliases
                        )
                        let widenThen = maybeNullWhenReturnValue != negate
                        if widenThen || !preserved {
                            thenFrame ??= Dictionary[AccessPath, TypeSymbol]()
                            thenFrame!![widenVarExpr.Variable] = widenedType
                        } else {
                            thenFrame ??= Dictionary[AccessPath, TypeSymbol]()
                            thenFrame!![widenVarExpr.Variable] = widenVarExpr.Variable.Type
                        }
                        if !widenThen || !preserved {
                            elseFrame ??= Dictionary[AccessPath, TypeSymbol]()
                            elseFrame!![widenVarExpr.Variable] = widenedType
                        } else {
                            elseFrame ??= Dictionary[AccessPath, TypeSymbol]()
                            elseFrame!![widenVarExpr.Variable] = widenVarExpr.Variable.Type
                        }
                    }
                    continue
                }
                if !ClrNullability.TryGetNotNullWhen(parameter, out var returnValue) ||
                    !TryGetNullableNarrowingTarget(
                    arguments[i],
                    restrictBareVariableToLocalsAndParams,
                    out var target,
                    out var underlying
                ) ||
                    !PreservesArgumentTarget(
                    call,
                    arguments,
                    i,
                    isByRef,
                    target!!,
                    underlying!!,
                    callableAliases,
                    clearAssignedRoots,
                    evolveAliases
                ) {
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

        private func ClassifyUserBoolCallNarrowing(
            call BoundCallExpression,
            negate bool,
            restrictBareVariableToLocalsAndParams bool,
            callableAliases IReadOnlyCollection[VariableSymbol]?,
            clearAssignedRoots(
                (BoundNode, Dictionary[AccessPath, TypeSymbol], IReadOnlyCollection[VariableSymbol]?) -> void
            )?,
            evolveAliases((BoundExpression, HashSet[VariableSymbol]) -> HashSet[VariableSymbol])?
        )(Then Dictionary[AccessPath, TypeSymbol]?, Else Dictionary[AccessPath, TypeSymbol]?) {
            let parameters = call.Function.Parameters
            var result = ClassifyUserMethodBoolCallNarrowing(
                call,
                parameters,
                call.Arguments,
                negate,
                restrictBareVariableToLocalsAndParams,
                callableAliases,
                clearAssignedRoots,
                evolveAliases
            )
            // Issue #4216: user extensions use the same compatibility rule as
            // imported extensions; an explicit receiver contract wins.
            if call
                .Function
                .IsExtension &&
                !HasUserNullabilityContract(parameters.FirstOrDefault()) &&
                IsNullOrEmptyCompatibilityCandidate(call.Function.Name, parameters, call.Arguments) {
                result = MergeNotNullWhenFalseReceiver(
                    result,
                    call,
                    call.Arguments,
                    call.Arguments[0],
                    IsByRefArgument(call.Arguments[0], parameters.Length > 0 ? parameters[0].RefKind: RefKind.None),
                    negate,
                    restrictBareVariableToLocalsAndParams,
                    callableAliases,
                    clearAssignedRoots,
                    evolveAliases
                )
            }
            return result
        }

        private func ClassifyUserMethodBoolCallNarrowing(
            call BoundExpression,
            parameters ImmutableArray[ParameterSymbol],
            arguments ImmutableArray[BoundExpression],
            negate bool,
            restrictBareVariableToLocalsAndParams bool,
            callableAliases IReadOnlyCollection[VariableSymbol]?,
            clearAssignedRoots(
                (BoundNode, Dictionary[AccessPath, TypeSymbol], IReadOnlyCollection[VariableSymbol]?) -> void
            )?,
            evolveAliases((BoundExpression, HashSet[VariableSymbol]) -> HashSet[VariableSymbol])?
        )(Then Dictionary[AccessPath, TypeSymbol]?, Else Dictionary[AccessPath, TypeSymbol]?) {
            // Issue #178 / ADR-0047 §6: a user-declared function may carry the
            // same [NotNullWhen] / [MaybeNullWhen] postconditions C# uses.
            // Recognition is type-identity based via KnownAttributes so renaming
            // or shadowing the source name cannot bypass the narrowing rule.
            var thenFrame Dictionary[AccessPath, TypeSymbol]? = nil
            var elseFrame Dictionary[AccessPath, TypeSymbol]? = nil
            let count = Math.Min(parameters.Length, arguments.Length)
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
                let argExpr = arguments[i]
                let isByRef = IsByRefArgument(argExpr, parameter.RefKind)
                // [NotNullWhen(rv)]: narrow a nullable argument to its underlying
                // non-nullable type on the arm where the call returns rv.
                if (notNullWhenReturnValue != nil) &&
                    TryGetNullableNarrowingTarget(
                    argExpr,
                    restrictBareVariableToLocalsAndParams,
                    out var target,
                    out var underlying
                ) &&
                    PreservesArgumentTarget(
                    call,
                    arguments,
                    i,
                    isByRef,
                    target!!,
                    underlying!!,
                    callableAliases,
                    clearAssignedRoots,
                    evolveAliases
                ) {
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
                let widenRawArg = if argExpr is BoundAddressOfExpression widenAddrOf {
                    widenAddrOf.Operand
                } else {
                    argExpr
                }
                let widenVarExpr BoundVariableExpression? = widenRawArg as BoundVariableExpression
                if (maybeNullWhenReturnValue != nil) &&
                    widenVarExpr != nil &&
                    (!restrictBareVariableToLocalsAndParams || widenVarExpr.Variable is LocalVariableSymbol) &&
                    !(widenVarExpr.Variable.Type is NullableTypeSymbol) &&
                    !widenVarExpr
                    .Variable
                    .Type
                    .IsValueType &&
                    NullabilityImportRule.ClassifyArgument(widenVarExpr.Variable.Type) != TypeArgumentKind.Value &&
                    widenVarExpr
                    .Variable
                    .Type != TypeSymbol
                    .Null {
                    let widenedType = NullableTypeSymbol.Get(widenVarExpr.Variable.Type)
                    let preserved = PreservesArgumentTarget(
                        call,
                        arguments,
                        i,
                        isByRef,
                        AccessPath.ForVariable(widenVarExpr.Variable),
                        widenedType,
                        callableAliases,
                        clearAssignedRoots,
                        evolveAliases
                    )
                    let widenThen = maybeNullWhenReturnValue != negate
                    if widenThen || !preserved {
                        thenFrame ??= Dictionary[AccessPath, TypeSymbol]()
                        thenFrame!![widenVarExpr.Variable] = widenedType
                    } else {
                        thenFrame ??= Dictionary[AccessPath, TypeSymbol]()
                        thenFrame!![widenVarExpr.Variable] = widenVarExpr.Variable.Type
                    }
                    if !widenThen || !preserved {
                        elseFrame ??= Dictionary[AccessPath, TypeSymbol]()
                        elseFrame!![widenVarExpr.Variable] = widenedType
                    } else {
                        elseFrame ??= Dictionary[AccessPath, TypeSymbol]()
                        elseFrame!![widenVarExpr.Variable] = widenVarExpr.Variable.Type
                    }
                }
            }
            return (Then: thenFrame, Else: elseFrame)
        }

        private func IsByRefArgument(argument BoundExpression, refKind RefKind) bool {
            if refKind is RefKind.Ref or RefKind.Out {
                return true
            }
            var unwrapped = argument
            while unwrapped is BoundConversionExpression conversion && IsFlowTransparentConversion(conversion) {
                unwrapped = conversion.Expression
            }
            return unwrapped is BoundAddressOfExpression{IsReadOnly: false} or BoundConditionalAddressExpression
        }

        private func EvolveCallAliasesBeforeArguments(
            call BoundExpression,
            callableAliases IReadOnlyCollection[VariableSymbol]?,
            evolveAliases((BoundExpression, HashSet[VariableSymbol]) -> HashSet[VariableSymbol])?
        ) HashSet[VariableSymbol] {
            var current = if callableAliases != nil {
                HashSet[VariableSymbol](callableAliases)
            } else {
                HashSet[VariableSymbol]()
            }
            if evolveAliases != nil {
                if call is BoundUserInstanceCallExpression userInstanceCall {
                    current = evolveAliases(userInstanceCall.Receiver, current)
                } else if call is BoundImportedInstanceCallExpression importedInstanceCall {
                    current = evolveAliases(importedInstanceCall.Receiver, current)
                }
            }
            return current
        }

        private func PreservesArgumentTarget(
            call BoundExpression,
            arguments ImmutableArray[BoundExpression],
            argumentIndex int32,
            isByRef bool,
            target AccessPath,
            narrowedType TypeSymbol,
            callableAliases IReadOnlyCollection[VariableSymbol]?,
            clearAssignedRoots(
                (BoundNode, Dictionary[AccessPath, TypeSymbol], IReadOnlyCollection[VariableSymbol]?) -> void
            )?,
            evolveAliases((BoundExpression, HashSet[VariableSymbol]) -> HashSet[VariableSymbol])?
        ) bool {
            if clearAssignedRoots == nil {
                return true
            }
            var currentAliases = EvolveCallAliasesBeforeArguments(call, callableAliases, evolveAliases)
            if evolveAliases != nil {
                for var j = 0; j <= argumentIndex && j < arguments.Length; j++ {
                    currentAliases = evolveAliases(arguments[j], currentAliases)
                }
            }
            if !isByRef {
                let candidateFrame = Dictionary[AccessPath, TypeSymbol]{[target] = narrowedType}
                for var j = argumentIndex + 1; j < arguments.Length; j++ {
                    clearAssignedRoots(arguments[j], candidateFrame, currentAliases)
                    if candidateFrame.Count == 0 {
                        return false
                    }
                    if evolveAliases != nil {
                        currentAliases = evolveAliases(arguments[j], currentAliases)
                    }
                }
                if BuildCallEffectsShell(call, argumentIndex, includeCallBody: true) is {} shell {
                    let rootFrame = Dictionary[AccessPath, TypeSymbol]{
                        [AccessPath.ForVariable(target.Root)] = target.Root.Type
                    }
                    clearAssignedRoots(shell, rootFrame, currentAliases)
                    if rootFrame.Count == 0 {
                        return false
                    }
                }
                return true
            }
            if evolveAliases != nil {
                for var j = argumentIndex + 1; j < arguments.Length; j++ {
                    currentAliases = evolveAliases(arguments[j], currentAliases)
                }
            }
            if BuildCallEffectsShell(call, argumentIndex, includeCallBody: false) is {} refShell {
                let rootFrame = Dictionary[AccessPath, TypeSymbol]{
                    [AccessPath.ForVariable(target.Root)] = target.Root.Type
                }
                clearAssignedRoots(refShell, rootFrame, currentAliases)
                if rootFrame.Count == 0 {
                    return false
                }
            }
            return true
        }

        private func PreservesReceiverPath(
            call BoundExpression,
            arguments ImmutableArray[BoundExpression],
            receiverPath AccessPath,
            receiverType TypeSymbol,
            callableAliases IReadOnlyCollection[VariableSymbol]?,
            clearAssignedRoots(
                (BoundNode, Dictionary[AccessPath, TypeSymbol], IReadOnlyCollection[VariableSymbol]?) -> void
            )?,
            evolveAliases((BoundExpression, HashSet[VariableSymbol]) -> HashSet[VariableSymbol])?
        ) bool {
            if clearAssignedRoots == nil {
                return true
            }
            var currentAliases = EvolveCallAliasesBeforeArguments(call, callableAliases, evolveAliases)
            let candidateFrame = Dictionary[AccessPath, TypeSymbol]{[receiverPath] = receiverType}
            for var j = 0; j < arguments.Length; j++ {
                clearAssignedRoots(arguments[j], candidateFrame, currentAliases)
                if candidateFrame.Count == 0 {
                    return false
                }
                if evolveAliases != nil {
                    currentAliases = evolveAliases(arguments[j], currentAliases)
                }
            }
            if BuildCallEffectsShell(call, excludeArgumentIndex: -1, includeCallBody: true) is {} shell {
                let rootFrame = Dictionary[AccessPath, TypeSymbol]{
                    [AccessPath.ForVariable(receiverPath.Root)] = receiverPath.Root.Type
                }
                clearAssignedRoots(shell, rootFrame, currentAliases)
                if rootFrame.Count == 0 {
                    return false
                }
            }
            return true
        }

        private func BuildCallEffectsShell(
            call BoundExpression,
            excludeArgumentIndex int32,
            includeCallBody bool
        ) BoundExpression? {
            switch call {
                case userCall is BoundCallExpression {
                    let bodyHasEffects = includeCallBody && !IsPureParameterNullCheckBody(userCall.Function)
                    let filtered = BuildFilteredRefArguments(
                        userCall.Arguments,
                        userCall.Function.Parameters,
                        excludeArgumentIndex,
                        includeCallBody: bodyHasEffects,
                        out var hasRefArgs
                    )
                    if !bodyHasEffects {
                        return if hasRefArgs {
                            BuildCompetingRefWritesShell(
                                userCall.Arguments,
                                userCall.Function.Parameters,
                                excludeArgumentIndex
                            )
                        } else {
                            default(BoundExpression?)
                        }
                    }
                    return BoundCallExpression(userCall.Syntax, userCall.Function, filtered)
                }
                case userInstanceCall is BoundUserInstanceCallExpression {
                    let bodyHasEffects = includeCallBody && !IsPureParameterNullCheckBody(userInstanceCall.Method)
                    let filtered = BuildFilteredRefArguments(
                        userInstanceCall.Arguments,
                        userInstanceCall.Method.Parameters,
                        excludeArgumentIndex,
                        includeCallBody: bodyHasEffects,
                        out var hasRefArgs
                    )
                    if !bodyHasEffects {
                        return if hasRefArgs {
                            BuildCompetingRefWritesShell(
                                userInstanceCall.Arguments,
                                userInstanceCall.Method.Parameters,
                                excludeArgumentIndex
                            )
                        } else {
                            default(BoundExpression?)
                        }
                    }
                    return BoundUserInstanceCallExpression(
                        userInstanceCall.Syntax,
                        BoundLiteralExpression(nil, 0, userInstanceCall.Receiver.Type),
                        userInstanceCall.Method,
                        filtered
                    )
                }
                case importedCall is BoundImportedCallExpression {
                    let bodyHasEffects = includeCallBody && !IsKnownPureImportedPredicate(importedCall.Function.Method)
                    let parameters = importedCall.Function.Method.GetParameters()
                    let filtered = BuildFilteredImportedRefArguments(
                        importedCall.Arguments,
                        parameters,
                        excludeArgumentIndex,
                        includeCallBody: bodyHasEffects,
                        out var hasRefArgs
                    )
                    if !bodyHasEffects {
                        return if hasRefArgs {
                            BuildCompetingImportedRefWritesShell(
                                importedCall.Arguments,
                                parameters,
                                excludeArgumentIndex
                            )
                        } else {
                            default(BoundExpression?)
                        }
                    }
                    return BoundImportedCallExpression(importedCall.Syntax, importedCall.Function, filtered)
                }
                case importedInstanceCall is BoundImportedInstanceCallExpression {
                    let parameters = importedInstanceCall.Method.GetParameters()
                    let filtered = BuildFilteredImportedRefArguments(
                        importedInstanceCall.Arguments,
                        parameters,
                        excludeArgumentIndex,
                        includeCallBody,
                        out var hasRefArgs
                    )
                    if !includeCallBody {
                        return if hasRefArgs {
                            BuildCompetingImportedRefWritesShell(
                                importedInstanceCall.Arguments,
                                parameters,
                                excludeArgumentIndex
                            )
                        } else {
                            default(BoundExpression?)
                        }
                    }
                    return BoundImportedInstanceCallExpression(
                        importedInstanceCall.Syntax,
                        BoundLiteralExpression(nil, 0, importedInstanceCall.Receiver.Type),
                        importedInstanceCall.Method,
                        importedInstanceCall.Type,
                        filtered
                    )
                }
                default {
                    return nil
                }
            }
        }

        private func BuildCompetingRefWriteStatement(argument BoundExpression) BoundStatement {
            var target = argument
            while target is BoundAddressOfExpression address {
                target = address.Operand
            }
            while target is BoundConversionExpression conversion {
                target = conversion.Expression
            }
            while target is BoundUnaryExpression{Op: {Kind: BoundUnaryOperatorKind.NullAssertion}} assertion {
                target = assertion.Operand
            }
            return BoundExpressionStatement(
                nil,
                BoundAddressOfExpression(nil, target, unmanaged: false, isReadOnly: false)
            )
        }

        private func BuildCompetingRefWritesShell(
            arguments ImmutableArray[BoundExpression],
            parameters ImmutableArray[ParameterSymbol],
            excludeArgumentIndex int32
        ) BoundExpression? {
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            for var i = 0; i < arguments.Length; i++ {
                let refKind = if i < parameters.Length {
                    parameters[i].RefKind
                } else {
                    RefKind.None
                }
                if i != excludeArgumentIndex && IsByRefArgument(arguments[i], refKind) {
                    statements.Add(BuildCompetingRefWriteStatement(arguments[i]))
                }
            }
            if statements.Count == 0 {
                return nil
            }
            return BoundBlockExpression(nil, statements.ToImmutable(), BoundLiteralExpression(nil, 0))
        }

        private func BuildCompetingImportedRefWritesShell(
            arguments ImmutableArray[BoundExpression],
            parameters[]ParameterInfo,
            excludeArgumentIndex int32
        ) BoundExpression? {
            let statements = ImmutableArray.CreateBuilder[BoundStatement]()
            for var i = 0; i < arguments.Length; i++ {
                let refKind = if i < parameters.Length {
                    RefCapabilities.GetParameterRefKind(parameters[i])
                } else {
                    RefKind.None
                }
                if i != excludeArgumentIndex && IsByRefArgument(arguments[i], refKind) {
                    statements.Add(BuildCompetingRefWriteStatement(arguments[i]))
                }
            }
            if statements.Count == 0 {
                return nil
            }
            return BoundBlockExpression(nil, statements.ToImmutable(), BoundLiteralExpression(nil, 0))
        }

        private func IsKnownPureImportedPredicate(method MethodInfo) bool -> (
            method.Name == "IsNullOrEmpty" || method.Name == "IsNullOrWhiteSpace"
        ) &&
            ClrTypeUtilities.AreSame(method.DeclaringType, typeof(string))

        private func IsPureParameterNullCheckBody(function FunctionSymbol) bool {
            if function.IsOpen ||
                function.IsOverride ||
                function.HasCaptures ||
                function.ReceiverType != nil ||
                function
                .Declaration
                ?.Body is not{} body {
                return false
            }
            for node in body.DescendantNodesAndSelf() {
                switch node {
                    case BlockStatementSyntax or
                        ReturnStatementSyntax or
                        ParenthesizedExpressionSyntax or
                        LiteralExpressionSyntax {
                        continue
                    }
                    case unary is UnaryExpressionSyntax when unary.OperatorToken.Kind == SyntaxKind.BangToken {
                        continue
                    }
                    case binary is BinaryExpressionSyntax when binary
                        .OperatorToken
                        .Kind is SyntaxKind.AmpersandAmpersandToken or
                        SyntaxKind.PipePipeToken {
                        continue
                    }
                    case binary is BinaryExpressionSyntax when(
                        binary.OperatorToken.Kind is SyntaxKind.EqualsEqualsToken or SyntaxKind.BangEqualsToken
                    ) &&
                        (IsNilLiteralSyntax(binary.Left) || IsNilLiteralSyntax(binary.Right)) {
                        continue
                    }
                    case name is NameExpressionSyntax when IsBuiltInNullableParameter(
                        function.Parameters,
                        name.IdentifierToken.ValueText
                    ) {
                        continue
                    }
                    default {
                        return false
                    }
                }
            }
            return true
        }

        private func IsNilLiteralSyntax(syntax ExpressionSyntax) bool {
            var current = syntax
            while current is ParenthesizedExpressionSyntax parenthesized {
                current = parenthesized.Expression
            }
            return current is LiteralExpressionSyntax literal && literal.LiteralToken.Kind == SyntaxKind.NilKeyword
        }

        private func IsBuiltInNullableParameter(parameters ImmutableArray[ParameterSymbol], name string) bool {
            for parameter in parameters {
                if parameter.Name == name {
                    let underlying = if parameter.Type is NullableTypeSymbol nullable {
                        nullable.UnderlyingType
                    } else {
                        parameter.Type
                    }
                    return underlying == TypeSymbol.String ||
                        underlying == TypeSymbol.Object ||
                        TypeSymbol.IsLegalPointeeType(underlying)
                }
            }
            return false
        }

        private func IsCallableEffectType(type TypeSymbol?) bool -> (
            type is FunctionTypeSymbol or DelegateTypeSymbol
        ) ||
            (type?.ClrType is {} clrType && ClrTypeUtilities.IsDelegateType(clrType))

        private func UnwrapCallableEffectArgument(expression BoundExpression) BoundExpression {
            var current = expression
            while current is BoundConversionExpression conversion {
                current = conversion.Expression
            }
            while current is BoundUnaryExpression{Op: {Kind: BoundUnaryOperatorKind.NullAssertion}} assertion {
                current = assertion.Operand
            }
            return current
        }

        private func BuildCallableShellArgument(argument BoundExpression) BoundExpression {
            let unwrapped = UnwrapCallableEffectArgument(argument)
            if unwrapped is BoundFunctionLiteralExpression literal {
                return literal
            }
            if unwrapped is BoundAssignmentExpression assign &&
                UnwrapCallableEffectArgument(assign.Expression) is BoundFunctionLiteralExpression assignedLiteral {
                return assignedLiteral
            }
            if unwrapped is BoundVariableExpression variable {
                return variable
            }
            let unknownCallable = LocalVariableSymbol("<callable-arg>", isReadOnly: false, argument.Type)
            return BoundVariableExpression(nil, unknownCallable)
        }

        private func BuildFilteredRefArguments(
            arguments ImmutableArray[BoundExpression],
            parameters ImmutableArray[ParameterSymbol],
            excludeArgumentIndex int32,
            includeCallBody bool,
            out hasRefArgs bool
        ) ImmutableArray[BoundExpression] {
            hasRefArgs = false
            if arguments.IsDefaultOrEmpty {
                return ImmutableArray[BoundExpression].Empty
            }
            let builder = ImmutableArray.CreateBuilder[BoundExpression](arguments.Length)
            for var i = 0; i < arguments.Length; i++ {
                let refKind = if i < parameters.Length {
                    parameters[i].RefKind
                } else {
                    RefKind.None
                }
                if i != excludeArgumentIndex && IsByRefArgument(arguments[i], refKind) {
                    hasRefArgs = true
                    builder.Add(arguments[i])
                } else if includeCallBody && IsCallableEffectType(arguments[i].Type) {
                    builder.Add(BuildCallableShellArgument(arguments[i]))
                } else if refKind is RefKind.Ref or RefKind.Out {
                    let placeholder = LocalVariableSymbol("<excluded-ref>", isReadOnly: false, TypeSymbol.Int32)
                    builder.Add(BoundVariableExpression(nil, placeholder))
                } else {
                    builder.Add(BoundLiteralExpression(nil, 0, TypeSymbol.Int32))
                }
            }
            return builder.MoveToImmutable()
        }

        private func BuildFilteredImportedRefArguments(
            arguments ImmutableArray[BoundExpression],
            parameters[]ParameterInfo,
            excludeArgumentIndex int32,
            includeCallBody bool,
            out hasRefArgs bool
        ) ImmutableArray[BoundExpression] {
            hasRefArgs = false
            if arguments.IsDefaultOrEmpty {
                return ImmutableArray[BoundExpression].Empty
            }
            let builder = ImmutableArray.CreateBuilder[BoundExpression](arguments.Length)
            for var i = 0; i < arguments.Length; i++ {
                let refKind = if i < parameters.Length {
                    RefCapabilities.GetParameterRefKind(parameters[i])
                } else {
                    RefKind.None
                }
                if i != excludeArgumentIndex && IsByRefArgument(arguments[i], refKind) {
                    hasRefArgs = true
                    builder.Add(arguments[i])
                } else if includeCallBody && IsCallableEffectType(arguments[i].Type) {
                    builder.Add(BuildCallableShellArgument(arguments[i]))
                } else if refKind is RefKind.Ref or RefKind.Out {
                    let placeholder = LocalVariableSymbol("<excluded-ref>", isReadOnly: false, TypeSymbol.Int32)
                    builder.Add(BoundVariableExpression(nil, placeholder))
                } else {
                    builder.Add(BoundLiteralExpression(nil, 0, TypeSymbol.Int32))
                }
            }
            return builder.MoveToImmutable()
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
            call BoundExpression,
            arguments ImmutableArray[BoundExpression],
            receiver BoundExpression,
            isByRef bool,
            negate bool,
            restrictBareVariableToLocalsAndParams bool,
            callableAliases IReadOnlyCollection[VariableSymbol]?,
            clearAssignedRoots(
                (BoundNode, Dictionary[AccessPath, TypeSymbol], IReadOnlyCollection[VariableSymbol]?) -> void
            )?,
            evolveAliases((BoundExpression, HashSet[VariableSymbol]) -> HashSet[VariableSymbol])?
        )(Then Dictionary[AccessPath, TypeSymbol]?, Else Dictionary[AccessPath, TypeSymbol]?) {
            if !TryGetNullableNarrowingTarget(
                receiver,
                restrictBareVariableToLocalsAndParams,
                out var target,
                out var underlying
            ) {
                return frames
            }
            if !PreservesArgumentTarget(
                call,
                arguments,
                0,
                isByRef,
                target,
                underlying,
                callableAliases,
                clearAssignedRoots,
                evolveAliases
            ) {
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
            restrictBareVariableToLocalsAndParams bool,
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
                if !restrictBareVariableToLocalsAndParams || bve.Variable is LocalVariableSymbol {
                    AccessPath.ForVariable(bve.Variable)
                } else {
                    default(AccessPath?)
                }
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
