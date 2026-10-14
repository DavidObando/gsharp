// <copyright file="CSharpToGSharpTranslator.ControlFlow.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Operations
import Microsoft.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq

partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        /// Lowers a `while`/`do-while` whose condition carries an
        /// `is`-pattern clause that would otherwise duplicate a side-effecting
        /// scrutinee or leak a binder the G# loop body cannot see (issue #914).
        ///
        /// C# allows a loop condition such as
        /// `M(out var n) is Frame child and not EmptyFrame`, binding
        /// `child`/`n` for the loop body. G# has no `and`/`not`
        /// pattern combinators (only `&&`/`!`), so the combinator
        /// lowering re-emits the scrutinee per sub-test — re-running the call and
        /// re-declaring `out var n` (→ GS0102). Pattern/out-var bindings
        /// that cannot use native `while let` are also invisible in an
        /// ordinary G# `while` body (GS0125).
        ///
        /// The condition is split on its top-level `&&` clauses. The
        /// leading side-effect-free clauses stay the real loop condition; from the
        /// first clause that binds or duplicates a side-effecting scrutinee onward,
        /// each clause is hoisted to the top of the loop body — the scrutinee
        /// evaluated once into a local, the remaining must-hold tests converted to
        /// `if !test { break }` guards:
        /// ```
        /// while a && b && M(out var n) is Frame child and not EmptyFrame { … }
        /// // becomes
        /// while a && b {
        /// let child = M(out var n)
        /// if child is EmptyFrame { break }
        /// …
        /// }
        /// ```
        /// Returns `false` (keep the plain `while cond { }`
        /// form) when no clause needs hoisting, so simple loops are unaffected.
        private func TryTranslateLoopWithConditionHoist(
            condition ExpressionSyntax,
            bodyStatement StatementSyntax,
            isDoWhile bool,
            out result IReadOnlyList[GStatement]?
        ) bool {
            result = nil
            // ADR-0166: a loop condition whose designations are native pattern
            // variables stays a plain `for cond { }`; the body sees the
            // when-true variables directly.
            if this.ConditionUsesNativePatternVariables(condition) {
                return false
            }
            if !isDoWhile && this.TryBuildWhileLetLoop(condition, bodyStatement, out var whileLet) {
                result = whileLet
                return true
            }
            if !this.TryBuildHoistedLoopCondition(
                condition,
                out var loopCondition,
                out var hoisted,
                out var hoistsAssignment
            ) {
                return false
            }
            if isDoWhile && hoistsAssignment && BodyContainsOwnLoopContinue(bodyStatement) {
                // The tail-appended hoist runs where C# evaluates `cond` — AFTER the
                // body. But G# `do`/`while` lowers `continue` to a goto that lands
                // right after the whole body (ADR-0070's continueLabel), which is
                // now past the hoisted tail too. A `continue` targeting this loop
                // would therefore skip the hoisted assignment/break-guard, silently
                // re-using a stale value instead of re-evaluating it (issue #1723).
                // Plain `while` is unaffected: its hoist leads the body, so
                // `continue` re-enters it on the next iteration.
                this.context.ReportUnsupported(
                    condition,
                    "assignment inside a short-circuited '&&'/'||' operand or a conditional ('?:') branch has no side-effect-preserving G# lowering yet (issue #1723)."
                )
                return false
            }
            let originalBody = this.TranslateStatementAsBlock(bodyStatement)
            let bodyStatements = List[GStatement]()
            if isDoWhile {
                // C# `do { body } while (cond)` evaluates `cond` AFTER the body runs,
                // so the hoisted assignment/break-guard must trail the body (not lead
                // it), or the first body iteration would observe a write that hasn't
                // happened yet (issue #1723).
                bodyStatements.AddRange(originalBody.Statements)
                bodyStatements.AddRange(hoisted!!)
            } else {
                bodyStatements.AddRange(hoisted!!)
                bodyStatements.AddRange(originalBody.Statements)
            }
            let body = BlockStatement(bodyStatements)
            result = if isDoWhile {
                []GStatement{DoWhileStatement(body, GuardBlockCondition(loopCondition!!))}
            } else {
                []GStatement{WhileStatement(GuardBlockCondition(loopCondition!!), body)}
            }
            return true
        }

        /// Splits [`condition`](paramref) into its top-level `&&` clauses and,
        /// if any clause needs hoisting (an `is`-pattern requiring a scrutinee
        /// local, or a value-position assignment), returns the leading
        /// side-effect-free clauses as [`loopCondition`](paramref) and the
        /// rest as body-prologue [`hoisted`](paramref) statements (a scrutinee
        /// local / hoisted assignment plus `if !test { break }` guards) — shared by
        /// `while`, `do`/`while`, and `for` loop translation (issue #914, #1723).
        /// Returns `false` (no hoisting needed) when every clause is plain.
        private func TryBuildHoistedLoopCondition(
            condition ExpressionSyntax?,
            out loopCondition GExpression?,
            out hoisted List[GStatement]?,
            out hoistsAssignment bool
        ) bool {
            loopCondition = nil
            hoisted = nil
            hoistsAssignment = false
            let clauses = List[ExpressionSyntax]()
            FlattenAndClauses(condition, clauses)
            var firstHoist = -1
            for var i = 0; i < clauses.Count; i++ {
                if this.ClauseRequiresConditionHoist(clauses[i]) {
                    firstHoist = i
                    break
                }
            }
            if firstHoist < 0 {
                return false
            }
            for var i = firstHoist; i < clauses.Count; i++ {
                if ClauseContainsAssignment(clauses[i]) {
                    hoistsAssignment = true
                    break
                }
            }
            // The leading side-effect-free clauses remain the real loop condition.
            var combined GExpression? = nil
            for var i = 0; i < firstHoist; i++ {
                let clause GExpression? = this.TranslateExpression(clauses[i])
                combined = if combined == nil {
                    clause
                } else {
                    cast[GExpression](BinaryExpression(combined, "&&", clause))
                }
            }
            combined ??= LiteralExpression.Bool(true)
            // The remaining clauses hoist to the top of the loop body as a single
            // scrutinee evaluation / assignment plus `if !test { break }` guards.
            let prologue = List[GStatement]()
            for var i = firstHoist; i < clauses.Count; i++ {
                this.HoistLoopConditionClause(clauses[i], prologue)
            }
            loopCondition = combined
            hoisted = prologue
            return true
        }

        // A loop-condition clause needs hoisting when it declares an `out var`
        // more than once (GS0102), or binds a pattern variable the G# loop body
        // cannot see (GS0125); or when it contains one of the few assignment
        // shapes that still lacks a native value-position form.
        private func ClauseRequiresConditionHoist(clause ExpressionSyntax) bool {
            return (
                clause is IsPatternExpressionSyntax isPattern &&
                    (
                    (
                        PatternIntroducesBinding(isPattern.Pattern) && !this.ConditionUsesNativePatternVariables(
                            GetConditionRoot(isPattern)
                        )
                    ) ||
                        ExpressionDeclaresOutVar(isPattern.Expression)
                )
            ) ||
                ClauseContainsAssignment(clause)
        }

        // Emits the fallback statements for a loop-condition clause that still
        // needs body scope: deconstruction assignments and binding patterns.
        private func HoistLoopConditionClause(clause ExpressionSyntax, into List[GStatement]) {
            // Any spill hoisted while translating `clause` (issue #1731 — e.g. a
            // non-trivial pattern scrutinee nested inside the
            // condition) must land in `into`, which runs at the START of each loop
            // iteration — NOT in the enclosing loop STATEMENT's own prologue (that
            // would evaluate the operand once, before the loop, instead of once
            // per iteration as C# does).
            let outerSpillPrologue List[GStatement]? = this.state.PendingSpillPrologue
            this.state.PendingSpillPrologue = into
            try {
                this.HoistLoopConditionClauseCore(clause, into)
            } finally {
                this.state.PendingSpillPrologue = outerSpillPrologue
            }
        }

        private func HoistLoopConditionClauseCore(clause ExpressionSyntax, into List[GStatement]) {
            if clause is not IsPatternExpressionSyntax isPattern {
                let replacements = List[ExpressionSyntax]()
                let embedded = this.HoistAssignmentsInOrder(clause, includeSelf: true, into, replacements)
                if embedded.Count == 0 {
                    into.Add(BreakIf(Negate(this.TranslateExpression(clause))))
                    return
                }
                try {
                    into.Add(BreakIf(Negate(this.TranslateExpression(clause))))
                } finally {
                    this.ReleaseHoistedAssignments(embedded, replacements)
                }
                return
            }
            let receiver GExpression? = this.TranslateExpression(isPattern.Expression)
            let scrutineeType ITypeSymbol? = this.context.GetTypeInfo(isPattern.Expression).Type
            // The hoist local reuses a top-level binder's name when present (so body
            // references to that binder print as the hoist local); otherwise a fresh
            // synthetic name is used.
            let mainBinder ILocalSymbol? = this.FindMainPatternBinder(isPattern.Pattern)
            var hoistName string?
            if mainBinder != nil {
                hoistName = this.EmittedName(mainBinder, mainBinder.Name)
            } else {
                do {
                    hoistName = "__scrutinee${this.state.LoopHoistCounter}"
                    this.state.LoopHoistCounter++
                } while !this.TryClaimSynthesizedLocalName(hoistName, clause)
            }
            let binding = if mainBinder != nil && this.IsLocalReassigned(mainBinder) {
                BindingKind.Var
            } else {
                BindingKind.Let
            }
            into.Add(LocalDeclarationStatement(binding, hoistName, type: nil, initializer: receiver))
            let idExpr = IdentifierExpression(hoistName)
            // Any secondary binder prints as the hoist local inside the body.
            for binder in this.EnumeratePatternBinders(isPattern.Pattern) {
                if !SymbolEqualityComparer.Default.Equals(binder, mainBinder) {
                    this.state.PatternBindings[binder] = idExpr
                }
            }
            this.EmitMustHoldGuards(idExpr, scrutineeType, isPattern.Pattern, mainBinder, into)
        }

        // Converts a must-hold pattern over the already-hoisted `idExpr` into a list
        // of `if !test { break }` guards. An `and` combinator splits into one guard
        // per side; a `not P` breaks when `P` matches; the main binder whose static
        // type already satisfies its type test is a bind-only (no guard).
        private func EmitMustHoldGuards(
            idExpr GExpression,
            scrutineeType ITypeSymbol?,
            pattern PatternSyntax,
            mainBinder ILocalSymbol?,
            into List[GStatement]
        ) {
            switch pattern {
                case parenthesized is ParenthesizedPatternSyntax {
                    this.EmitMustHoldGuards(idExpr, scrutineeType, parenthesized.Pattern, mainBinder, into)
                    return
                }
                case andPattern is BinaryPatternSyntax when andPattern.OperatorToken.IsKind(SyntaxKind.AndKeyword) {
                    this.EmitMustHoldGuards(idExpr, scrutineeType, andPattern.Left, mainBinder, into)
                    this.EmitMustHoldGuards(idExpr, scrutineeType, andPattern.Right, mainBinder, into)
                    return
                }
                case notPattern is UnaryPatternSyntax when notPattern.IsKind(SyntaxKind.NotPattern) {
                    // `not P` must hold → break when `P` matches.
                    into.Add(BreakIf(this.TranslatePatternTest(idExpr, notPattern.Pattern, scrutineeType)))
                    return
                }
                case declaration is DeclarationPatternSyntax when this.IsBindOnlyMainBinder(
                    declaration,
                    scrutineeType,
                    mainBinder
                ) {
                    // The main binder whose static type already satisfies the test is
                    // a non-null bind (e.g. a method returning a non-null `Frame`); no
                    // guard is needed and the binder prints as the hoist local.
                    return
                }
                case declaration is DeclarationPatternSyntax {
                    // A secondary type-binder: emit the type test as a break guard;
                    // references to the binder print as the hoist local (registered by
                    // HoistLoopConditionClause).
                    into.Add(BreakIf(Negate(this.BuildTypeTestExpression(idExpr, declaration.Type, declaration))))
                    return
                }
                default {
                    into.Add(BreakIf(Negate(this.TranslatePatternTest(idExpr, pattern, scrutineeType))))
                    return
                }
            }
        }

        // True when `declaration` binds the hoist local and the scrutinee's static
        // type already (non-nullably) satisfies the declared type — so the type test
        // is statically true and the pattern is a pure binding.
        private func IsBindOnlyMainBinder(
            declaration DeclarationPatternSyntax,
            scrutineeType ITypeSymbol?,
            mainBinder ILocalSymbol?
        ) bool {
            if mainBinder == nil ||
                declaration.Designation is not SingleVariableDesignationSyntax single ||
                this
                .context
                .GetDeclaredSymbol(single) is not ILocalSymbol symbol || !SymbolEqualityComparer.Default.Equals(
                symbol,
                mainBinder
            ) {
                return false
            }
            let target ITypeSymbol? = this.context.GetTypeInfo(declaration.Type).Type
            return IsAssignableNonNull(scrutineeType, target)
        }

        private func FindMainPatternBinder(pattern PatternSyntax) ILocalSymbol? -> this.EnumeratePatternBinders(pattern)
            .FirstOrDefault()

        private func EnumeratePatternBinders(pattern PatternSyntax) sequence[ILocalSymbol] {
            for node in pattern.DescendantNodesAndSelf() {
                if node is SingleVariableDesignationSyntax single && this.context.GetDeclaredSymbol(
                    single
                ) is ILocalSymbol symbol {
                    yield symbol
                }
            }
        }

        /// Translates an `if` statement into one or more G# statements. A C#
        /// negated type-pattern guard with a designation (`if (x is not T t) {
        /// throw/return; }`) needs the binder `t` to remain in scope *after*
        /// the `if` (the then-block exits), and a property-path receiver cannot
        /// be smart-cast — so it is lowered to a hoisted nullable local plus a
        /// nil-guard ((cref:TryBuildNegatedGuardHoist)). Every other form maps
        /// to the single-statement (cref:TranslateIf).
        private func TranslateIfStatements(ifStatement IfStatementSyntax) IEnumerable[GStatement]? {
            // ADR-0166 / issue #3409: when every `is` designation in the condition
            // is a native G# pattern variable, the plain `if` keeps the C# shape
            // and names; the `if let` / guard-hoist lowerings below only serve
            // conditions the native scoping cannot express.
            if this.ConditionUsesNativePatternVariables(ifStatement.Condition) {
                return []GStatement{this.TranslateIf(ifStatement)}
            }
            // Issue #3359: `if (recv is { } name) { … }` has a canonical G# form —
            // the ADR-0071 `if let` statement — that binds the name at its
            // non-null type and evaluates `recv` exactly once by construction.
            // Tried FIRST because the general pattern lowering would otherwise
            // spill `recv` into a `let __spillN`, destroying the author's binder
            // name and adding a `!!` at every read. The helper is conservative
            // and translates nothing when it declines.
            if this.TryBuildIfLetGuard(ifStatement, out var ifLetHoisted) {
                return ifLetHoisted
            }
            if this.TryBuildNegatedGuardHoist(ifStatement, out var hoisted) {
                return hoisted
            }
            if this.TryBuildPositiveGuardHoist(ifStatement, out var positiveHoisted) {
                return positiveHoisted
            }
            return this.TranslateIfWithConditionPrologue(ifStatement)
        }

        private func TranslateElseStatement(statement StatementSyntax) GStatement {
            if statement is not IfStatementSyntax elseIf {
                return this.TranslateStatementAsBlock(statement)
            }
            let translated = this.TranslateIfStatements(elseIf)!!.ToList()
            return if translated.Count == 1 {
                translated[0]
            } else {
                cast[GStatement](BlockStatement(translated))
            }
        }

        /// Lowers a C# positive type-pattern guard `if (receiver is T t) { … }`
        /// to a smart-cast-friendly G# local that preserves the declaration
        /// variable's identity.
        /// ```
        /// let t T? = receiver as T   // reference target
        /// if t != nil { … }
        ///
        /// let __spill0 = receiver    // value target
        /// var t T
        /// if __spill0 is T { t = T(__spill0); … }
        /// ```
        /// Value-pattern binders use a separate typed local so their reads do not
        /// rely on flow narrowing through an enclosing try/block. Reference targets
        /// retain the nullable-local lowering used for G# nil narrowing.
        ///
        /// Issue #4173 round 3: adapts a guard-hoist's plain `let t T? =
        /// receiver as T; if t != nil` scheme for one of the three shared-
        /// node analyzer types ((cref:IsPlainAccessAnalyzerType) /
        /// (cref:IsConditionalAccessAnalyzerType)), which every
        /// guard-hoist site ((cref:TryBuildPositiveGuardHoist),
        /// (cref:TryBuildNegatedGuardHoist),
        /// (cref:TryBuildMultipleNegatedGuardHoists)) otherwise reaches
        /// via a direct, unguarded `this.MapTypeSyntax(typeSyntax)` call
        /// that bypasses the discriminator/predicate entirely — the exact
        /// bug class this round fixes, reintroduced at the hoist level if left
        /// unhandled. CAE has no castable G# type at all (its faithful
        /// rewrite is the ALREADY-NULLABLE `AsNullConditionalHop`
        /// predicate, which drops straight into the existing hoist shape
        /// unchanged); a plain-access type keeps the ordinary `as`-cast
        /// but needs an extra `IsNullConditional` guard conjunct, which
        /// [`requiresNotNullConditional`](paramref) tells the caller to add
        /// (with the polarity appropriate to a POSITIVE guard — a negated
        /// caller inverts it).
        /// @param typeSyntax The pattern's tested type.
        /// @param receiver The translated scrutinee.
        /// @param targetType The hoisted local's non-nullable G# type.
        /// @param initializer The hoisted local's initializer expression.
        /// @param requiresNotNullConditional True when the caller must additionally guard on the hoisted
        /// local's `IsNullConditional` flag.
        /// @returns True when [`typeSyntax`](paramref) is one of the three shared-node types.
        private func TryBuildSharedNodeGuardHoistPieces(
            typeSyntax TypeSyntax?,
            receiver GExpression?,
            out targetType GTypeReference?,
            out initializer GExpression?,
            out requiresNotNullConditional bool
        ) bool {
            initializer = nil
            if !this.TryResolveSharedNodeGuardHoistType(
                typeSyntax,
                out targetType,
                out var isConditionalAccess,
                out requiresNotNullConditional
            ) {
                return false
            }
            initializer = if isConditionalAccess {
                this.InvokeNullConditionalChain("AsNullConditionalHop", receiver)
            } else {
                cast[GExpression](BinaryExpression(receiver, "as", TypeExpression(targetType)))
            }
            return true
        }

        /// The receiver-independent half of (cref:TryBuildSharedNodeGuardHoistPieces) —
        /// used by the `if let` family (`CSharpToGSharpTranslator.IfLet.cs`),
        /// whose eligibility checks resolve the target type before the
        /// receiver is translated.
        /// @param typeSyntax The pattern's tested type.
        /// @param targetType The hoisted local's non-nullable G# type.
        /// @param isConditionalAccess True when [`typeSyntax`](paramref) is the CAE type.
        /// @param requiresNotNullConditional True when the caller must additionally guard on the hoisted
        /// local's `IsNullConditional` flag.
        /// @returns True when [`typeSyntax`](paramref) is one of the three shared-node types.
        private func TryResolveSharedNodeGuardHoistType(
            typeSyntax TypeSyntax?,
            out targetType GTypeReference?,
            out isConditionalAccess bool,
            out requiresNotNullConditional bool
        ) bool {
            targetType = nil
            isConditionalAccess = false
            requiresNotNullConditional = false
            if this.IsConditionalAccessAnalyzerType(typeSyntax) {
                targetType = NamedTypeReference("ExpressionSyntax")
                isConditionalAccess = true
                return true
            }
            if this.IsPlainAccessAnalyzerType(typeSyntax, out var gsNodeName) {
                targetType = NamedTypeReference(gsNodeName)
                requiresNotNullConditional = true
                return true
            }
            return false
        }

        private func TryBuildPositiveGuardHoist(
            ifStatement IfStatementSyntax,
            out result IReadOnlyList[GStatement]?
        ) bool {
            result = nil
            DecomposeConjunction(ifStatement.Condition, out var leftmost, out var guards)
            if leftmost is not IsPatternExpressionSyntax isPattern ||
                !TryExtractSingleVarTypePattern(isPattern.Pattern, out var typeSyntax, out var single) {
                return false
            }
            if guards.Any(
                ($guard ExpressionSyntax) -> ContainsSpillHoistingConstruct($guard, includeOutVarDeclarations: false)
            ) {
                return false
            }
            let targetSymbol ITypeSymbol? = this.context.GetTypeInfo(typeSyntax).Type
            if targetSymbol == nil {
                return false
            }
            if this.context.GetDeclaredSymbol(single) is not ILocalSymbol patternSymbol {
                return false
            }
            let localName string? = this.EmittedName(single, single!!.Identifier)
            let receiver GExpression? = this.TranslateExpression(isPattern.Expression)
            // Issue #4173 round 3: a shared-node analyzer type has no room for
            // its IsNullConditional discriminator (or, for CAE, is not even a
            // castable G# type at all — its faithful rewrite is the
            // AsNullConditionalHop PREDICATE) in the plain `receiver as T`
            // this hoist otherwise emits. AsNullConditionalHop is already
            // nullable (nil when receiver is not a hop, the hop itself when it
            // is), so it drops straight into the existing `let t T? = <init>;
            // if t != nil` shape unchanged; a plain-access type keeps the
            // ordinary `as`-cast but needs an extra `!t.IsNullConditional`
            // guard conjunct.
            let isSharedNode = this.TryBuildSharedNodeGuardHoistPieces(
                typeSyntax,
                receiver,
                out var sharedTargetType,
                out var sharedInitializer,
                out var requiresNotNullConditional
            )
            let targetType GTypeReference? = if isSharedNode {
                sharedTargetType
            } else {
                this.MapTypeSyntax(typeSyntax)
            }
            if !isSharedNode && targetSymbol.IsValueType {
                result = this.BuildPositiveValueGuardHoist(ifStatement, guards, localName, targetType, receiver)
                return true
            }
            // Record that this pattern variable is now a nullable G# local so an
            // assignment-LHS use inside the guard is null-forgiven (gsc narrows
            // reads but not write receivers).
            this.state.HoistedNullableGuardLocals.Add(patternSymbol)
            // `var t T? = receiver as T` when the leaked variable is reassigned
            // anywhere in the body (C# allows it); otherwise an immutable `let`.
            let binding = if this.IsLocalReassigned(patternSymbol) {
                BindingKind.Var
            } else {
                BindingKind.Let
            }
            let local = IdentifierExpression(localName)
            let localType GTypeReference? = MakeNullable(targetType)
            let initializer GExpression? = if isSharedNode {
                sharedInitializer
            } else {
                cast[GExpression](BinaryExpression(receiver, "as", TypeExpression(targetType)))
            }
            let hoist = LocalDeclarationStatement(binding, localName, localType, initializer)
            var guard_ GExpression = BinaryExpression(local, "!=", LiteralExpression.Null())
            if requiresNotNullConditional {
                guard_ = BinaryExpression(
                    guard_,
                    "&&",
                    UnaryExpression("!", MemberAccessExpression(local, "IsNullConditional", isArrow: false))
                )
            }
            for conjunct in guards {
                guard_ = BinaryExpression(guard_, "&&", this.TranslateExpression(conjunct))
            }
            let then = this.TranslateStatementAsBlock(ifStatement.Statement)
            var elseBranch GStatement? = nil
            if ifStatement.Else != nil {
                elseBranch = this.TranslateElseStatement(ifStatement.Else!!.Statement)
            }
            // gsc narrows `local` throughout the guarded block, but does not carry
            // that fact past the `if` when an exiting `else` makes C#'s pattern
            // variable definitely assigned afterward. Keep later reads tied to
            // the named local and materialize the already-proven target view.
            if targetSymbol.IsValueType && targetType is NamedTypeReference namedTarget {
                this
                    .state
                    .PatternBindings[patternSymbol] = InvocationExpression(
                    IdentifierExpression(namedTarget.Name),
                    []IdentifierExpression{local},
                    namedTarget.TypeArguments
                )
            } else {
                this.state.PatternBindings[patternSymbol] = NonNullAssertionExpression(local)
            }
            result = []GStatement{hoist, IfStatement(guard_, then, elseBranch)}
            if elseBranch != nil {
                this.ReportPatternGuardControlTransferMismatch(ifStatement, result, []GStatement{then, elseBranch})
            }
            return true
        }

        private func BuildPositiveValueGuardHoist(
            ifStatement IfStatementSyntax,
            guards IReadOnlyList[ExpressionSyntax],
            localName string?,
            targetType GTypeReference?,
            receiver GExpression?
        ) IReadOnlyList[GStatement] {
            // Issue #3360: only a non-trivial receiver needs spilling. The
            // scrutinee is read twice below — once by the `is` guard and once by
            // the narrowing conversion — but a bare local/parameter/`this`/literal
            // is safe to duplicate, so spilling it only adds a `__spillN` nobody
            // needs. This mirrors `SpillOperand`'s own `IsTrivialOperand` check,
            // which this site bypassed by emitting the temp directly.
            //
            // The temp is NOT named after the C# binder (as
            // `HoistLoopConditionClauseCore` does): that name is already taken by
            // the typed binder local below. Collapsing the two into one smart-cast
            // local would free the name, but the separate typed local is
            // deliberate — see this method's summary — so that binder reads do not
            // depend on flow narrowing surviving an enclosing try/block.
            var scrutinee GExpression? = receiver
            var hoist LocalDeclarationStatement? = nil
            if !IsTrivialOperand(receiver!!) {
                let spillName = this.NewSpillName()
                scrutinee = IdentifierExpression(spillName)
                hoist = LocalDeclarationStatement(BindingKind.Let, spillName, type: nil, initializer: receiver)
            }
            let spill GExpression? = scrutinee
            let binder = LocalDeclarationStatement(BindingKind.Var, localName, targetType)
            let guard_ = BinaryExpression(spill, "is", TypeExpression(targetType))
            let narrowed GExpression = if targetType is NamedTypeReference namedTarget {
                cast[GExpression](
                    InvocationExpression(
                        IdentifierExpression(namedTarget.Name),
                        []GExpression{spill!!},
                        namedTarget.TypeArguments
                    )
                )
            } else {
                cast[GExpression](NonNullAssertionExpression(spill))
            }
            let thenStatements = List[GStatement]{AssignmentStatement(IdentifierExpression(localName), narrowed)}
            let elseBranch GStatement? = if ifStatement.Else == nil {
                default(GStatement?)
            } else {
                this.TranslateElseStatement(ifStatement.Else!!.Statement)
            }
            let body = this.TranslateStatementAsBlock(ifStatement.Statement)
            if guards.Count == 0 {
                thenStatements.AddRange(body.Statements)
            } else if elseBranch == nil {
                var guardExpression GExpression? = nil
                for guardClause in guards {
                    let translated GExpression? = this.TranslateExpression(guardClause)
                    guardExpression = if guardExpression == nil {
                        translated
                    } else {
                        cast[GExpression](BinaryExpression(guardExpression, "&&", translated))
                    }
                }
                thenStatements.Add(IfStatement(guardExpression, body, elseBranch))
            } else {
                var guardExpression GExpression? = nil
                for guardClause in guards {
                    let translated GExpression? = this.TranslateExpression(guardClause)
                    guardExpression = if guardExpression == nil {
                        translated
                    } else {
                        cast[GExpression](BinaryExpression(guardExpression, "&&", translated))
                    }
                }
                let endLabel = this.SyntheticLabelName("patternGuardEnd", ifStatement)
                let matchedBody = body.Statements.ToList()
                matchedBody.Add(GotoStatement(endLabel))
                thenStatements.Add(IfStatement(guardExpression, BlockStatement(matchedBody)))
                let guardedStatements = List[GStatement]()
                if hoist != nil {
                    guardedStatements.Add(hoist)
                }
                guardedStatements.Add(binder)
                guardedStatements.Add(IfStatement(guard_, BlockStatement(thenStatements)))
                guardedStatements.Add(elseBranch)
                guardedStatements.Add(LabeledStatement(endLabel, BlockStatement(List[GStatement]())))
                this.ReportPatternGuardControlTransferMismatch(
                    ifStatement,
                    guardedStatements,
                    []GStatement{body, elseBranch}
                )
                return guardedStatements
            }
            let statements = List[GStatement]()
            if hoist != nil {
                statements.Add(hoist)
            }
            statements.Add(binder)
            statements.Add(
                IfStatement(
                    guard_,
                    BlockStatement(thenStatements),
                    if guards.Count == 0 {
                        elseBranch
                    } else {
                        default(GStatement?)
                    }
                )
            )
            if elseBranch != nil {
                this.ReportPatternGuardControlTransferMismatch(ifStatement, statements, []GStatement{body, elseBranch})
            }
            return statements
        }

        /// A scrutinee is smart-castable by gsc only when it is a bare local or
        /// parameter reference; gsc narrows locals, not method-call results,
        /// member-access chains, or field references (ADR-0069). When the scrutinee
        /// is not smart-castable, an `x is T t` whose binder is used in the
        /// guarded block must hoist the scrutinee into a local (so the local
        /// smart-casts) rather than re-emit the expression at each use of `t`.
        private func IsSmartCastableScrutinee(expression ExpressionSyntax?) bool {
            if !(expression is IdentifierNameSyntax) {
                return false
            }
            let symbol ISymbol? = this.context.GetSymbolInfo(expression).Symbol
            return symbol is ILocalSymbol || symbol is IParameterSymbol
        }

        /// Lowers a C# negated type-pattern guard `if (receiver is not T t) {
        /// … }` to the smart-cast-friendly G# form below.
        /// ```
        /// let t T? = receiver as T
        /// if t == nil { … }
        /// ```
        /// The binder `t` becomes a real hoisted local that survives past the
        /// `if` (so later `t.Member` uses bind to it under G#'s Kotlin-style
        /// smart cast), and a property-path receiver (`child.Header`) is
        /// evaluated once into the local. Applies to a negated declaration/recursive
        /// type-pattern with a single-variable designation over a reference (or
        /// nullable value) target type, where `as T` + nil-guard is valid, AND
        /// to a bare negated recursive pattern with no type test (`is not { } t`,
        /// issue #2233) — there `t`'s target type is the receiver's own
        /// (non-null) type, so no `as` conversion is emitted; the receiver is
        /// hoisted as-is into the nullable local (a nullable value-type receiver,
        /// e.g. a `DateTimeOffset?` field, unwraps to its non-null `T`).
        private func TryBuildNegatedGuardHoist(
            ifStatement IfStatementSyntax,
            out result IReadOnlyList[GStatement]?
        ) bool {
            result = nil
            let terms = List[ExpressionSyntax]()
            CollectLogicalOrTerms(ifStatement.Condition, terms)
            if this.TryBuildNestedNegatedGuardHoist(ifStatement, terms, out result) {
                return true
            }
            let negatedPatternCount = terms.Count(
                (term ExpressionSyntax) -> TryExtractNegatedGuardPattern(term, out _, out _, out _, out _)
            )
            if negatedPatternCount > 1 {
                return this.TryBuildMultipleNegatedGuardHoists(ifStatement, terms, out result)
            }
            var isPattern IsPatternExpressionSyntax? = nil
            var typeSyntax TypeSyntax? = nil
            var designation VariableDesignationSyntax? = nil
            var residualPattern RecursivePatternSyntax? = nil
            var patternIndex = -1
            for var i = 0; i < terms.Count; i++ {
                if !TryExtractNegatedGuardPattern(
                    terms[i],
                    out var candidatePattern,
                    out var candidateType,
                    out var candidateDesignation,
                    out var candidateResidualPattern
                ) {
                    continue
                }
                if patternIndex >= 0 {
                    return false
                }
                isPattern = candidatePattern
                typeSyntax = candidateType
                designation = candidateDesignation
                residualPattern = candidateResidualPattern
                patternIndex = i
            }
            if patternIndex < 0 {
                return false
            }
            if patternIndex > 0 && ifStatement.Else == nil && !StatementAlwaysExits(ifStatement.Statement) {
                return false
            }
            if designation is not SingleVariableDesignationSyntax single {
                return false
            }
            let localName string? = this.EmittedName(single, single.Identifier)
            let receiver GExpression? = this.TranslateExpression(isPattern!!.Expression)
            var hoistInitializer GExpression?
            var targetType GTypeReference?
            var negatedRequiresNullConditionalGuard = false
            if typeSyntax != nil {
                // The hoisted `as T` + `== nil` guard is only valid when T is a
                // reference type (or nullable value type); a non-nullable value-type
                // target keeps the existing then-block binding behaviour.
                let targetSymbol ITypeSymbol? = this.context.GetTypeInfo(typeSyntax).Type
                if targetSymbol == nil {
                    return false
                }
                // Issue #4173 round 3: see TryBuildSharedNodeGuardHoistPieces —
                // a shared-node analyzer type needs its discriminator/predicate
                // in this hoist's `as T` + nil-guard scheme, which a direct
                // MapTypeSyntax call bypasses entirely.
                let isSharedNode = this.TryBuildSharedNodeGuardHoistPieces(
                    typeSyntax,
                    receiver,
                    out var sharedTargetType,
                    out var sharedInitializer,
                    out negatedRequiresNullConditionalGuard
                )
                targetType = if isSharedNode {
                    sharedTargetType
                } else {
                    this.MapTypeSyntax(typeSyntax)
                }
                if isSharedNode {
                    hoistInitializer = sharedInitializer
                } else if targetSymbol.IsValueType {
                    if this
                        .context
                        .GetTypeInfo(isPattern!!.Expression)
                        .Type is INamedTypeSymbol receiverType &&
                        receiverType
                        .OriginalDefinition
                        .SpecialType == SpecialType.System_Nullable_T &&
                        receiverType
                        .TypeArguments
                        .Length == 1 &&
                        SymbolEqualityComparer
                        .Default
                        .Equals(receiverType.TypeArguments[0], targetSymbol) {
                        hoistInitializer = receiver
                    } else {
                        hoistInitializer = BinaryExpression(receiver, "as", TypeExpression(MakeNullable(targetType)))
                    }
                } else {
                    hoistInitializer = BinaryExpression(receiver, "as", TypeExpression(targetType))
                }
            } else {
                // Bare `{ }` pattern: `t`'s type IS the receiver's own (non-null)
                // type — no downcast, so no `as` conversion is emitted (which also
                // sidesteps `as`'s reference-only restriction for a nullable
                // value-type receiver like `DateTimeOffset?`).
                let receiverType ITypeSymbol? = this.context.GetTypeInfo(isPattern!!.Expression).Type
                if receiverType == nil {
                    return false
                }
                let nonNullTarget ITypeSymbol? = UnwrapNullable(receiverType)
                targetType = this.typeMapper.Map(nonNullTarget, this.context, isPattern!!.Expression.GetLocation())
                hoistInitializer = receiver
            }
            // `let t T? = receiver [as T]` — the local is declared nullable so the
            // `== nil` guard and the subsequent smart cast both type-check, while the
            // `as` cast (when present) keeps its non-nullable reference target (a
            // nullable `as T?` target is rejected at emit time).
            let designationSymbol ISymbol? = this.context.GetDeclaredSymbol(single)
            let binding = if designationSymbol != nil && this.IsSymbolReassigned(
                designationSymbol,
                this.state.CurrentBodyScope ?? ifStatement
            ) {
                BindingKind.Var
            } else {
                BindingKind.Let
            }
            let hoist = LocalDeclarationStatement(binding, localName, MakeNullable(targetType), hoistInitializer)
            // `if t == nil { <then> }` reproduces the negated guard: when the cast
            // fails the local is nil, so the original then-block runs.
            var guard_ GExpression = BinaryExpression(IdentifierExpression(localName), "==", LiteralExpression.Null())
            if negatedRequiresNullConditionalGuard {
                // Issue #4173 round 3: De Morgan of the POSITIVE guard's
                // `!= nil && !IsNullConditional` — the then-block (typically an
                // early return) must ALSO run when the cast succeeded but the
                // hop turned out to be null-conditional.
                guard_ = BinaryExpression(
                    guard_,
                    "||",
                    MemberAccessExpression(IdentifierExpression(localName), "IsNullConditional", isArrow: false)
                )
            }
            if residualPattern != nil {
                if !this.TryTranslateIfLetResidualPattern(residualPattern, localName, out var residualGuard) {
                    return false
                }
                guard_ = BinaryExpression(guard_, "||", Negate(residualGuard))
            }
            for var i = patternIndex + 1; i < terms.Count; i++ {
                guard_ = BinaryExpression(guard_, "||", this.TranslateExpression(terms[i]))
            }
            let then = this.TranslateStatementAsBlock(ifStatement.Statement)
            var elseBranch GStatement? = nil
            if ifStatement.Else != nil {
                elseBranch = this.TranslateElseStatement(ifStatement.Else!!.Statement)
            }
            let statements = List[GStatement]()
            if patternIndex > 0 {
                var prefixGuard GExpression? = nil
                for var i = 0; i < patternIndex; i++ {
                    let translated GExpression? = this.TranslateExpression(terms[i])
                    prefixGuard = if prefixGuard == nil {
                        translated
                    } else {
                        cast[GExpression](BinaryExpression(prefixGuard, "||", translated))
                    }
                }
                if elseBranch != nil {
                    result = []GStatement{
                        IfStatement(
                            prefixGuard,
                            then,
                            BlockStatement([]GStatement{hoist, IfStatement(guard_, then, elseBranch)})
                        )
                    }
                    return true
                }
                statements.Add(IfStatement(prefixGuard, then))
            }
            statements.Add(hoist)
            statements.Add(IfStatement(guard_, then, elseBranch))
            result = statements
            return true
        }

        private func TryBuildNestedNegatedGuardHoist(
            ifStatement IfStatementSyntax,
            terms IReadOnlyList[ExpressionSyntax],
            out result IReadOnlyList[GStatement]?
        ) bool {
            result = nil
            if ifStatement.Else != nil || !StatementAlwaysExits(ifStatement.Statement) {
                return false
            }
            var isPattern IsPatternExpressionSyntax? = nil
            var positivePattern PatternSyntax? = nil
            var designation SingleVariableDesignationSyntax? = nil
            var patternIndex = -1
            for var i = 0; i < terms.Count; i++ {
                if !TryGetNegatedPattern(terms[i], out var candidatePattern, out var candidatePositive) {
                    continue
                }
                let designations = candidatePositive!!
                    .DescendantNodesAndSelf()
                    .OfType[SingleVariableDesignationSyntax]()
                    .ToList()
                if designations.Count != 1 ||
                    candidatePositive is DeclarationPatternSyntax ||
                    candidatePositive is RecursivePatternSyntax &&
                    candidatePositive.Designation is SingleVariableDesignationSyntax {
                    continue
                }
                if patternIndex >= 0 {
                    return false
                }
                patternIndex = i
                isPattern = candidatePattern
                positivePattern = candidatePositive
                designation = designations[0]
            }
            if patternIndex < 0 || this.context.GetDeclaredSymbol(designation) is not ILocalSymbol binder ||
                terms
                .Where((_ ExpressionSyntax, index int32) -> index != patternIndex).Any(
                (term ExpressionSyntax) -> term
                    .DescendantNodesAndSelf()
                    .OfType[IsPatternExpressionSyntax]()
                    .Any((pattern IsPatternExpressionSyntax) -> PatternIntroducesBinding(pattern.Pattern))
            ) {
                return false
            }
            let then = this.TranslateStatementAsBlock(ifStatement.Statement)
            let statements = List[GStatement]()
            for var i = 0; i < patternIndex; i++ {
                statements.Add(IfStatement(this.TranslateExpression(terms[i]), then))
            }
            var receiver GExpression? = this.TranslateExpression(isPattern!!.Expression)
            if this.IsNativelyExpressiblePattern(positivePattern, topLevel: true) &&
                binder
                .Type
                .TypeKind != TypeKind.Error &&
                !binder
                .Type
                .IsRefLikeType {
                let mutableName string? = this.EmittedName(designation, designation!!.Identifier)
                let matchName = FreshPatternMatchName(mutableName, this.state.CurrentBodyScope ?? ifStatement)
                this.state.NativePatternVariableAliases[binder] = matchName
                var nativePattern GPattern
                try {
                    nativePattern = this.BuildNativePattern(positivePattern, List[ILocalSymbol]())
                } finally {
                    this.state.NativePatternVariableAliases.Remove(binder)
                }
                statements.Add(IfStatement(Negate(PatternTestExpression(receiver, nativePattern)), then))
                let mutableType GTypeReference? = this.typeMapper.Map(
                    binder.Type,
                    this.context,
                    designation!!.GetLocation()
                )
                statements.Add(
                    LocalDeclarationStatement(
                        BindingKind.Var,
                        mutableName,
                        mutableType,
                        IdentifierExpression(matchName)
                    )
                )
                this.state.PatternBindings[binder] = IdentifierExpression(mutableName)
                for var i = patternIndex + 1; i < terms.Count; i++ {
                    statements.Add(IfStatement(this.TranslateExpression(terms[i]), then))
                }
                result = statements
                return true
            }
            if !IsTrivialOperand(receiver!!) {
                let spillName = this.NewSpillName()
                statements.Add(LocalDeclarationStatement(BindingKind.Let, spillName, initializer: receiver))
                receiver = IdentifierExpression(spillName)
            }
            let hadPrevious = this.state.PatternBindings.TryGetValue(binder, out var previous)
            var positiveTest GExpression
            var replacement GExpression?
            try {
                positiveTest = this.TranslatePatternTest(
                    receiver,
                    positivePattern,
                    this.context.GetTypeInfo(isPattern!!.Expression).Type,
                    isPattern!!.Expression
                )
                this.state.PatternBindings.TryGetValue(binder, out replacement)
            } finally {
                if hadPrevious {
                    this.state.PatternBindings[binder] = previous
                } else {
                    this.state.PatternBindings.Remove(binder)
                }
            }
            if replacement == nil {
                return false
            }
            let localName string? = this.EmittedName(designation, designation!!.Identifier)
            let localType GTypeReference? = MakeNullable(
                this.typeMapper.Map(binder.Type, this.context, designation!!.GetLocation())
            )
            statements.Add(LocalDeclarationStatement(BindingKind.Var, localName, localType))
            statements.Add(IfStatement(Negate(positiveTest), then))
            statements.Add(AssignmentStatement(IdentifierExpression(localName), replacement))
            let narrowed = NonNullAssertionExpression(IdentifierExpression(localName))
            this.state.PatternBindings[binder] = narrowed
            for var i = patternIndex + 1; i < terms.Count; i++ {
                statements.Add(IfStatement(this.TranslateExpression(terms[i]), then))
            }
            result = statements
            return true
        }

        private func TryBuildMultipleNegatedGuardHoists(
            ifStatement IfStatementSyntax,
            terms IReadOnlyList[ExpressionSyntax],
            out result IReadOnlyList[GStatement]?
        ) bool {
            result = nil
            if ifStatement.Else != nil || !StatementAlwaysExits(ifStatement.Statement) {
                return false
            }
            let then = this.TranslateStatementAsBlock(ifStatement.Statement)
            let statements = List[GStatement]()
            for term in terms {
                if !TryExtractNegatedGuardPattern(
                    term,
                    out var isPattern,
                    out var typeSyntax,
                    out var designation,
                    out var residualPattern
                ) {
                    statements.Add(IfStatement(this.TranslateExpression(term), then))
                    continue
                }
                if designation is not SingleVariableDesignationSyntax single {
                    return false
                }
                let localName string? = this.EmittedName(single, single.Identifier)
                let receiver GExpression? = this.TranslateExpression(isPattern!!.Expression)
                var initializer GExpression?
                var targetType GTypeReference?
                var requiresNullConditionalGuard = false
                if typeSyntax != nil {
                    let targetSymbol ITypeSymbol? = this.context.GetTypeInfo(typeSyntax).Type
                    if targetSymbol == nil {
                        return false
                    }
                    // Issue #4173 round 3: see TryBuildSharedNodeGuardHoistPieces.
                    let isSharedNode = this.TryBuildSharedNodeGuardHoistPieces(
                        typeSyntax,
                        receiver,
                        out var sharedTargetType,
                        out var sharedInitializer,
                        out requiresNullConditionalGuard
                    )
                    targetType = if isSharedNode {
                        sharedTargetType
                    } else {
                        this.MapTypeSyntax(typeSyntax)
                    }
                    if isSharedNode {
                        initializer = sharedInitializer
                    } else if targetSymbol.IsValueType {
                        if this
                            .context
                            .GetTypeInfo(isPattern!!.Expression)
                            .Type is not INamedTypeSymbol receiverType ||
                            receiverType
                            .OriginalDefinition
                            .SpecialType != SpecialType.System_Nullable_T ||
                            receiverType
                            .TypeArguments
                            .Length != 1 ||
                            !SymbolEqualityComparer
                            .Default
                            .Equals(receiverType.TypeArguments[0], targetSymbol) {
                            return false
                        }
                        initializer = receiver
                    } else {
                        initializer = BinaryExpression(receiver, "as", TypeExpression(targetType))
                    }
                } else {
                    let receiverType ITypeSymbol? = this.context.GetTypeInfo(isPattern!!.Expression).Type
                    if receiverType == nil {
                        return false
                    }
                    targetType = this.typeMapper.Map(
                        UnwrapNullable(receiverType),
                        this.context,
                        isPattern!!.Expression.GetLocation()
                    )
                    initializer = receiver
                }
                let designationSymbol ISymbol? = this.context.GetDeclaredSymbol(single)
                let binding = if designationSymbol != nil && this.IsSymbolReassigned(
                    designationSymbol,
                    this.state.CurrentBodyScope ?? ifStatement
                ) {
                    BindingKind.Var
                } else {
                    BindingKind.Let
                }
                statements.Add(LocalDeclarationStatement(binding, localName, MakeNullable(targetType), initializer))
                var guard_ GExpression = BinaryExpression(
                    IdentifierExpression(localName),
                    "==",
                    LiteralExpression.Null()
                )
                if requiresNullConditionalGuard {
                    // Issue #4173 round 3: De Morgan of the positive guard —
                    // see TryBuildNegatedGuardHoist's identical addition.
                    guard_ = BinaryExpression(
                        guard_,
                        "||",
                        MemberAccessExpression(IdentifierExpression(localName), "IsNullConditional", isArrow: false)
                    )
                }
                if residualPattern != nil {
                    if !this.TryTranslateIfLetResidualPattern(residualPattern, localName, out var residualGuard) {
                        return false
                    }
                    guard_ = BinaryExpression(guard_, "||", Negate(residualGuard))
                }
                statements.Add(IfStatement(guard_, then))
            }
            result = statements
            return true
        }

        private func TranslateIf(ifStatement IfStatementSyntax) GStatement {
            let translated = this.TranslateIfWithConditionPrologue(ifStatement)
            return if translated.Count == 1 {
                translated[0]
            } else {
                cast[GStatement](BlockStatement(translated))
            }
        }

        private func TranslateIfWithConditionPrologue(ifStatement IfStatementSyntax) IReadOnlyList[GStatement] {
            // Translate the condition first so any `x is T t` declaration pattern
            // registers its Kotlin-style smart-cast binding before the guarded
            // block is translated; the binding is scoped to the then-block only.
            // Native assignment expressions stay in the condition; only an
            // embedded deconstruction assignment can populate the prologue.
            let bindingsBefore = HashSet[ISymbol](this.state.PatternBindings.Keys, SymbolEqualityComparer.Default)
            let conditionPrologue = List[GStatement]()
            let condition GExpression? = GuardBlockCondition(
                this.TranslateConditionWithHoist(ifStatement.Condition, conditionPrologue)!!
            )
            let then = this.TranslateStatementAsBlock(ifStatement.Statement)
            for added in this.state.PatternBindings.Keys.ToList() {
                if !bindingsBefore.Contains(added) {
                    this.state.PatternBindings.Remove(added)
                }
            }
            var elseBranch GStatement? = nil
            if ifStatement.Else != nil {
                elseBranch = this.TranslateElseStatement(ifStatement.Else!!.Statement)
            }
            conditionPrologue.Add(IfStatement(condition, then, elseBranch))
            return conditionPrologue
        }

        private func TranslateForStatement(forStatement ForStatementSyntax) GStatement {
            let declaratorCount = forStatement.Declaration?.Variables.Count ?? 0
            // G#'s `for` carries a SINGLE init clause and a SINGLE incrementor, so
            // a C-style `for` with multiple declarators/initializers or multiple
            // incrementors cannot be represented directly. Lower those to a block
            // + `while` so every init runs once up front and every incrementor runs
            // at the end of each iteration (issue #914). A condition needing clause
            // hoisting (a value-position assignment, e.g. `for (…; (c = Next()) !=
            // -1; …)`, or an is-pattern requiring a scrutinee local) has the same
            // problem — G#'s single-expression `for` condition has nowhere to place
            // the hoisted statement — so it takes the same lowering (issue #1723).
            if declaratorCount > 1 ||
                forStatement
                .Initializers
                .Count > 1 ||
                forStatement
                .Incrementors
                .Count > 1 ||
                forStatement
                .Initializers
                .Concat(forStatement.Incrementors)
                .Any(ClauseContainsAssignment) ||
                this.ForConditionRequiresHoist(forStatement.Condition) {
                return this.LowerForToWhile(forStatement)
            }
            var initializer GStatement? = nil
            if forStatement.Declaration != nil {
                initializer = this.TranslateLocalDeclaration(forStatement.Declaration, isConst: false).FirstOrDefault()
            } else if forStatement.Initializers.Count > 0 {
                initializer = this.TranslateExpressionStatement(forStatement.Initializers[0])
            }
            let condition GExpression? = if forStatement.Condition == nil {
                default(GExpression?)
            } else {
                this.TranslateExpression(forStatement.Condition)
            }
            let incrementor GStatement? = if forStatement.Incrementors.Count > 0 {
                this.TranslateExpressionStatement(forStatement.Incrementors[0])
            } else {
                default(GStatement?)
            }
            return ForStatement(
                initializer,
                condition,
                incrementor,
                this.TranslateStatementAsBlock(forStatement.Statement)
            )
        }

        private func ForConditionRequiresHoist(condition ExpressionSyntax?) bool {
            if condition == nil {
                return false
            }
            let clauses = List[ExpressionSyntax]()
            FlattenAndClauses(condition, clauses)
            return clauses.Any(this.ClauseRequiresConditionHoist)
        }

        /// Lowers a C-style `for` that has more than one initializer/declarator
        /// or more than one incrementor — neither of which fits G#'s single-init,
        /// single-incrementor `for` — into an equivalent block + `while`:
        /// all inits run once before the loop, the body runs each iteration, then
        /// every incrementor runs at the end of the body (issue #914). A condition
        /// needing clause hoisting places its prologue (hoisted assignment /
        /// scrutinee local plus `if !test { break }` guards) at the TOP of the body,
        /// re-run every iteration exactly where C# would re-test the condition
        /// (issue #1723).
        ///
        /// In C# the incrementors also run when the body executes a loop-targeting
        /// `continue`, but a G# `continue` is a goto straight past the
        /// WHOLE lowered `while` body — so the trailing incrementors below
        /// would be silently skipped. When the body has such a `continue`, it
        /// is rewritten ((cref:DuplicateIncrementorsBeforeOwnLoopContinue)) to duplicate the
        /// incrementors immediately ahead of every own-loop `continue`, so they
        /// still run before the condition re-test either way (issue #1732). The one
        /// shape that rewrite cannot do faithfully — the `continue` sits inside
        /// a `try`/`finally`, where C# runs `finally` before the
        /// incrementors — is reported via `ReportUnsupported` instead of
        /// silently reordering that side effect.
        private func LowerForToWhile(forStatement ForStatementSyntax) GStatement {
            let outer = List[GStatement]()
            if forStatement.Declaration != nil {
                outer.AddRange(this.TranslateLocalDeclaration(forStatement.Declaration, isConst: false))
            }
            for init in forStatement.Initializers {
                outer.AddRange(this.TranslateExpressionStatements(init)!!)
            }
            var condition GExpression?
            var conditionPrologue List[GStatement]?
            if forStatement.Condition == nil {
                condition = LiteralExpression.Bool(true)
                conditionPrologue = List[GStatement]()
            } else if this.TryBuildHoistedLoopCondition(
                forStatement.Condition,
                out var hoistedCondition,
                out var hoisted,
                out _
            ) {
                condition = hoistedCondition
                conditionPrologue = hoisted
            } else {
                condition = this.TranslateExpression(forStatement.Condition)
                conditionPrologue = List[GStatement]()
            }
            let incrementorExpressions = forStatement.Incrementors.ToList()
            let incrementorStatements = List[GStatement]()
            for inc in incrementorExpressions {
                incrementorStatements.AddRange(this.TranslateExpressionStatements(inc)!!)
            }
            var translatedBody BlockStatement? = this.TranslateStatementAsBlock(forStatement.Statement)
            if incrementorStatements.Count > 0 && BodyContainsOwnLoopContinue(forStatement.Statement) {
                if OwnLoopContinueCrossesFinally(forStatement.Statement) {
                    this.context.ReportUnsupported(
                        forStatement,
                        "a 'continue' inside a 'try'/'finally' within this 'for' loop has no side-effect-preserving G# lowering yet (issue #1732)."
                    )
                } else {
                    translatedBody = this.DuplicateIncrementorsBeforeOwnLoopContinue(
                        forStatement,
                        translatedBody,
                        incrementorStatements
                    )
                }
            }
            let bodyStatements = List[GStatement](conditionPrologue!!)
            bodyStatements.AddRange(translatedBody!!.Statements)
            bodyStatements.AddRange(incrementorStatements)
            outer.Add(WhileStatement(GuardBlockCondition(condition!!), BlockStatement(bodyStatements)))
            return BlockStatement(outer)
        }

        /// Duplicates a `for` loop's already-translated incrementor
        /// statements immediately ahead of every `continue` that targets
        /// THIS loop. G#'s while-lowering ((cref:LowerForToWhile)) appends
        /// the incrementors as trailing statements in the lowered `while`
        /// body, but a G# `continue` is a goto straight past the WHOLE body
        /// (ADR-0070's continueLabel) — so without this rewrite the trailing
        /// incrementors are silently skipped on `continue`, unlike C#'s
        /// `for`, which always runs them before re-testing the condition
        /// (issue #1732).
        ///
        /// Operates on the TRANSLATED G# statement tree, not the C# syntax tree:
        /// rebuilding a Roslyn syntax subtree to splice in the incrementors would
        /// re-parent untouched sibling nodes onto a detached tree, breaking any
        /// later `SemanticModel.GetSymbolInfo` call on them
        /// ((cref:ArgumentException) "Syntax node is not within syntax
        /// tree"). The G# AST has no such constraint, so the rewrite happens
        /// here, after translation.
        ///
        /// Descent stops at a nested loop ((cref:WhileStatement),
        /// (cref:ForStatement), (cref:DoWhileStatement),
        /// (cref:ForInStatement)) or a nested
        /// (cref:LocalFunctionStatement) — each is its own
        /// `continue` seam, mirroring (cref:BodyContainsOwnLoopContinue).
        /// A `finally` block is left untouched: C# forbids a jump statement
        /// leaving a `finally`, so it can never itself contain an own-loop
        /// `continue`.
        private func DuplicateIncrementorsBeforeOwnLoopContinue(
            forStatement ForStatementSyntax,
            body BlockStatement?,
            incrementorStatements IReadOnlyList[GStatement]
        ) BlockStatement? {
            return cast[BlockStatement](this.RewriteOwnLoopContinue(forStatement, body, incrementorStatements))
        }

        private func RewriteOwnLoopContinue(
            forStatement ForStatementSyntax,
            statement GStatement?,
            incrementorStatements IReadOnlyList[GStatement]
        ) GStatement? {
            switch statement {
                case ContinueStatement {
                    {
                        let replaced = List[GStatement](incrementorStatements){statement}
                        return BlockStatement(replaced)
                    }
                }
                case block is BlockStatement {
                    {
                        let rewritten = List[GStatement](block.Statements.Count)
                        for inner in block.Statements {
                            rewritten.Add(this.RewriteOwnLoopContinue(forStatement, inner, incrementorStatements)!!)
                        }
                        return BlockStatement(rewritten, block.IsUnsafe)
                    }
                }
                case ifStatement is IfStatement {
                    {
                        let elseBranch GStatement? = if ifStatement.ElseBranch == nil {
                            default(GStatement?)
                        } else {
                            this.RewriteOwnLoopContinue(forStatement, ifStatement.ElseBranch, incrementorStatements)
                        }
                        return IfStatement(
                            ifStatement.Condition,
                            cast[BlockStatement](
                                this.RewriteOwnLoopContinue(forStatement, ifStatement.Then, incrementorStatements)
                            ),
                            elseBranch
                        )
                    }
                }
                case tryStatement is TryStatement {
                    {
                        let catchClauses = List[CatchClause](tryStatement.CatchClauses.Count)
                        for catchClause in tryStatement.CatchClauses {
                            catchClauses.Add(
                                CatchClause(
                                    catchClause.VariableName,
                                    catchClause.ExceptionType,
                                    cast[BlockStatement](
                                        this.RewriteOwnLoopContinue(
                                            forStatement,
                                            catchClause.Body,
                                            incrementorStatements
                                        )
                                    )
                                )
                            )
                        }
                        return TryStatement(
                            cast[BlockStatement](
                                this.RewriteOwnLoopContinue(forStatement, tryStatement.TryBlock, incrementorStatements)
                            ),
                            catchClauses,
                            tryStatement.FinallyBlock
                        )
                    }
                }
                case switchStatement is SwitchStatement {
                    {
                        let cases = List[SwitchStatementCase](switchStatement.Cases.Count)
                        for switchCase in switchStatement.Cases {
                            cases.Add(
                                SwitchStatementCase(
                                    switchCase.Pattern,
                                    cast[BlockStatement](
                                        this.RewriteOwnLoopContinue(
                                            forStatement,
                                            switchCase.Body,
                                            incrementorStatements
                                        )
                                    ),
                                    switchCase.Guard
                                )
                            )
                        }
                        return SwitchStatement(switchStatement.Subject, cases)
                    }
                }
                case fixedStatement is FixedStatement {
                    {
                        return FixedStatement(
                            fixedStatement.Name,
                            fixedStatement.PointerType,
                            fixedStatement.Source,
                            cast[BlockStatement](
                                this.RewriteOwnLoopContinue(forStatement, fixedStatement.Body, incrementorStatements)
                            )
                        )
                    }
                }
                case WhileStatement,
                WhileLetStatement,
                ForStatement,
                DoWhileStatement,
                ForInStatement,
                LocalFunctionStatement {
                    return statement
                }
                default {
                    // Any other body-carrying G# statement kind that reaches
                    // here was missed by the cases above. Silently returning
                    // it unchanged would let an own-loop `continue` buried
                    // inside it skip the duplicated incrementors — the same
                    // silent miscompile this rewrite exists to fix (issue
                    // #1732). Report it instead of guessing a lowering.
                    if ContainsOwnLoopContinue(statement) {
                        this.context.ReportUnsupported(
                            forStatement,
                            "a 'continue' inside a '${statement!!.GetType().Name}' within this 'for' loop has no incrementor-duplication lowering yet (issue #1732)."
                        )
                    }
                    return statement
                }
            }
        }

        private func IsLocalReassigned(local ILocalSymbol?) bool {
            // A local is mutable in G# (`var`) when it is assigned, incremented,
            // decremented, OR passed by `ref`/`out` (which cs2gs renders as an
            // address-of `&arg`): taking the address of an immutable `let` is
            // rejected by gsc with GS9005 ("Cannot take address of constant").
            // Delegate to the general symbol walk, which already covers the
            // `ref`/`out` argument case, so both paths stay consistent.
            return this.IsSymbolReassigned(local, this.state.CurrentBodyScope)
        }

        private func BindsTo(expression ExpressionSyntax?, target ISymbol?) bool -> CSharpToGSharpTranslator.BindsTo(
            expression,
            target,
            this.context.SemanticModel
        )

        // Shared by declaration mutability and smart-cast invalidation so tuple,
        // ref/out, address-of, and ref-alias writes cannot drift apart. A write
        // through value-type storage (`x.N = 1`, `ref x.N`, or a mutating struct
        // call `x.Mutate()`) writes `x` itself (issue #4302).
        private func SyntaxNodeWritesSymbol(
            node SyntaxNode,
            symbol ISymbol?
        ) bool -> CSharpToGSharpTranslator.SyntaxNodeWritesSymbol(node, symbol, this.context.SemanticModel)

        // Returns true when <paramref name="symbol"/> is assigned, incremented,
        // decremented, or passed by ref/out anywhere in <paramref name="scope"/>.
        // Generalises <see cref="IsLocalReassigned"/> to any symbol (used for
        // value parameters, which are read-only in G#).
        private func IsSymbolReassigned(symbol ISymbol?, $scope SyntaxNode?) bool {
            if $scope == nil {
                return false
            }
            let key = (symbol, $scope)
            if this.state.SymbolReassignedCache.TryGetValue(key, out var cached) {
                return cached
            }
            let result = this.ComputeIsSymbolReassigned(symbol, $scope)
            this.state.SymbolReassignedCache[key] = result
            return result
        }

        private func ComputeIsSymbolReassigned(symbol ISymbol?, $scope SyntaxNode) bool {
            for node in $scope.DescendantNodes() {
                if this.SyntaxNodeWritesSymbol(node, symbol) {
                    return true
                }
            }
            return false
        }

        shared {
            // True for a node that starts a NEW `continue` seam: a nested loop (its
            // own `continue` target) or a lambda/local function (C# forbids a jump
            // statement crossing that boundary at all). Shared by the do-while tail
            // hoist scan (issue #1723) and the for→while incrementor-on-continue fix
            // (issue #1732) so both agree on what "targets THIS loop" means. Note a
            // `switch` is NOT a boundary: `continue` (unlike `break`) passes through a
            // `switch` straight to the enclosing loop.
            private func IsOwnLoopContinueBoundary(node SyntaxNode) bool -> node is ForStatementSyntax ||
                node is ForEachStatementSyntax ||
                node is ForEachVariableStatementSyntax ||
                node is WhileStatementSyntax ||
                node is DoStatementSyntax ||
                node is AnonymousFunctionExpressionSyntax ||
                node is LocalFunctionStatementSyntax

            // True when `body` has a `continue` that targets THIS loop. Descent stops
            // at any nested loop/switch (its own `continue`/`break` seam) and at
            // nested lambdas/local functions (their own statement seam), so a
            // `continue` inside an inner `for`/`foreach`/`while`/`do`/`switch` does
            // NOT count — it never reaches this loop's do-while tail hoist (issue
            // #1723).
            private func BodyContainsOwnLoopContinue(body StatementSyntax) bool {
                let DescendGuard = func (node SyntaxNode) bool {
                    return !IsOwnLoopContinueBoundary(node)
                }
                return body
                    .DescendantNodesAndSelf(descendIntoChildren: DescendGuard)
                    .OfType[ContinueStatementSyntax]()
                    .Any()
            }

            // True when an own-loop `continue` inside `body` sits under a `try` that
            // has a `finally` clause (reachable without crossing this loop's own
            // boundary). C# runs that `finally` on the way out of the `continue`
            // BEFORE the for-loop's incrementors re-run; duplicating the incrementors
            // right before the `continue` (see
            // <see cref="DuplicateIncrementorsBeforeOwnLoopContinue"/>) would instead
            // run them BEFORE the `finally`, reordering an observable side effect.
            // This shape has no faithful lowering here, so the caller reports it
            // instead of silently reordering (issue #1732).
            private func OwnLoopContinueCrossesFinally(body StatementSyntax) bool {
                let DescendGuard = func (node SyntaxNode) bool {
                    return !IsOwnLoopContinueBoundary(node)
                }
                for continueStatement in body.DescendantNodesAndSelf(descendIntoChildren: DescendGuard)
                    .OfType[ContinueStatementSyntax]() {
                    for var ancestor SyntaxNode? = continueStatement.Parent;
                        ancestor != nil;
                        ancestor = ancestor!!.Parent {
                        if ancestor is TryStatementSyntax tryStatement && tryStatement.Finally != nil {
                            return true
                        }
                        if ancestor == body {
                            break
                        }
                    }
                }
                return false
            }

            // Flattens the left-to-right top-level `&&` operands of a condition into
            // `clauses`. Parentheses are transparent for the split.
            private func FlattenAndClauses(expression ExpressionSyntax?, clauses List[ExpressionSyntax]) {
                var expr ExpressionSyntax? = expression
                while expr is ParenthesizedExpressionSyntax paren {
                    expr = paren.Expression
                }
                if expr is BinaryExpressionSyntax binary && binary.IsKind(SyntaxKind.LogicalAndExpression) {
                    FlattenAndClauses(binary.Left, clauses)
                    FlattenAndClauses(binary.Right, clauses)
                } else {
                    clauses.Add(expr!!)
                }
            }

            // Cheap presence check used only to decide whether a clause needs the
            // hoist path at all; the short-circuit/`?:` safety analysis and the
            // actual hoisting happen once, in HoistLoopConditionClause.
            private func ClauseContainsAssignment(clause ExpressionSyntax) bool -> EagerExecutionNodes(clause)
                .OfType[AssignmentExpressionSyntax]().Any(AssignmentRequiresStatementLowering)

            private func EagerExecutionNodes(node SyntaxNode?) sequence[SyntaxNode?] {
                if node is AnonymousFunctionExpressionSyntax || node is LocalFunctionStatementSyntax {
                    yield break
                }
                let children = if node is QueryExpressionSyntax query {
                    cast[IEnumerable[SyntaxNode]](EagerQuerySources(query))
                } else {
                    node!!.ChildNodes()
                }
                for child in children {
                    for descendant in EagerExecutionNodes(child) {
                        yield descendant
                    }
                }
                yield node
            }

            private func PatternIntroducesBinding(pattern PatternSyntax?) bool -> pattern!!
                .DescendantNodesAndSelf()
                .OfType[SingleVariableDesignationSyntax]()
                .Any()

            private func ExpressionDeclaresOutVar(expression ExpressionSyntax) bool -> expression
                .DescendantNodesAndSelf()
                .OfType[DeclarationExpressionSyntax]()
                .Any()

            // True when `scrutineeType` is a non-nullable reference convertible to
            // `target` by identity or base/interface — i.e. `scrutinee is target` is
            // statically guaranteed.
            private func IsAssignableNonNull(scrutineeType ITypeSymbol?, target ITypeSymbol?) bool {
                if scrutineeType == nil ||
                    target == nil ||
                    scrutineeType.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated {
                    return false
                }
                for var t ITypeSymbol? = scrutineeType; t != nil; t = t!!.BaseType {
                    if SymbolEqualityComparer.Default.Equals(t, target) {
                        return true
                    }
                }
                return scrutineeType.AllInterfaces.Any(
                    (i INamedTypeSymbol) -> SymbolEqualityComparer.Default.Equals(i, target)
                )
            }

            private func BreakIf(condition GExpression) GStatement -> IfStatement(
                condition,
                BlockStatement([]GStatement{BreakStatement()})
            )

            private func Negate(expression GExpression?) GExpression -> UnaryExpression(
                "!",
                ParenthesizedExpression(expression)
            )

            // Extracts the target type and single-variable designation from a positive
            // declaration / recursive type-pattern (`x is T t`, `x is T { } t`). Returns
            // false for any other pattern shape (constant, relational, property
            // subpatterns, multi-variable designations).
            private func TryExtractSingleVarTypePattern(
                pattern PatternSyntax,
                out typeSyntax TypeSyntax?,
                out single SingleVariableDesignationSyntax?
            ) bool {
                typeSyntax = nil
                single = nil
                var designation VariableDesignationSyntax?
                switch pattern {
                    case declaration is DeclarationPatternSyntax {
                        typeSyntax = declaration.Type
                        designation = declaration.Designation
                    }
                    case RecursivePatternSyntax{Type: {} recursiveType} recursive when(
                        recursive.PropertyPatternClause is nil or {Subpatterns: {Count: 0}}
                    ) {
                        typeSyntax = recursiveType
                        designation = recursive.Designation
                    }
                    default {
                        return false
                    }
                }
                single = designation as SingleVariableDesignationSyntax
                return single != nil
            }

            private func CollectLogicalOrTerms(expression ExpressionSyntax, terms List[ExpressionSyntax]) {
                if expression is BinaryExpressionSyntax binary && binary.IsKind(SyntaxKind.LogicalOrExpression) {
                    CollectLogicalOrTerms(binary.Left, terms)
                    CollectLogicalOrTerms(binary.Right, terms)
                    return
                }
                terms.Add(expression)
            }

            private func TryExtractNegatedGuardPattern(
                condition ExpressionSyntax,
                out isPattern IsPatternExpressionSyntax?,
                out typeSyntax TypeSyntax?,
                out designation VariableDesignationSyntax?,
                out residualPattern RecursivePatternSyntax?
            ) bool {
                if !TryGetNegatedPattern(condition, out isPattern, out var negatedPattern) {
                    typeSyntax = nil
                    designation = nil
                    residualPattern = nil
                    return false
                }
                typeSyntax = nil
                designation = nil
                residualPattern = nil
                if isPattern == nil {
                    return false
                }
                switch negatedPattern {
                    case declaration is DeclarationPatternSyntax {
                        typeSyntax = declaration.Type
                        designation = declaration.Designation
                        return true
                    }
                    case RecursivePatternSyntax{Type: {} recursiveType} recursive {
                        typeSyntax = recursiveType
                        designation = recursive.Designation
                        if recursive.PositionalPatternClause != nil ||
                            recursive.PropertyPatternClause is {Subpatterns: {Count: > 0}} {
                            residualPattern = recursive
                        }
                        return true
                    }
                    case RecursivePatternSyntax{Type: nil} bareRecursive {
                        designation = bareRecursive.Designation
                        if bareRecursive.PositionalPatternClause != nil ||
                            bareRecursive.PropertyPatternClause is {Subpatterns: {Count: > 0}} {
                            residualPattern = bareRecursive
                        }
                        return true
                    }
                    default {
                        return false
                    }
                }
            }

            private func TryGetNegatedPattern(
                condition ExpressionSyntax?,
                out isPattern IsPatternExpressionSyntax?,
                out positivePattern PatternSyntax?
            ) bool {
                var condition = condition
                condition = Unparenthesize(condition)
                if condition is IsPatternExpressionSyntax directPattern &&
                    directPattern.Pattern is UnaryPatternSyntax notPattern &&
                    notPattern.IsKind(SyntaxKind.NotPattern) {
                    isPattern = directPattern
                    positivePattern = notPattern.Pattern
                    return true
                }
                if condition is PrefixUnaryExpressionSyntax logicalNot && logicalNot.IsKind(
                    SyntaxKind.LogicalNotExpression
                ) &&
                    Unparenthesize(logicalNot.Operand) is IsPatternExpressionSyntax parenthesizedPattern {
                    isPattern = parenthesizedPattern
                    positivePattern = parenthesizedPattern.Pattern
                    return true
                }
                isPattern = nil
                positivePattern = nil
                return false
            }

            private func StatementAlwaysExits(statement StatementSyntax) bool -> switch statement {
                case _ is ReturnStatementSyntax or
                    _ is ThrowStatementSyntax or
                    _ is BreakStatementSyntax or
                    _ is ContinueStatementSyntax or
                    _ is GotoStatementSyntax: true
                case BlockSyntax{Statements: {Count: > 0}} block: StatementAlwaysExits(
                    block.Statements[block.Statements.Count - 1]
                )
                default: false
            }

            private func FreshPatternMatchName(localName string?, $scope SyntaxNode) string {
                let used = HashSet[string](
                    $scope
                        .DescendantTokens()
                        .Where((token SyntaxToken) -> token.IsKind(SyntaxKind.IdentifierToken))
                        .Select((token SyntaxToken) -> token.ValueText),
                    StringComparer.Ordinal
                )
                let stem = localName + "Match"
                var candidate = stem
                for var suffix = 2; used.Contains(candidate); suffix++ {
                    candidate = stem + suffix.ToString()
                }
                return candidate
            }

            // Returns a nullable (`T?`) copy of a type reference, preserving the
            // concrete reference kind (named/array/pointer/tuple). Used when hoisting a
            // negated type-pattern guard local so the `== nil` test type-checks.
            private func MakeNullable(reference GTypeReference?) GTypeReference? {
                return switch reference {
                    case named is NamedTypeReference: cast[GTypeReference](
                        NamedTypeReference(named.Name, named.TypeArguments, named.ContainingType){IsNullable = true}
                    )
                    case array is ArrayTypeReference: cast[GTypeReference](
                        ArrayTypeReference(array.ElementType, array.Rank){IsNullable = true}
                    )
                    case pointer is PointerTypeReference: cast[GTypeReference](
                        PointerTypeReference(pointer.ElementType){IsNullable = true}
                    )
                    case slice is NativeSliceTypeReference: cast[GTypeReference](
                        NativeSliceTypeReference(slice.ElementType, slice.IsReadOnly){IsNullable = true}
                    )
                    case managed is ManagedReferenceTypeReference: cast[GTypeReference](
                        ManagedReferenceTypeReference(managed.ElementType, managed.IsReadOnly){IsNullable = true}
                    )
                    case tuple is TupleTypeReference: cast[GTypeReference](
                        TupleTypeReference(tuple.ElementTypes, tuple.ElementNames){IsNullable = true}
                    )
                    case arrow is ArrowTypeReference: cast[GTypeReference](
                        ArrowTypeReference(arrow.ParameterTypes, arrow.ReturnTypes, arrow.IsAsync){IsNullable = true}
                    )
                    default: reference
                }
            }

            // True when `statement` (a TRANSLATED G# node) transitively holds a
            // `ContinueStatement` that targets THIS loop, mirroring
            // <see cref="BodyContainsOwnLoopContinue"/> but walking the G# AST
            // instead of the C# syntax tree — used by <see
            // cref="RewriteOwnLoopContinue"/>'s `default` arm so an unhandled
            // body-carrying G# statement kind is reported (issue #1732) instead of
            // silently passing an unrewritten own-loop `continue` through (which
            // would skip the duplicated incrementors, reproducing the original
            // miscompile). Boundaries match <see cref="RewriteOwnLoopContinue"/>:
            // a nested loop or local function never contributes its own
            // `continue`s to this check.
            private func ContainsOwnLoopContinue(statement GStatement?) bool {
                switch statement {
                    case ContinueStatement {
                        return true
                    }
                    case block is BlockStatement {
                        for inner in block.Statements {
                            if ContainsOwnLoopContinue(inner) {
                                return true
                            }
                        }
                        return false
                    }
                    case ifStatement is IfStatement {
                        return ContainsOwnLoopContinue(ifStatement.Then) ||
                            (ifStatement.ElseBranch != nil && ContainsOwnLoopContinue(ifStatement.ElseBranch))
                    }
                    case tryStatement is TryStatement {
                        if ContainsOwnLoopContinue(tryStatement.TryBlock) {
                            return true
                        }
                        for catchClause in tryStatement.CatchClauses {
                            if ContainsOwnLoopContinue(catchClause.Body) {
                                return true
                            }
                        }
                        // FinallyBlock deliberately excluded: C# forbids a jump
                        // statement leaving a `finally`, so it can never itself
                        // hold an own-loop `continue`.
                        return false
                    }
                    case switchStatement is SwitchStatement {
                        for switchCase in switchStatement.Cases {
                            if ContainsOwnLoopContinue(switchCase.Body) {
                                return true
                            }
                        }
                        return false
                    }
                    case fixedStatement is FixedStatement {
                        return ContainsOwnLoopContinue(fixedStatement.Body)
                    }
                    case WhileStatement,
                    WhileLetStatement,
                    ForStatement,
                    DoWhileStatement,
                    ForInStatement,
                    LocalFunctionStatement {
                        return false
                    }
                    default {
                        return false
                    }
                }
            }
        }
    }

    shared {
        // Shared by declaration mutability, smart casts and taint guard proofs.
        internal func SyntaxNodeWritesSymbol(
            node SyntaxNode,
            symbol ISymbol?,
            model SemanticModel
        ) bool -> switch node {
            case assignment is AssignmentExpressionSyntax when WritesStorageOf(assignment.Left, symbol, model): true
            case AssignmentExpressionSyntax{Left: TupleExpressionSyntax tuple} when TupleAssignmentTargetsInclude(
                tuple,
                symbol,
                model
            ): true
            case postfix is PostfixUnaryExpressionSyntax when(
                postfix.IsKind(SyntaxKind.PostIncrementExpression) || postfix.IsKind(SyntaxKind.PostDecrementExpression)
            ) &&
                WritesStorageOf(postfix.Operand, symbol, model): true
            case prefix is PrefixUnaryExpressionSyntax when(
                prefix.IsKind(SyntaxKind.PreIncrementExpression) || prefix.IsKind(SyntaxKind.PreDecrementExpression) ||
                    prefix.IsKind(SyntaxKind.AddressOfExpression)
            ) &&
                WritesStorageOf(prefix.Operand, symbol, model): true
            case argument is ArgumentSyntax when(
                argument.RefOrOutKeyword.IsKind(SyntaxKind.RefKeyword) || argument.RefOrOutKeyword.IsKind(
                    SyntaxKind.OutKeyword
                )
            ) &&
                WritesStorageOf(argument.Expression, symbol, model): true
            case InvocationExpressionSyntax{
                Expression: MemberAccessExpressionSyntax member
            } invocation when ExtensionReceiverWritesSymbol(invocation, member.Expression, symbol, model) ||
                MutatingStructCallWritesSymbol(invocation, member, symbol, model): true
            case refOf is RefExpressionSyntax when WritesStorageOf(refOf.Expression, symbol, model) &&
                !(
                refOf.Parent is EqualsValueClauseSyntax{Parent: VariableDeclaratorSyntax declarator} &&
                    model.GetDeclaredSymbol(declarator) is ILocalSymbol local && local.RefKind == RefKind.RefReadOnly
            ): true
            case member is MemberAccessExpressionSyntax when MutatingStructAccessorWritesSymbol(
                member,
                member.Expression,
                symbol,
                model
            ): true
            case element is ElementAccessExpressionSyntax when MutatingStructAccessorWritesSymbol(
                element,
                element.Expression,
                symbol,
                model
            ): true
            default: false
        }

        private func BindsTo(expression ExpressionSyntax?, target ISymbol?, model SemanticModel) bool {
            var expression = expression
            expression = UnwrapParenthesesAndSuppressions(expression)
            let symbol ISymbol? = model.GetSymbolInfo(expression!!).Symbol
            return symbol != nil && SymbolEqualityComparer.Default.Equals(symbol, target)
        }

        // Transparent wrappers change neither storage identity nor collection elements.
        private func UnwrapParenthesesAndSuppressions(expression ExpressionSyntax?) ExpressionSyntax? {
            var expression = expression
            while true {
                if expression is ParenthesizedExpressionSyntax parenthesized {
                    expression = parenthesized.Expression
                    continue
                }
                if expression is PostfixUnaryExpressionSyntax suppression && suppression.IsKind(
                    SyntaxKind.SuppressNullableWarningExpression
                ) {
                    expression = suppression.Operand
                    continue
                }
                return expression
            }
        }

        private func TupleAssignmentTargetsInclude(
            tuple TupleExpressionSyntax,
            symbol ISymbol?,
            model SemanticModel
        ) bool {
            for argument in tuple.Arguments {
                switch argument.Expression {
                    case nested is TupleExpressionSyntax when TupleAssignmentTargetsInclude(nested, symbol, model) {
                        return true
                    }
                    case DeclarationExpressionSyntax { }
                    default {
                        if WritesStorageOf(argument.Expression, symbol, model) {
                            return true
                        }
                    }
                }
            }
            return false
        }

        private func WritesStorageOf(target ExpressionSyntax?, symbol ISymbol?, model SemanticModel) bool {
            var target = target
            while true {
                target = UnwrapParenthesesAndSuppressions(target)
                if BindsTo(target, symbol, model) {
                    return true
                }
                let receiver ExpressionSyntax? = switch target {
                    case member is MemberAccessExpressionSyntax when member.IsKind(
                        SyntaxKind.SimpleMemberAccessExpression
                    ): member.Expression
                    case element is ElementAccessExpressionSyntax: element.Expression
                    default: default(ExpressionSyntax?)
                }
                if receiver == nil || model.GetTypeInfo(receiver).Type is not{IsReferenceType: false} {
                    return false
                }
                target = receiver
            }
        }

        private func MutatingStructCallWritesSymbol(
            invocation InvocationExpressionSyntax,
            member MemberAccessExpressionSyntax,
            symbol ISymbol?,
            model SemanticModel
        ) bool {
            if model.GetSymbolInfo(invocation)
                .Symbol is not IMethodSymbol method ||
                method.IsStatic ||
                method.IsReadOnly ||
                method.IsExtensionMethod ||
                (
                method.ContainingType is {IsReferenceType: true} container && container.TypeKind != TypeKind.Interface
            ) {
                return false
            }
            let receiverType ITypeSymbol? = model.GetTypeInfo(member.Expression).Type
            let mutableValueReceiver = if receiverType is ITypeParameterSymbol typeParameter {
                !typeParameter.IsReferenceType
            } else {
                receiverType is INamedTypeSymbol named && named.TypeKind == TypeKind.Struct && !named.IsReadOnly
            }
            return mutableValueReceiver && WritesStorageOf(member.Expression, symbol, model)
        }

        private func MutatingStructAccessorWritesSymbol(
            access ExpressionSyntax,
            receiver ExpressionSyntax,
            symbol ISymbol?,
            model SemanticModel
        ) bool {
            if model.GetSymbolInfo(access)
                .Symbol is not IPropertySymbol property ||
                property.GetMethod is not{IsReadOnly: false} ||
                (
                property.ContainingType is {IsReferenceType: true} container && container.TypeKind != TypeKind.Interface
            ) {
                return false
            }
            let receiverType ITypeSymbol? = model.GetTypeInfo(receiver).Type
            let mutableValueReceiver = if receiverType is ITypeParameterSymbol typeParameter {
                !typeParameter.IsReferenceType
            } else {
                receiverType is INamedTypeSymbol named && named.TypeKind == TypeKind.Struct && !named.IsReadOnly
            }
            return mutableValueReceiver && WritesStorageOf(receiver, symbol, model)
        }

        private func ExtensionReceiverWritesSymbol(
            invocation InvocationExpressionSyntax,
            receiver ExpressionSyntax,
            symbol ISymbol?,
            model SemanticModel
        ) bool {
            if !WritesStorageOf(receiver, symbol, model) || model.GetOperation(
                invocation
            ) is not IInvocationOperation operation ||
                !operation
                .TargetMethod
                .IsExtensionMethod {
                return false
            }
            let extensionMethod = operation.TargetMethod.ReducedFrom ?? operation.TargetMethod
            if extensionMethod.Parameters.IsEmpty {
                return false
            }
            let refKind = extensionMethod.Parameters[0].RefKind
            return refKind == RefKind.Ref || refKind == RefKind.Out
        }
    }
}
