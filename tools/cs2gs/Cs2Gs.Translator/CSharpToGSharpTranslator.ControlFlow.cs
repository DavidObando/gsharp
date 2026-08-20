// <copyright file="CSharpToGSharpTranslator.ControlFlow.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
using Microsoft.CodeAnalysis.Text;

namespace Cs2Gs.Translator;

public sealed partial class CSharpToGSharpTranslator
{
    private sealed partial class DeclarationVisitor
    {
        /// <summary>
        /// Lowers a <c>while</c>/<c>do-while</c> whose condition carries an
        /// <c>is</c>-pattern clause that would otherwise duplicate a side-effecting
        /// scrutinee or leak a binder the G# loop body cannot see (issue #914).
        /// <para>
        /// C# allows a loop condition such as
        /// <c>M(out var n) is Frame child and not EmptyFrame</c>, binding
        /// <c>child</c>/<c>n</c> for the loop body. G# has no <c>and</c>/<c>not</c>
        /// pattern combinators (only <c>&amp;&amp;</c>/<c>!</c>), so the combinator
        /// lowering re-emits the scrutinee per sub-test — re-running the call and
        /// re-declaring <c>out var n</c> (→ GS0102). Pattern/out-var bindings
        /// that cannot use native <c>while let</c> are also invisible in an
        /// ordinary G# <c>while</c> body (GS0125).
        /// </para>
        /// <para>
        /// The condition is split on its top-level <c>&amp;&amp;</c> clauses. The
        /// leading side-effect-free clauses stay the real loop condition; from the
        /// first clause that binds or duplicates a side-effecting scrutinee onward,
        /// each clause is hoisted to the top of the loop body — the scrutinee
        /// evaluated once into a local, the remaining must-hold tests converted to
        /// <c>if !test { break }</c> guards:
        /// <code>
        /// while a &amp;&amp; b &amp;&amp; M(out var n) is Frame child and not EmptyFrame { … }
        /// // becomes
        /// while a &amp;&amp; b {
        ///     let child = M(out var n)
        ///     if child is EmptyFrame { break }
        ///     …
        /// }
        /// </code>
        /// Returns <see langword="false"/> (keep the plain <c>while cond { }</c>
        /// form) when no clause needs hoisting, so simple loops are unaffected.
        /// </para>
        /// </summary>
        private bool TryTranslateLoopWithConditionHoist(
            ExpressionSyntax condition,
            StatementSyntax bodyStatement,
            bool isDoWhile,
            out IReadOnlyList<GStatement> result)
        {
            result = null;

            // ADR-0166: a loop condition whose designations are native pattern
            // variables stays a plain `for cond { }`; the body sees the
            // when-true variables directly.
            if (this.ConditionUsesNativePatternVariables(condition))
            {
                return false;
            }

            if (!isDoWhile &&
                this.TryBuildWhileLetLoop(condition, bodyStatement, out IReadOnlyList<GStatement> whileLet))
            {
                result = whileLet;
                return true;
            }

            if (!this.TryBuildHoistedLoopCondition(condition, out GExpression loopCondition, out List<GStatement> hoisted, out bool hoistsAssignment))
            {
                return false;
            }

            if (isDoWhile && hoistsAssignment && BodyContainsOwnLoopContinue(bodyStatement))
            {
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
                    "assignment inside a short-circuited '&&'/'||' operand or a conditional ('?:') branch has no side-effect-preserving G# lowering yet (issue #1723).");
                return false;
            }

            BlockStatement originalBody = this.TranslateStatementAsBlock(bodyStatement);
            var bodyStatements = new List<GStatement>();
            if (isDoWhile)
            {
                // C# `do { body } while (cond)` evaluates `cond` AFTER the body runs,
                // so the hoisted assignment/break-guard must trail the body (not lead
                // it), or the first body iteration would observe a write that hasn't
                // happened yet (issue #1723).
                bodyStatements.AddRange(originalBody.Statements);
                bodyStatements.AddRange(hoisted);
            }
            else
            {
                bodyStatements.AddRange(hoisted);
                bodyStatements.AddRange(originalBody.Statements);
            }

            var body = new BlockStatement(bodyStatements);

            result = isDoWhile
                ? new GStatement[] { new DoWhileStatement(body, GuardBlockCondition(loopCondition)) }
                : new GStatement[] { new WhileStatement(GuardBlockCondition(loopCondition), body) };
            return true;
        }

        // True for a node that starts a NEW `continue` seam: a nested loop (its
        // own `continue` target) or a lambda/local function (C# forbids a jump
        // statement crossing that boundary at all). Shared by the do-while tail
        // hoist scan (issue #1723) and the for→while incrementor-on-continue fix
        // (issue #1732) so both agree on what "targets THIS loop" means. Note a
        // `switch` is NOT a boundary: `continue` (unlike `break`) passes through a
        // `switch` straight to the enclosing loop.
        private static bool IsOwnLoopContinueBoundary(SyntaxNode node) =>
            node is ForStatementSyntax or ForEachStatementSyntax or ForEachVariableStatementSyntax or
                WhileStatementSyntax or DoStatementSyntax or
                AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax;

        // True when `body` has a `continue` that targets THIS loop. Descent stops
        // at any nested loop/switch (its own `continue`/`break` seam) and at
        // nested lambdas/local functions (their own statement seam), so a
        // `continue` inside an inner `for`/`foreach`/`while`/`do`/`switch` does
        // NOT count — it never reaches this loop's do-while tail hoist (issue
        // #1723).
        private static bool BodyContainsOwnLoopContinue(StatementSyntax body)
        {
            bool DescendGuard(SyntaxNode node) => !IsOwnLoopContinueBoundary(node);

            return body.DescendantNodesAndSelf(descendIntoChildren: DescendGuard).OfType<ContinueStatementSyntax>().Any();
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
        private static bool OwnLoopContinueCrossesFinally(StatementSyntax body)
        {
            bool DescendGuard(SyntaxNode node) => !IsOwnLoopContinueBoundary(node);

            foreach (ContinueStatementSyntax continueStatement in
                body.DescendantNodesAndSelf(descendIntoChildren: DescendGuard).OfType<ContinueStatementSyntax>())
            {
                for (SyntaxNode ancestor = continueStatement.Parent; ancestor != null; ancestor = ancestor.Parent)
                {
                    if (ancestor is TryStatementSyntax tryStatement && tryStatement.Finally != null)
                    {
                        return true;
                    }

                    if (ancestor == body)
                    {
                        break;
                    }
                }
            }

            return false;
        }

        /// <summary>
        /// Splits <paramref name="condition"/> into its top-level `&amp;&amp;` clauses and,
        /// if any clause needs hoisting (an `is`-pattern requiring a scrutinee
        /// local, or a value-position assignment), returns the leading
        /// side-effect-free clauses as <paramref name="loopCondition"/> and the
        /// rest as body-prologue <paramref name="hoisted"/> statements (a scrutinee
        /// local / hoisted assignment plus `if !test { break }` guards) — shared by
        /// `while`, `do`/`while`, and `for` loop translation (issue #914, #1723).
        /// Returns <c>false</c> (no hoisting needed) when every clause is plain.
        /// </summary>
        private bool TryBuildHoistedLoopCondition(
            ExpressionSyntax condition,
            out GExpression loopCondition,
            out List<GStatement> hoisted,
            out bool hoistsAssignment)
        {
            loopCondition = null;
            hoisted = null;
            hoistsAssignment = false;

            var clauses = new List<ExpressionSyntax>();
            FlattenAndClauses(condition, clauses);

            int firstHoist = -1;
            for (int i = 0; i < clauses.Count; i++)
            {
                if (this.ClauseRequiresConditionHoist(clauses[i]))
                {
                    firstHoist = i;
                    break;
                }
            }

            if (firstHoist < 0)
            {
                return false;
            }

            for (int i = firstHoist; i < clauses.Count; i++)
            {
                if (ClauseContainsAssignment(clauses[i]))
                {
                    hoistsAssignment = true;
                    break;
                }
            }

            // The leading side-effect-free clauses remain the real loop condition.
            GExpression combined = null;
            for (int i = 0; i < firstHoist; i++)
            {
                GExpression clause = this.TranslateExpression(clauses[i]);
                combined = combined == null
                    ? clause
                    : new BinaryExpression(combined, "&&", clause);
            }

            combined ??= LiteralExpression.Bool(true);

            // The remaining clauses hoist to the top of the loop body as a single
            // scrutinee evaluation / assignment plus `if !test { break }` guards.
            var prologue = new List<GStatement>();
            for (int i = firstHoist; i < clauses.Count; i++)
            {
                this.HoistLoopConditionClause(clauses[i], prologue);
            }

            loopCondition = combined;
            hoisted = prologue;
            return true;
        }

        // Flattens the left-to-right top-level `&&` operands of a condition into
        // `clauses`. Parentheses are transparent for the split.
        private static void FlattenAndClauses(ExpressionSyntax expression, List<ExpressionSyntax> clauses)
        {
            ExpressionSyntax expr = expression;
            while (expr is ParenthesizedExpressionSyntax paren)
            {
                expr = paren.Expression;
            }

            if (expr is BinaryExpressionSyntax binary && binary.IsKind(SyntaxKind.LogicalAndExpression))
            {
                FlattenAndClauses(binary.Left, clauses);
                FlattenAndClauses(binary.Right, clauses);
            }
            else
            {
                clauses.Add(expr);
            }
        }

        // A loop-condition clause needs hoisting when it declares an `out var`
        // more than once (GS0102), or binds a pattern variable the G# loop body
        // cannot see (GS0125); or when it contains one of the few assignment
        // shapes that still lacks a native value-position form.
        private bool ClauseRequiresConditionHoist(ExpressionSyntax clause)
        {
            return (clause is IsPatternExpressionSyntax isPattern &&
                ((PatternIntroducesBinding(isPattern.Pattern)
                    && !this.ConditionUsesNativePatternVariables(GetConditionRoot(isPattern))) ||
                 ExpressionDeclaresOutVar(isPattern.Expression))) ||
                ClauseContainsAssignment(clause);
        }

        // Cheap presence check used only to decide whether a clause needs the
        // hoist path at all; the short-circuit/`?:` safety analysis and the
        // actual hoisting happen once, in HoistLoopConditionClause.
        private static bool ClauseContainsAssignment(ExpressionSyntax clause) =>
            clause.DescendantNodesAndSelf(descendIntoChildren: node =>
                    node is not (AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax))
                .OfType<AssignmentExpressionSyntax>()
                .Any(AssignmentRequiresStatementLowering);

        private static bool PatternIntroducesBinding(PatternSyntax pattern) =>
            pattern.DescendantNodesAndSelf().OfType<SingleVariableDesignationSyntax>().Any();

        private static bool ExpressionDeclaresOutVar(ExpressionSyntax expression) =>
            expression.DescendantNodesAndSelf().OfType<DeclarationExpressionSyntax>().Any();

        // Emits the fallback statements for a loop-condition clause that still
        // needs body scope: deconstruction assignments and binding patterns.
        private void HoistLoopConditionClause(ExpressionSyntax clause, List<GStatement> into)
        {
            // Any spill hoisted while translating `clause` (issue #1731 — e.g. a
            // non-trivial pattern scrutinee nested inside the
            // condition) must land in `into`, which runs at the START of each loop
            // iteration — NOT in the enclosing loop STATEMENT's own prologue (that
            // would evaluate the operand once, before the loop, instead of once
            // per iteration as C# does).
            List<GStatement> outerSpillPrologue = this.state.PendingSpillPrologue;
            this.state.PendingSpillPrologue = into;
            try
            {
                this.HoistLoopConditionClauseCore(clause, into);
            }
            finally
            {
                this.state.PendingSpillPrologue = outerSpillPrologue;
            }
        }

        private void HoistLoopConditionClauseCore(ExpressionSyntax clause, List<GStatement> into)
        {
            if (clause is not IsPatternExpressionSyntax isPattern)
            {
                var replacements = new List<ExpressionSyntax>();
                List<AssignmentExpressionSyntax> embedded =
                    this.HoistAssignmentsInOrder(
                        clause,
                        includeSelf: true,
                        into,
                        replacements);
                if (embedded.Count == 0)
                {
                    into.Add(BreakIf(Negate(this.TranslateExpression(clause))));
                    return;
                }

                try
                {
                    into.Add(BreakIf(Negate(this.TranslateExpression(clause))));
                }
                finally
                {
                    this.ReleaseHoistedAssignments(embedded, replacements);
                }

                return;
            }

            // Issue #1967: a loop-condition `is`-pattern (`while (x is Index i)`)
            // never reaches `TranslateIsPattern` — it is hoisted here instead — so
            // its designations need the same guard applied at this entry point.
            this.ReportIndexOrRangeDesignationsInPattern(isPattern.Pattern);

            GExpression receiver = this.TranslateExpression(isPattern.Expression);
            ITypeSymbol scrutineeType = this.context.GetTypeInfo(isPattern.Expression).Type;

            // The hoist local reuses a top-level binder's name when present (so body
            // references to that binder print as the hoist local); otherwise a fresh
            // synthetic name is used.
            ILocalSymbol mainBinder = this.FindMainPatternBinder(isPattern.Pattern);
            string hoistName = mainBinder != null
                ? this.EmittedName(mainBinder, mainBinder.Name)
                : $"__scrutinee{this.state.LoopHoistCounter++}";

            BindingKind binding = mainBinder != null && this.IsLocalReassigned(mainBinder)
                ? BindingKind.Var
                : BindingKind.Let;

            into.Add(new LocalDeclarationStatement(binding, hoistName, type: null, initializer: receiver));

            var idExpr = new IdentifierExpression(hoistName);

            // Any secondary binder prints as the hoist local inside the body.
            foreach (ILocalSymbol binder in this.EnumeratePatternBinders(isPattern.Pattern))
            {
                if (!SymbolEqualityComparer.Default.Equals(binder, mainBinder))
                {
                    this.state.PatternBindings[binder] = idExpr;
                }
            }

            this.EmitMustHoldGuards(idExpr, scrutineeType, isPattern.Pattern, mainBinder, into);
        }

        // Converts a must-hold pattern over the already-hoisted `idExpr` into a list
        // of `if !test { break }` guards. An `and` combinator splits into one guard
        // per side; a `not P` breaks when `P` matches; the main binder whose static
        // type already satisfies its type test is a bind-only (no guard).
        private void EmitMustHoldGuards(
            GExpression idExpr,
            ITypeSymbol scrutineeType,
            PatternSyntax pattern,
            ILocalSymbol mainBinder,
            List<GStatement> into)
        {
            switch (pattern)
            {
                case ParenthesizedPatternSyntax parenthesized:
                    this.EmitMustHoldGuards(idExpr, scrutineeType, parenthesized.Pattern, mainBinder, into);
                    return;

                case BinaryPatternSyntax andPattern when andPattern.OperatorToken.IsKind(SyntaxKind.AndKeyword):
                    this.EmitMustHoldGuards(idExpr, scrutineeType, andPattern.Left, mainBinder, into);
                    this.EmitMustHoldGuards(idExpr, scrutineeType, andPattern.Right, mainBinder, into);
                    return;

                case UnaryPatternSyntax notPattern when notPattern.IsKind(SyntaxKind.NotPattern):
                    // `not P` must hold → break when `P` matches.
                    into.Add(BreakIf(this.TranslatePatternTest(idExpr, notPattern.Pattern, scrutineeType)));
                    return;

                case DeclarationPatternSyntax declaration
                    when this.IsBindOnlyMainBinder(declaration, scrutineeType, mainBinder):
                    // The main binder whose static type already satisfies the test is
                    // a non-null bind (e.g. a method returning a non-null `Frame`); no
                    // guard is needed and the binder prints as the hoist local.
                    return;

                case DeclarationPatternSyntax declaration:
                    // A secondary type-binder: emit the type test as a break guard;
                    // references to the binder print as the hoist local (registered by
                    // HoistLoopConditionClause).
                    into.Add(BreakIf(Negate(new BinaryExpression(
                        idExpr, "is", new TypeExpression(this.MapTypeSyntax(declaration.Type))))));
                    return;

                default:
                    into.Add(BreakIf(Negate(this.TranslatePatternTest(idExpr, pattern, scrutineeType))));
                    return;
            }
        }

        // True when `declaration` binds the hoist local and the scrutinee's static
        // type already (non-nullably) satisfies the declared type — so the type test
        // is statically true and the pattern is a pure binding.
        private bool IsBindOnlyMainBinder(
            DeclarationPatternSyntax declaration, ITypeSymbol scrutineeType, ILocalSymbol mainBinder)
        {
            if (mainBinder == null ||
                declaration.Designation is not SingleVariableDesignationSyntax single ||
                this.context.GetDeclaredSymbol(single) is not ILocalSymbol symbol ||
                !SymbolEqualityComparer.Default.Equals(symbol, mainBinder))
            {
                return false;
            }

            ITypeSymbol target = this.context.GetTypeInfo(declaration.Type).Type;
            return IsAssignableNonNull(scrutineeType, target);
        }

        // True when `scrutineeType` is a non-nullable reference convertible to
        // `target` by identity or base/interface — i.e. `scrutinee is target` is
        // statically guaranteed.
        private static bool IsAssignableNonNull(ITypeSymbol scrutineeType, ITypeSymbol target)
        {
            if (scrutineeType == null || target == null ||
                scrutineeType.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return false;
            }

            for (ITypeSymbol t = scrutineeType; t != null; t = t.BaseType)
            {
                if (SymbolEqualityComparer.Default.Equals(t, target))
                {
                    return true;
                }
            }

            return scrutineeType.AllInterfaces.Any(i => SymbolEqualityComparer.Default.Equals(i, target));
        }

        private ILocalSymbol FindMainPatternBinder(PatternSyntax pattern) =>
            this.EnumeratePatternBinders(pattern).FirstOrDefault();

        private IEnumerable<ILocalSymbol> EnumeratePatternBinders(PatternSyntax pattern)
        {
            foreach (SyntaxNode node in pattern.DescendantNodesAndSelf())
            {
                if (node is SingleVariableDesignationSyntax single &&
                    this.context.GetDeclaredSymbol(single) is ILocalSymbol symbol)
                {
                    yield return symbol;
                }
            }
        }

        private static GStatement BreakIf(GExpression condition) =>
            new IfStatement(condition, new BlockStatement(new GStatement[] { new BreakStatement() }));

        private static GExpression Negate(GExpression expression) =>
            new UnaryExpression("!", new ParenthesizedExpression(expression));

        /// <summary>
        /// Translates an <c>if</c> statement into one or more G# statements. A C#
        /// negated type-pattern guard with a designation (<c>if (x is not T t) {
        /// throw/return; }</c>) needs the binder <c>t</c> to remain in scope *after*
        /// the <c>if</c> (the then-block exits), and a property-path receiver cannot
        /// be smart-cast — so it is lowered to a hoisted nullable local plus a
        /// nil-guard (<see cref="TryBuildNegatedGuardHoist"/>). Every other form maps
        /// to the single-statement <see cref="TranslateIf"/>.
        /// </summary>
        private IEnumerable<GStatement> TranslateIfStatements(IfStatementSyntax ifStatement)
        {
            // ADR-0166 / issue #3409: when every `is` designation in the condition
            // is a native G# pattern variable, the plain `if` keeps the C# shape
            // and names; the `if let` / guard-hoist lowerings below only serve
            // conditions the native scoping cannot express.
            if (this.ConditionUsesNativePatternVariables(ifStatement.Condition))
            {
                return new[] { this.TranslateIf(ifStatement) };
            }

            // Issue #3359: `if (recv is { } name) { … }` has a canonical G# form —
            // the ADR-0071 `if let` statement — that binds the name at its
            // non-null type and evaluates `recv` exactly once by construction.
            // Tried FIRST because the general pattern lowering would otherwise
            // spill `recv` into a `let __spillN`, destroying the author's binder
            // name and adding a `!!` at every read. The helper is conservative
            // and translates nothing when it declines.
            if (this.TryBuildIfLetGuard(ifStatement, out IReadOnlyList<GStatement> ifLetHoisted))
            {
                return ifLetHoisted;
            }

            if (this.TryBuildNegatedGuardHoist(ifStatement, out IReadOnlyList<GStatement> hoisted))
            {
                return hoisted;
            }

            if (this.TryBuildPositiveGuardHoist(ifStatement, out IReadOnlyList<GStatement> positiveHoisted))
            {
                return positiveHoisted;
            }

            return this.TranslateIfWithConditionPrologue(ifStatement);
        }

        private GStatement TranslateElseStatement(StatementSyntax statement)
        {
            if (statement is not IfStatementSyntax elseIf)
            {
                return this.TranslateStatementAsBlock(statement);
            }

            List<GStatement> translated = this.TranslateIfStatements(elseIf).ToList();
            return translated.Count == 1
                ? translated[0]
                : new BlockStatement(translated);
        }

        /// <summary>
        /// Lowers a C# positive type-pattern guard <c>if (receiver is T t) { … }</c>
        /// to a smart-cast-friendly G# local that preserves the declaration
        /// variable's identity.
        /// <code>
        /// let t T? = receiver as T   // reference target
        /// if t != nil { … }
        ///
        /// let __spill0 = receiver    // value target
        /// var t T
        /// if __spill0 is T { t = T(__spill0); … }
        /// </code>
        /// Value-pattern binders use a separate typed local so their reads do not
        /// rely on flow narrowing through an enclosing try/block. Reference targets
        /// retain the nullable-local lowering used for G# nil narrowing.
        /// </summary>
        private bool TryBuildPositiveGuardHoist(
            IfStatementSyntax ifStatement, out IReadOnlyList<GStatement> result)
        {
            result = null;

            DecomposeConjunction(
                ifStatement.Condition,
                out ExpressionSyntax leftmost,
                out List<ExpressionSyntax> guards);
            if (leftmost is not IsPatternExpressionSyntax isPattern ||
                !TryExtractSingleVarTypePattern(
                    isPattern.Pattern, out TypeSyntax typeSyntax, out SingleVariableDesignationSyntax single))
            {
                return false;
            }

            if (guards.Any(guard => ContainsSpillHoistingConstruct(guard, includeOutVarDeclarations: false)))
            {
                return false;
            }

            ITypeSymbol targetSymbol = this.context.GetTypeInfo(typeSyntax).Type;
            if (targetSymbol == null)
            {
                return false;
            }

            if (this.context.GetDeclaredSymbol(single) is not ILocalSymbol patternSymbol)
            {
                return false;
            }

            GTypeReference targetType = this.MapTypeSyntax(typeSyntax);
            string localName = this.EmittedName(single, single.Identifier);
            GExpression receiver = this.TranslateExpression(isPattern.Expression);

            if (targetSymbol.IsValueType)
            {
                result = this.BuildPositiveValueGuardHoist(ifStatement, guards, localName, targetType, receiver);
                return true;
            }

            // Record that this pattern variable is now a nullable G# local so an
            // assignment-LHS use inside the guard is null-forgiven (gsc narrows
            // reads but not write receivers).
            this.state.HoistedNullableGuardLocals.Add(patternSymbol);

            // `var t T? = receiver as T` when the leaked variable is reassigned
            // anywhere in the body (C# allows it); otherwise an immutable `let`.
            BindingKind binding = this.IsLocalReassigned(patternSymbol)
                ? BindingKind.Var
                : BindingKind.Let;

            var local = new IdentifierExpression(localName);
            GTypeReference localType = targetSymbol.IsValueType ? null : MakeNullable(targetType);
            GExpression initializer = targetSymbol.IsValueType
                ? receiver
                : new BinaryExpression(receiver, "as", new TypeExpression(targetType));
            var hoist = new LocalDeclarationStatement(
                binding,
                localName,
                localType,
                initializer);

            GExpression guard = targetSymbol.IsValueType
                ? new BinaryExpression(local, "is", new TypeExpression(targetType))
                : new BinaryExpression(local, "!=", LiteralExpression.Null());
            foreach (ExpressionSyntax conjunct in guards)
            {
                guard = new BinaryExpression(guard, "&&", this.TranslateExpression(conjunct));
            }

            BlockStatement then = this.TranslateStatementAsBlock(ifStatement.Statement);

            GStatement elseBranch = null;
            if (ifStatement.Else != null)
            {
                elseBranch = this.TranslateElseStatement(ifStatement.Else.Statement);
            }

            // gsc narrows `local` throughout the guarded block, but does not carry
            // that fact past the `if` when an exiting `else` makes C#'s pattern
            // variable definitely assigned afterward. Keep later reads tied to
            // the named local and materialize the already-proven target view.
            if (targetSymbol.IsValueType && targetType is NamedTypeReference namedTarget)
            {
                this.state.PatternBindings[patternSymbol] = new InvocationExpression(
                    new IdentifierExpression(namedTarget.Name),
                    new[] { local },
                    namedTarget.TypeArguments);
            }
            else
            {
                this.state.PatternBindings[patternSymbol] = new NonNullAssertionExpression(local);
            }

            result = new GStatement[] { hoist, new IfStatement(guard, then, elseBranch) };
            if (elseBranch != null)
            {
                this.ReportPatternGuardControlTransferMismatch(
                    ifStatement,
                    result,
                    new GStatement[] { then, elseBranch });
            }

            return true;
        }

        private IReadOnlyList<GStatement> BuildPositiveValueGuardHoist(
            IfStatementSyntax ifStatement,
            IReadOnlyList<ExpressionSyntax> guards,
            string localName,
            GTypeReference targetType,
            GExpression receiver)
        {
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
            GExpression scrutinee = receiver;
            LocalDeclarationStatement hoist = null;
            if (!IsTrivialOperand(receiver))
            {
                string spillName = $"__spill{this.state.SpillCounter++}";
                scrutinee = new IdentifierExpression(spillName);
                hoist = new LocalDeclarationStatement(
                    BindingKind.Let,
                    spillName,
                    type: null,
                    initializer: receiver);
            }

            GExpression spill = scrutinee;
            var binder = new LocalDeclarationStatement(BindingKind.Var, localName, targetType);
            var guard = new BinaryExpression(spill, "is", new TypeExpression(targetType));

            GExpression narrowed = targetType is NamedTypeReference namedTarget
                ? new InvocationExpression(
                    new IdentifierExpression(namedTarget.Name),
                    new[] { spill },
                    namedTarget.TypeArguments)
                : new NonNullAssertionExpression(spill);
            var thenStatements = new List<GStatement>
            {
                new AssignmentStatement(new IdentifierExpression(localName), narrowed),
            };

            GStatement elseBranch = ifStatement.Else == null
                ? null
                : this.TranslateElseStatement(ifStatement.Else.Statement);
            BlockStatement body = this.TranslateStatementAsBlock(ifStatement.Statement);
            if (guards.Count == 0)
            {
                thenStatements.AddRange(body.Statements);
            }
            else if (elseBranch == null)
            {
                GExpression guardExpression = null;
                foreach (ExpressionSyntax guardClause in guards)
                {
                    GExpression translated = this.TranslateExpression(guardClause);
                    guardExpression = guardExpression == null
                        ? translated
                        : new BinaryExpression(guardExpression, "&&", translated);
                }

                thenStatements.Add(new IfStatement(guardExpression, body, elseBranch));
            }
            else
            {
                GExpression guardExpression = null;
                foreach (ExpressionSyntax guardClause in guards)
                {
                    GExpression translated = this.TranslateExpression(guardClause);
                    guardExpression = guardExpression == null
                        ? translated
                        : new BinaryExpression(guardExpression, "&&", translated);
                }

                string endLabel = $"__patternGuardEnd{ifStatement.SpanStart}";
                List<GStatement> matchedBody = body.Statements.ToList();
                matchedBody.Add(new GotoStatement(endLabel));
                thenStatements.Add(new IfStatement(
                    guardExpression,
                    new BlockStatement(matchedBody)));

                var guardedStatements = new List<GStatement>();
                if (hoist != null)
                {
                    guardedStatements.Add(hoist);
                }

                guardedStatements.Add(binder);
                guardedStatements.Add(new IfStatement(
                    guard,
                    new BlockStatement(thenStatements)));
                guardedStatements.Add(elseBranch);
                guardedStatements.Add(new LabeledStatement(
                    endLabel,
                    new BlockStatement(new List<GStatement>())));
                this.ReportPatternGuardControlTransferMismatch(
                    ifStatement,
                    guardedStatements,
                    new GStatement[] { body, elseBranch });
                return guardedStatements;
            }

            var statements = new List<GStatement>();
            if (hoist != null)
            {
                statements.Add(hoist);
            }

            statements.Add(binder);
            statements.Add(new IfStatement(
                guard,
                new BlockStatement(thenStatements),
                guards.Count == 0 ? elseBranch : null));
            if (elseBranch != null)
            {
                this.ReportPatternGuardControlTransferMismatch(
                    ifStatement,
                    statements,
                    new GStatement[] { body, elseBranch });
            }

            return statements;
        }

        /// <summary>
        /// A scrutinee is smart-castable by gsc only when it is a bare local or
        /// parameter reference; gsc narrows locals, not method-call results,
        /// member-access chains, or field references (ADR-0069). When the scrutinee
        /// is not smart-castable, an <c>x is T t</c> whose binder is used in the
        /// guarded block must hoist the scrutinee into a local (so the local
        /// smart-casts) rather than re-emit the expression at each use of <c>t</c>.
        /// </summary>
        private bool IsSmartCastableScrutinee(ExpressionSyntax expression)
        {
            if (expression is not IdentifierNameSyntax)
            {
                return false;
            }

            ISymbol symbol = this.context.GetSymbolInfo(expression).Symbol;
            return symbol is ILocalSymbol or IParameterSymbol;
        }

        // Extracts the target type and single-variable designation from a positive
        // declaration / recursive type-pattern (`x is T t`, `x is T { } t`). Returns
        // false for any other pattern shape (constant, relational, property
        // subpatterns, multi-variable designations).
        private static bool TryExtractSingleVarTypePattern(
            PatternSyntax pattern,
            out TypeSyntax typeSyntax,
            out SingleVariableDesignationSyntax single)
        {
            typeSyntax = null;
            single = null;

            VariableDesignationSyntax designation;
            switch (pattern)
            {
                case DeclarationPatternSyntax declaration:
                    typeSyntax = declaration.Type;
                    designation = declaration.Designation;
                    break;

                case RecursivePatternSyntax { Type: { } recursiveType } recursive
                    when recursive.PropertyPatternClause is null or { Subpatterns.Count: 0 }:
                    typeSyntax = recursiveType;
                    designation = recursive.Designation;
                    break;

                default:
                    return false;
            }

            single = designation as SingleVariableDesignationSyntax;
            return single != null;
        }

        /// <summary>
        /// Lowers a C# negated type-pattern guard <c>if (receiver is not T t) {
        /// … }</c> to the smart-cast-friendly G# form below.
        /// <code>
        /// let t T? = receiver as T
        /// if t == nil { … }
        /// </code>
        /// The binder <c>t</c> becomes a real hoisted local that survives past the
        /// <c>if</c> (so later <c>t.Member</c> uses bind to it under G#'s Kotlin-style
        /// smart cast), and a property-path receiver (<c>child.Header</c>) is
        /// evaluated once into the local. Applies to a negated declaration/recursive
        /// type-pattern with a single-variable designation over a reference (or
        /// nullable value) target type, where <c>as T</c> + nil-guard is valid, AND
        /// to a bare negated recursive pattern with no type test (<c>is not { } t</c>,
        /// issue #2233) — there <c>t</c>'s target type is the receiver's own
        /// (non-null) type, so no <c>as</c> conversion is emitted; the receiver is
        /// hoisted as-is into the nullable local (a nullable value-type receiver,
        /// e.g. a <c>DateTimeOffset?</c> field, unwraps to its non-null <c>T</c>).
        /// </summary>
        private bool TryBuildNegatedGuardHoist(
            IfStatementSyntax ifStatement, out IReadOnlyList<GStatement> result)
        {
            result = null;

            var terms = new List<ExpressionSyntax>();
            CollectLogicalOrTerms(ifStatement.Condition, terms);
            if (this.TryBuildNestedNegatedGuardHoist(ifStatement, terms, out result))
            {
                return true;
            }

            int negatedPatternCount = terms.Count(term =>
                TryExtractNegatedGuardPattern(term, out _, out _, out _, out _));
            if (negatedPatternCount > 1)
            {
                return this.TryBuildMultipleNegatedGuardHoists(ifStatement, terms, out result);
            }

            IsPatternExpressionSyntax isPattern = null;
            TypeSyntax typeSyntax = null;
            VariableDesignationSyntax designation = null;
            RecursivePatternSyntax residualPattern = null;
            int patternIndex = -1;
            for (int i = 0; i < terms.Count; i++)
            {
                if (!TryExtractNegatedGuardPattern(
                        terms[i],
                        out IsPatternExpressionSyntax candidatePattern,
                        out TypeSyntax candidateType,
                        out VariableDesignationSyntax candidateDesignation,
                        out RecursivePatternSyntax candidateResidualPattern))
                {
                    continue;
                }

                if (patternIndex >= 0)
                {
                    return false;
                }

                isPattern = candidatePattern;
                typeSyntax = candidateType;
                designation = candidateDesignation;
                residualPattern = candidateResidualPattern;
                patternIndex = i;
            }

            if (patternIndex < 0)
            {
                return false;
            }

            if (patternIndex > 0
                && ifStatement.Else == null
                && !StatementAlwaysExits(ifStatement.Statement))
            {
                return false;
            }

            if (designation is not SingleVariableDesignationSyntax single)
            {
                return false;
            }

            string localName = this.EmittedName(single, single.Identifier);
            GExpression receiver = this.TranslateExpression(isPattern.Expression);
            GExpression hoistInitializer;
            GTypeReference targetType;

            if (typeSyntax != null)
            {
                // The hoisted `as T` + `== nil` guard is only valid when T is a
                // reference type (or nullable value type); a non-nullable value-type
                // target keeps the existing then-block binding behaviour.
                ITypeSymbol targetSymbol = this.context.GetTypeInfo(typeSyntax).Type;
                if (targetSymbol == null)
                {
                    return false;
                }

                targetType = this.MapTypeSyntax(typeSyntax);
                if (targetSymbol.IsValueType)
                {
                    if (this.context.GetTypeInfo(isPattern.Expression).Type is INamedTypeSymbol receiverType
                        && receiverType.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T
                        && receiverType.TypeArguments.Length == 1
                        && SymbolEqualityComparer.Default.Equals(receiverType.TypeArguments[0], targetSymbol))
                    {
                        hoistInitializer = receiver;
                    }
                    else
                    {
                        hoistInitializer = new BinaryExpression(
                            receiver,
                            "as",
                            new TypeExpression(MakeNullable(targetType)));
                    }
                }
                else
                {
                    hoistInitializer = new BinaryExpression(receiver, "as", new TypeExpression(targetType));
                }
            }
            else
            {
                // Bare `{ }` pattern: `t`'s type IS the receiver's own (non-null)
                // type — no downcast, so no `as` conversion is emitted (which also
                // sidesteps `as`'s reference-only restriction for a nullable
                // value-type receiver like `DateTimeOffset?`).
                ITypeSymbol receiverType = this.context.GetTypeInfo(isPattern.Expression).Type;
                if (receiverType == null)
                {
                    return false;
                }

                ITypeSymbol nonNullTarget = UnwrapNullable(receiverType);
                targetType = this.typeMapper.Map(nonNullTarget, this.context, isPattern.Expression.GetLocation());
                hoistInitializer = receiver;
            }

            // `let t T? = receiver [as T]` — the local is declared nullable so the
            // `== nil` guard and the subsequent smart cast both type-check, while the
            // `as` cast (when present) keeps its non-nullable reference target (a
            // nullable `as T?` target is rejected at emit time).
            ISymbol designationSymbol = this.context.GetDeclaredSymbol(single);
            BindingKind binding = designationSymbol != null
                && this.IsSymbolReassigned(
                    designationSymbol,
                    this.state.CurrentBodyScope ?? ifStatement)
                    ? BindingKind.Var
                    : BindingKind.Let;
            var hoist = new LocalDeclarationStatement(
                binding,
                localName,
                MakeNullable(targetType),
                hoistInitializer);

            // `if t == nil { <then> }` reproduces the negated guard: when the cast
            // fails the local is nil, so the original then-block runs.
            GExpression guard = new BinaryExpression(
                new IdentifierExpression(localName), "==", LiteralExpression.Null());
            if (residualPattern != null)
            {
                if (!this.TryTranslateIfLetResidualPattern(
                        residualPattern,
                        localName,
                        out GExpression residualGuard))
                {
                    return false;
                }

                guard = new BinaryExpression(guard, "||", Negate(residualGuard));
            }

            for (int i = patternIndex + 1; i < terms.Count; i++)
            {
                guard = new BinaryExpression(
                    guard,
                    "||",
                    this.TranslateExpression(terms[i]));
            }

            BlockStatement then = this.TranslateStatementAsBlock(ifStatement.Statement);

            GStatement elseBranch = null;
            if (ifStatement.Else != null)
            {
                elseBranch = this.TranslateElseStatement(ifStatement.Else.Statement);
            }

            var statements = new List<GStatement>();
            if (patternIndex > 0)
            {
                GExpression prefixGuard = null;
                for (int i = 0; i < patternIndex; i++)
                {
                    GExpression translated = this.TranslateExpression(terms[i]);
                    prefixGuard = prefixGuard == null
                        ? translated
                        : new BinaryExpression(prefixGuard, "||", translated);
                }

                if (elseBranch != null)
                {
                    result = new GStatement[]
                    {
                        new IfStatement(
                            prefixGuard,
                            then,
                            new BlockStatement(
                                new GStatement[]
                                {
                                    hoist,
                                    new IfStatement(guard, then, elseBranch),
                                })),
                    };
                    return true;
                }

                statements.Add(new IfStatement(prefixGuard, then));
            }

            statements.Add(hoist);
            statements.Add(new IfStatement(guard, then, elseBranch));
            result = statements;
            return true;
        }

        private bool TryBuildNestedNegatedGuardHoist(
            IfStatementSyntax ifStatement,
            IReadOnlyList<ExpressionSyntax> terms,
            out IReadOnlyList<GStatement> result)
        {
            result = null;
            if (ifStatement.Else != null || !StatementAlwaysExits(ifStatement.Statement))
            {
                return false;
            }

            IsPatternExpressionSyntax isPattern = null;
            PatternSyntax positivePattern = null;
            SingleVariableDesignationSyntax designation = null;
            int patternIndex = -1;
            for (var i = 0; i < terms.Count; i++)
            {
                if (!TryGetNegatedPattern(
                        terms[i],
                        out IsPatternExpressionSyntax candidatePattern,
                        out PatternSyntax candidatePositive))
                {
                    continue;
                }

                var designations = candidatePositive.DescendantNodesAndSelf()
                    .OfType<SingleVariableDesignationSyntax>()
                    .ToList();
                if (designations.Count != 1
                    || candidatePositive is DeclarationPatternSyntax
                    || candidatePositive is RecursivePatternSyntax
                    {
                        Designation: SingleVariableDesignationSyntax,
                    })
                {
                    continue;
                }

                if (patternIndex >= 0)
                {
                    return false;
                }

                patternIndex = i;
                isPattern = candidatePattern;
                positivePattern = candidatePositive;
                designation = designations[0];
            }

            if (patternIndex < 0
                || this.context.GetDeclaredSymbol(designation) is not ILocalSymbol binder
                || terms.Where((_, index) => index != patternIndex)
                    .Any(term => term.DescendantNodesAndSelf()
                        .OfType<IsPatternExpressionSyntax>()
                        .Any(pattern => PatternIntroducesBinding(pattern.Pattern))))
            {
                return false;
            }

            BlockStatement then = this.TranslateStatementAsBlock(ifStatement.Statement);
            var statements = new List<GStatement>();
            for (var i = 0; i < patternIndex; i++)
            {
                statements.Add(new IfStatement(this.TranslateExpression(terms[i]), then));
            }

            GExpression receiver = this.TranslateExpression(isPattern.Expression);
            if (this.IsNativelyExpressiblePattern(positivePattern, topLevel: true)
                && binder.Type is { TypeKind: not TypeKind.Error, IsRefLikeType: false }
                && !CSharpTypeMapper.IsSystemIndexOrRange(binder.Type))
            {
                string mutableName = this.EmittedName(designation, designation.Identifier);
                string matchName = FreshPatternMatchName(
                    mutableName,
                    this.state.CurrentBodyScope ?? ifStatement);
                this.state.NativePatternVariableAliases[binder] = matchName;
                GPattern nativePattern;
                try
                {
                    nativePattern = this.BuildNativePattern(
                        positivePattern,
                        new List<ILocalSymbol>());
                }
                finally
                {
                    this.state.NativePatternVariableAliases.Remove(binder);
                }

                statements.Add(new IfStatement(
                    Negate(new PatternTestExpression(receiver, nativePattern)),
                    then));

                GTypeReference mutableType = this.typeMapper.Map(
                    binder.Type,
                    this.context,
                    designation.GetLocation());
                statements.Add(new LocalDeclarationStatement(
                    BindingKind.Var,
                    mutableName,
                    mutableType,
                    new IdentifierExpression(matchName)));
                this.state.PatternBindings[binder] =
                    new IdentifierExpression(mutableName);

                for (var i = patternIndex + 1; i < terms.Count; i++)
                {
                    statements.Add(new IfStatement(
                        this.TranslateExpression(terms[i]),
                        then));
                }

                result = statements;
                return true;
            }

            if (!IsTrivialOperand(receiver))
            {
                string spillName = $"__spill{this.state.SpillCounter++}";
                statements.Add(new LocalDeclarationStatement(
                    BindingKind.Let,
                    spillName,
                    initializer: receiver));
                receiver = new IdentifierExpression(spillName);
            }

            bool hadPrevious = this.state.PatternBindings.TryGetValue(
                binder,
                out GExpression previous);
            GExpression positiveTest;
            GExpression replacement;
            try
            {
                positiveTest = this.TranslatePatternTest(
                    receiver,
                    positivePattern,
                    this.context.GetTypeInfo(isPattern.Expression).Type,
                    isPattern.Expression);
                this.state.PatternBindings.TryGetValue(binder, out replacement);
            }
            finally
            {
                if (hadPrevious)
                {
                    this.state.PatternBindings[binder] = previous;
                }
                else
                {
                    this.state.PatternBindings.Remove(binder);
                }
            }

            if (replacement == null)
            {
                return false;
            }

            string localName = this.EmittedName(designation, designation.Identifier);
            GTypeReference localType = MakeNullable(
                this.typeMapper.Map(
                    binder.Type,
                    this.context,
                    designation.GetLocation()));
            statements.Add(new LocalDeclarationStatement(
                BindingKind.Var,
                localName,
                localType));
            statements.Add(new IfStatement(Negate(positiveTest), then));
            statements.Add(new AssignmentStatement(
                new IdentifierExpression(localName),
                replacement));

            var narrowed = new NonNullAssertionExpression(
                new IdentifierExpression(localName));
            this.state.PatternBindings[binder] = narrowed;
            for (var i = patternIndex + 1; i < terms.Count; i++)
            {
                statements.Add(new IfStatement(this.TranslateExpression(terms[i]), then));
            }

            result = statements;
            return true;
        }

        private bool TryBuildMultipleNegatedGuardHoists(
            IfStatementSyntax ifStatement,
            IReadOnlyList<ExpressionSyntax> terms,
            out IReadOnlyList<GStatement> result)
        {
            result = null;
            if (ifStatement.Else != null || !StatementAlwaysExits(ifStatement.Statement))
            {
                return false;
            }

            BlockStatement then = this.TranslateStatementAsBlock(ifStatement.Statement);
            var statements = new List<GStatement>();
            foreach (ExpressionSyntax term in terms)
            {
                if (!TryExtractNegatedGuardPattern(
                        term,
                        out IsPatternExpressionSyntax isPattern,
                        out TypeSyntax typeSyntax,
                        out VariableDesignationSyntax designation,
                        out RecursivePatternSyntax residualPattern))
                {
                    statements.Add(new IfStatement(this.TranslateExpression(term), then));
                    continue;
                }

                if (designation is not SingleVariableDesignationSyntax single)
                {
                    return false;
                }

                string localName = this.EmittedName(single, single.Identifier);
                GExpression receiver = this.TranslateExpression(isPattern.Expression);
                GExpression initializer;
                GTypeReference targetType;
                if (typeSyntax != null)
                {
                    ITypeSymbol targetSymbol = this.context.GetTypeInfo(typeSyntax).Type;
                    if (targetSymbol == null)
                    {
                        return false;
                    }

                    targetType = this.MapTypeSyntax(typeSyntax);
                    if (targetSymbol.IsValueType)
                    {
                        if (this.context.GetTypeInfo(isPattern.Expression).Type is not INamedTypeSymbol receiverType
                            || receiverType.OriginalDefinition.SpecialType != SpecialType.System_Nullable_T
                            || receiverType.TypeArguments.Length != 1
                            || !SymbolEqualityComparer.Default.Equals(receiverType.TypeArguments[0], targetSymbol))
                        {
                            return false;
                        }

                        initializer = receiver;
                    }
                    else
                    {
                        initializer = new BinaryExpression(receiver, "as", new TypeExpression(targetType));
                    }
                }
                else
                {
                    ITypeSymbol receiverType = this.context.GetTypeInfo(isPattern.Expression).Type;
                    if (receiverType == null)
                    {
                        return false;
                    }

                    targetType = this.typeMapper.Map(
                        UnwrapNullable(receiverType),
                        this.context,
                        isPattern.Expression.GetLocation());
                    initializer = receiver;
                }

                ISymbol designationSymbol = this.context.GetDeclaredSymbol(single);
                BindingKind binding = designationSymbol != null
                    && this.IsSymbolReassigned(
                        designationSymbol,
                        this.state.CurrentBodyScope ?? ifStatement)
                        ? BindingKind.Var
                        : BindingKind.Let;
                statements.Add(new LocalDeclarationStatement(
                    binding,
                    localName,
                    MakeNullable(targetType),
                    initializer));

                GExpression guard = new BinaryExpression(
                    new IdentifierExpression(localName),
                    "==",
                    LiteralExpression.Null());
                if (residualPattern != null)
                {
                    if (!this.TryTranslateIfLetResidualPattern(
                            residualPattern,
                            localName,
                            out GExpression residualGuard))
                    {
                        return false;
                    }

                    guard = new BinaryExpression(guard, "||", Negate(residualGuard));
                }

                statements.Add(new IfStatement(guard, then));
            }

            result = statements;
            return true;
        }

        private static void CollectLogicalOrTerms(
            ExpressionSyntax expression,
            List<ExpressionSyntax> terms)
        {
            if (expression is BinaryExpressionSyntax binary
                && binary.IsKind(SyntaxKind.LogicalOrExpression))
            {
                CollectLogicalOrTerms(binary.Left, terms);
                CollectLogicalOrTerms(binary.Right, terms);
                return;
            }

            terms.Add(expression);
        }

        private static bool TryExtractNegatedGuardPattern(
            ExpressionSyntax condition,
            out IsPatternExpressionSyntax isPattern,
            out TypeSyntax typeSyntax,
            out VariableDesignationSyntax designation,
            out RecursivePatternSyntax residualPattern)
        {
            if (!TryGetNegatedPattern(condition, out isPattern, out PatternSyntax negatedPattern))
            {
                typeSyntax = null;
                designation = null;
                residualPattern = null;
                return false;
            }

            typeSyntax = null;
            designation = null;
            residualPattern = null;
            if (isPattern == null)
            {
                return false;
            }

            switch (negatedPattern)
            {
                case DeclarationPatternSyntax declaration:
                    typeSyntax = declaration.Type;
                    designation = declaration.Designation;
                    return true;

                case RecursivePatternSyntax { Type: { } recursiveType } recursive:
                    typeSyntax = recursiveType;
                    designation = recursive.Designation;
                    if (recursive.PositionalPatternClause != null
                        || recursive.PropertyPatternClause is { Subpatterns.Count: > 0 })
                    {
                        residualPattern = recursive;
                    }

                    return true;

                case RecursivePatternSyntax { Type: null } bareRecursive:
                    designation = bareRecursive.Designation;
                    if (bareRecursive.PositionalPatternClause != null
                        || bareRecursive.PropertyPatternClause is { Subpatterns.Count: > 0 })
                    {
                        residualPattern = bareRecursive;
                    }

                    return true;

                default:
                    return false;
            }
        }

        private static bool TryGetNegatedPattern(
            ExpressionSyntax condition,
            out IsPatternExpressionSyntax isPattern,
            out PatternSyntax positivePattern)
        {
            condition = Unparenthesize(condition);
            if (condition is IsPatternExpressionSyntax directPattern
                && directPattern.Pattern is UnaryPatternSyntax notPattern
                && notPattern.IsKind(SyntaxKind.NotPattern))
            {
                isPattern = directPattern;
                positivePattern = notPattern.Pattern;
                return true;
            }

            if (condition is PrefixUnaryExpressionSyntax logicalNot
                && logicalNot.IsKind(SyntaxKind.LogicalNotExpression)
                && Unparenthesize(logicalNot.Operand) is IsPatternExpressionSyntax parenthesizedPattern)
            {
                isPattern = parenthesizedPattern;
                positivePattern = parenthesizedPattern.Pattern;
                return true;
            }

            isPattern = null;
            positivePattern = null;
            return false;
        }

        private static bool StatementAlwaysExits(StatementSyntax statement) =>
            statement switch
            {
                ReturnStatementSyntax or ThrowStatementSyntax or BreakStatementSyntax
                    or ContinueStatementSyntax or GotoStatementSyntax => true,
                BlockSyntax { Statements.Count: > 0 } block =>
                    StatementAlwaysExits(block.Statements[block.Statements.Count - 1]),
                _ => false,
            };

        private static string FreshPatternMatchName(
            string localName,
            SyntaxNode scope)
        {
            var used = new HashSet<string>(
                scope.DescendantTokens()
                    .Where(token => token.IsKind(SyntaxKind.IdentifierToken))
                    .Select(token => token.ValueText),
                System.StringComparer.Ordinal);
            string stem = localName + "Match";
            string candidate = stem;
            for (int suffix = 2; used.Contains(candidate); suffix++)
            {
                candidate = stem + suffix;
            }

            return candidate;
        }

        // Returns a nullable (`T?`) copy of a type reference, preserving the
        // concrete reference kind (named/array/pointer/tuple). Used when hoisting a
        // negated type-pattern guard local so the `== nil` test type-checks.
        private static GTypeReference MakeNullable(GTypeReference reference)
        {
            return reference switch
            {
                NamedTypeReference named =>
                    new NamedTypeReference(named.Name, named.TypeArguments, named.ContainingType) { IsNullable = true },
                ArrayTypeReference array =>
                    new ArrayTypeReference(array.ElementType, array.Rank) { IsNullable = true },
                PointerTypeReference pointer =>
                    new PointerTypeReference(pointer.ElementType) { IsNullable = true },
                TupleTypeReference tuple =>
                    new TupleTypeReference(tuple.ElementTypes) { IsNullable = true },
                ArrowTypeReference arrow =>
                    new ArrowTypeReference(arrow.ParameterTypes, arrow.ReturnTypes, arrow.IsAsync)
                    {
                        IsNullable = true,
                    },
                _ => reference,
            };
        }

        private GStatement TranslateIf(IfStatementSyntax ifStatement)
        {
            IReadOnlyList<GStatement> translated =
                this.TranslateIfWithConditionPrologue(ifStatement);
            return translated.Count == 1
                ? translated[0]
                : new BlockStatement(translated);
        }

        private IReadOnlyList<GStatement> TranslateIfWithConditionPrologue(
            IfStatementSyntax ifStatement)
        {
            // Translate the condition first so any `x is T t` declaration pattern
            // registers its Kotlin-style smart-cast binding before the guarded
            // block is translated; the binding is scoped to the then-block only.
            // Native assignment expressions stay in the condition; only an
            // embedded deconstruction assignment can populate the prologue.
            var bindingsBefore = new HashSet<ISymbol>(this.state.PatternBindings.Keys, SymbolEqualityComparer.Default);
            var conditionPrologue = new List<GStatement>();
            GExpression condition = GuardBlockCondition(
                this.TranslateConditionWithHoist(ifStatement.Condition, conditionPrologue));

            BlockStatement then = this.TranslateStatementAsBlock(ifStatement.Statement);

            foreach (ISymbol added in this.state.PatternBindings.Keys.ToList())
            {
                if (!bindingsBefore.Contains(added))
                {
                    this.state.PatternBindings.Remove(added);
                }
            }

            GStatement elseBranch = null;
            if (ifStatement.Else != null)
            {
                elseBranch = this.TranslateElseStatement(ifStatement.Else.Statement);
            }

            conditionPrologue.Add(new IfStatement(condition, then, elseBranch));
            return conditionPrologue;
        }

        private GStatement TranslateForStatement(ForStatementSyntax forStatement)
        {
            int declaratorCount = forStatement.Declaration?.Variables.Count ?? 0;

            // G#'s `for` carries a SINGLE init clause and a SINGLE incrementor, so
            // a C-style `for` with multiple declarators/initializers or multiple
            // incrementors cannot be represented directly. Lower those to a block
            // + `while` so every init runs once up front and every incrementor runs
            // at the end of each iteration (issue #914). A condition needing clause
            // hoisting (a value-position assignment, e.g. `for (…; (c = Next()) !=
            // -1; …)`, or an is-pattern requiring a scrutinee local) has the same
            // problem — G#'s single-expression `for` condition has nowhere to place
            // the hoisted statement — so it takes the same lowering (issue #1723).
            if (declaratorCount > 1 ||
                forStatement.Initializers.Count > 1 ||
                forStatement.Incrementors.Count > 1 ||
                this.ForConditionRequiresHoist(forStatement.Condition))
            {
                return this.LowerForToWhile(forStatement);
            }

            GStatement initializer = null;
            if (forStatement.Declaration != null)
            {
                initializer = this.TranslateLocalDeclaration(forStatement.Declaration, isConst: false)
                    .FirstOrDefault();
            }
            else if (forStatement.Initializers.Count > 0)
            {
                initializer = this.TranslateExpressionStatement(forStatement.Initializers[0]);
            }

            GExpression condition = forStatement.Condition == null
                ? null
                : this.TranslateExpression(forStatement.Condition);

            GStatement incrementor = forStatement.Incrementors.Count > 0
                ? this.TranslateExpressionStatement(forStatement.Incrementors[0])
                : null;

            return new ForStatement(
                initializer,
                condition,
                incrementor,
                this.TranslateStatementAsBlock(forStatement.Statement));
        }

        private bool ForConditionRequiresHoist(ExpressionSyntax condition)
        {
            if (condition == null)
            {
                return false;
            }

            var clauses = new List<ExpressionSyntax>();
            FlattenAndClauses(condition, clauses);
            return clauses.Any(this.ClauseRequiresConditionHoist);
        }

        /// <summary>
        /// Lowers a C-style <c>for</c> that has more than one initializer/declarator
        /// or more than one incrementor — neither of which fits G#'s single-init,
        /// single-incrementor <c>for</c> — into an equivalent block + <c>while</c>:
        /// all inits run once before the loop, the body runs each iteration, then
        /// every incrementor runs at the end of the body (issue #914). A condition
        /// needing clause hoisting places its prologue (hoisted assignment /
        /// scrutinee local plus `if !test { break }` guards) at the TOP of the body,
        /// re-run every iteration exactly where C# would re-test the condition
        /// (issue #1723).
        /// <para>
        /// In C# the incrementors also run when the body executes a loop-targeting
        /// <c>continue</c>, but a G# <c>continue</c> is a goto straight past the
        /// WHOLE lowered <c>while</c> body — so the trailing incrementors below
        /// would be silently skipped. When the body has such a <c>continue</c>, it
        /// is rewritten (<see cref="DuplicateIncrementorsBeforeOwnLoopContinue"/>) to duplicate the
        /// incrementors immediately ahead of every own-loop <c>continue</c>, so they
        /// still run before the condition re-test either way (issue #1732). The one
        /// shape that rewrite cannot do faithfully — the <c>continue</c> sits inside
        /// a <c>try</c>/<c>finally</c>, where C# runs <c>finally</c> before the
        /// incrementors — is reported via <c>ReportUnsupported</c> instead of
        /// silently reordering that side effect.
        /// </para>
        /// </summary>
        private GStatement LowerForToWhile(ForStatementSyntax forStatement)
        {
            var outer = new List<GStatement>();

            if (forStatement.Declaration != null)
            {
                outer.AddRange(this.TranslateLocalDeclaration(forStatement.Declaration, isConst: false));
            }

            foreach (ExpressionSyntax init in forStatement.Initializers)
            {
                outer.AddRange(this.TranslateExpressionStatements(init));
            }

            GExpression condition;
            List<GStatement> conditionPrologue;
            if (forStatement.Condition == null)
            {
                condition = LiteralExpression.Bool(true);
                conditionPrologue = new List<GStatement>();
            }
            else if (this.TryBuildHoistedLoopCondition(forStatement.Condition, out GExpression hoistedCondition, out List<GStatement> hoisted, out _))
            {
                condition = hoistedCondition;
                conditionPrologue = hoisted;
            }
            else
            {
                condition = this.TranslateExpression(forStatement.Condition);
                conditionPrologue = new List<GStatement>();
            }

            List<ExpressionSyntax> incrementorExpressions = forStatement.Incrementors.ToList();
            var incrementorStatements = new List<GStatement>();
            foreach (ExpressionSyntax inc in incrementorExpressions)
            {
                incrementorStatements.AddRange(this.TranslateExpressionStatements(inc));
            }

            BlockStatement translatedBody = this.TranslateStatementAsBlock(forStatement.Statement);
            if (incrementorStatements.Count > 0 && BodyContainsOwnLoopContinue(forStatement.Statement))
            {
                if (OwnLoopContinueCrossesFinally(forStatement.Statement))
                {
                    this.context.ReportUnsupported(
                        forStatement,
                        "a 'continue' inside a 'try'/'finally' within this 'for' loop has no side-effect-preserving G# lowering yet (issue #1732).");
                }
                else
                {
                    translatedBody = this.DuplicateIncrementorsBeforeOwnLoopContinue(forStatement, translatedBody, incrementorStatements);
                }
            }

            var bodyStatements = new List<GStatement>(conditionPrologue);
            bodyStatements.AddRange(translatedBody.Statements);
            bodyStatements.AddRange(incrementorStatements);

            outer.Add(new WhileStatement(GuardBlockCondition(condition), new BlockStatement(bodyStatements)));

            return new BlockStatement(outer);
        }

        /// <summary>
        /// Duplicates a <c>for</c> loop's already-translated incrementor
        /// statements immediately ahead of every <c>continue</c> that targets
        /// THIS loop. G#'s while-lowering (<see cref="LowerForToWhile"/>) appends
        /// the incrementors as trailing statements in the lowered <c>while</c>
        /// body, but a G# <c>continue</c> is a goto straight past the WHOLE body
        /// (ADR-0070's continueLabel) — so without this rewrite the trailing
        /// incrementors are silently skipped on <c>continue</c>, unlike C#'s
        /// <c>for</c>, which always runs them before re-testing the condition
        /// (issue #1732).
        /// <para>
        /// Operates on the TRANSLATED G# statement tree, not the C# syntax tree:
        /// rebuilding a Roslyn syntax subtree to splice in the incrementors would
        /// re-parent untouched sibling nodes onto a detached tree, breaking any
        /// later <c>SemanticModel.GetSymbolInfo</c> call on them
        /// (<see cref="ArgumentException"/> "Syntax node is not within syntax
        /// tree"). The G# AST has no such constraint, so the rewrite happens
        /// here, after translation.
        /// </para>
        /// <para>
        /// Descent stops at a nested loop (<see cref="WhileStatement"/>,
        /// <see cref="ForStatement"/>, <see cref="DoWhileStatement"/>,
        /// <see cref="ForInStatement"/>) or a nested
        /// <see cref="LocalFunctionStatement"/> — each is its own
        /// <c>continue</c> seam, mirroring <see cref="BodyContainsOwnLoopContinue"/>.
        /// A <c>finally</c> block is left untouched: C# forbids a jump statement
        /// leaving a <c>finally</c>, so it can never itself contain an own-loop
        /// <c>continue</c>.
        /// </para>
        /// </summary>
        private BlockStatement DuplicateIncrementorsBeforeOwnLoopContinue(
            ForStatementSyntax forStatement,
            BlockStatement body,
            IReadOnlyList<GStatement> incrementorStatements)
        {
            return (BlockStatement)this.RewriteOwnLoopContinue(forStatement, body, incrementorStatements);
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
        private static bool ContainsOwnLoopContinue(GStatement statement)
        {
            switch (statement)
            {
                case ContinueStatement:
                    return true;

                case BlockStatement block:
                    foreach (GStatement inner in block.Statements)
                    {
                        if (ContainsOwnLoopContinue(inner))
                        {
                            return true;
                        }
                    }

                    return false;

                case IfStatement ifStatement:
                    return ContainsOwnLoopContinue(ifStatement.Then)
                        || (ifStatement.ElseBranch != null && ContainsOwnLoopContinue(ifStatement.ElseBranch));

                case TryStatement tryStatement:
                    if (ContainsOwnLoopContinue(tryStatement.TryBlock))
                    {
                        return true;
                    }

                    foreach (CatchClause catchClause in tryStatement.CatchClauses)
                    {
                        if (ContainsOwnLoopContinue(catchClause.Body))
                        {
                            return true;
                        }
                    }

                    // FinallyBlock deliberately excluded: C# forbids a jump
                    // statement leaving a `finally`, so it can never itself
                    // hold an own-loop `continue`.
                    return false;

                case SwitchStatement switchStatement:
                    foreach (SwitchStatementCase switchCase in switchStatement.Cases)
                    {
                        if (ContainsOwnLoopContinue(switchCase.Body))
                        {
                            return true;
                        }
                    }

                    return false;

                case FixedStatement fixedStatement:
                    return ContainsOwnLoopContinue(fixedStatement.Body);

                // Boundaries: a nested loop's own continue seam, or a nested
                // local function (its own statement seam) — never counts.
                case WhileStatement:
                case WhileLetStatement:
                case ForStatement:
                case DoWhileStatement:
                case ForInStatement:
                case LocalFunctionStatement:
                    return false;

                default:
                    return false;
            }
        }

        private GStatement RewriteOwnLoopContinue(
            ForStatementSyntax forStatement,
            GStatement statement,
            IReadOnlyList<GStatement> incrementorStatements)
        {
            switch (statement)
            {
                case ContinueStatement:
                {
                    var replaced = new List<GStatement>(incrementorStatements) { statement };
                    return new BlockStatement(replaced);
                }

                case BlockStatement block:
                {
                    var rewritten = new List<GStatement>(block.Statements.Count);
                    foreach (GStatement inner in block.Statements)
                    {
                        rewritten.Add(this.RewriteOwnLoopContinue(forStatement, inner, incrementorStatements));
                    }

                    return new BlockStatement(rewritten, block.IsUnsafe);
                }

                case IfStatement ifStatement:
                {
                    GStatement elseBranch = ifStatement.ElseBranch == null
                        ? null
                        : this.RewriteOwnLoopContinue(forStatement, ifStatement.ElseBranch, incrementorStatements);
                    return new IfStatement(
                        ifStatement.Condition,
                        (BlockStatement)this.RewriteOwnLoopContinue(forStatement, ifStatement.Then, incrementorStatements),
                        elseBranch);
                }

                case TryStatement tryStatement:
                {
                    var catchClauses = new List<CatchClause>(tryStatement.CatchClauses.Count);
                    foreach (CatchClause catchClause in tryStatement.CatchClauses)
                    {
                        catchClauses.Add(new CatchClause(
                            catchClause.VariableName,
                            catchClause.ExceptionType,
                            (BlockStatement)this.RewriteOwnLoopContinue(forStatement, catchClause.Body, incrementorStatements)));
                    }

                    return new TryStatement(
                        (BlockStatement)this.RewriteOwnLoopContinue(forStatement, tryStatement.TryBlock, incrementorStatements),
                        catchClauses,
                        tryStatement.FinallyBlock);
                }

                case SwitchStatement switchStatement:
                {
                    var cases = new List<SwitchStatementCase>(switchStatement.Cases.Count);
                    foreach (SwitchStatementCase switchCase in switchStatement.Cases)
                    {
                        cases.Add(new SwitchStatementCase(
                            switchCase.Pattern,
                            (BlockStatement)this.RewriteOwnLoopContinue(forStatement, switchCase.Body, incrementorStatements),
                            switchCase.Guard));
                    }

                    return new SwitchStatement(switchStatement.Subject, cases);
                }

                case FixedStatement fixedStatement:
                {
                    return new FixedStatement(
                        fixedStatement.Name,
                        fixedStatement.PointerType,
                        fixedStatement.Source,
                        (BlockStatement)this.RewriteOwnLoopContinue(forStatement, fixedStatement.Body, incrementorStatements));
                }

                // Boundaries: a nested loop's own continue seam, or a nested
                // local function (its own statement seam) — never descend.
                case WhileStatement:
                case WhileLetStatement:
                case ForStatement:
                case DoWhileStatement:
                case ForInStatement:
                case LocalFunctionStatement:
                    return statement;

                default:
                    // Any other body-carrying G# statement kind that reaches
                    // here was missed by the cases above. Silently returning
                    // it unchanged would let an own-loop `continue` buried
                    // inside it skip the duplicated incrementors — the same
                    // silent miscompile this rewrite exists to fix (issue
                    // #1732). Report it instead of guessing a lowering.
                    if (ContainsOwnLoopContinue(statement))
                    {
                        this.context.ReportUnsupported(
                            forStatement,
                            $"a 'continue' inside a '{statement.GetType().Name}' within this 'for' loop has no incrementor-duplication lowering yet (issue #1732).");
                    }

                    return statement;
            }
        }

        private bool IsLocalReassigned(ILocalSymbol local)
        {
            // A local is mutable in G# (`var`) when it is assigned, incremented,
            // decremented, OR passed by `ref`/`out` (which cs2gs renders as an
            // address-of `&arg`): taking the address of an immutable `let` is
            // rejected by gsc with GS9005 ("Cannot take address of constant").
            // Delegate to the general symbol walk, which already covers the
            // `ref`/`out` argument case, so both paths stay consistent.
            return this.IsSymbolReassigned(local, this.state.CurrentBodyScope);
        }

        private bool BindsTo(ExpressionSyntax expression, ISymbol target)
        {
            ISymbol symbol = this.context.GetSymbolInfo(expression).Symbol;
            return symbol != null && SymbolEqualityComparer.Default.Equals(symbol, target);
        }

        // True when a deconstruction-assignment LHS tuple writes `symbol` as one
        // of its (possibly nested, e.g. `((a, b), c) = ...`) elements. Elements
        // that are themselves a `DeclarationExpressionSyntax` (`var y`, `int y`)
        // introduce a brand-new local rather than writing an existing one, so
        // they never match here — only plain-identifier elements (existing
        // locals) and nested tuples are walked. A discard (`_`) element has no
        // symbol and never matches either.
        private bool TupleAssignmentTargetsInclude(TupleExpressionSyntax tuple, ISymbol symbol)
        {
            foreach (ArgumentSyntax argument in tuple.Arguments)
            {
                switch (argument.Expression)
                {
                    case TupleExpressionSyntax nested when this.TupleAssignmentTargetsInclude(nested, symbol):
                        return true;

                    case DeclarationExpressionSyntax:
                        break;

                    default:
                        if (this.BindsTo(argument.Expression, symbol))
                        {
                            return true;
                        }

                        break;
                }
            }

            return false;
        }

        // Shared by declaration mutability and smart-cast invalidation so tuple,
        // ref/out, address-of, and ref-alias writes cannot drift apart.
        private bool SyntaxNodeWritesSymbol(SyntaxNode node, ISymbol symbol) =>
            node switch
            {
                AssignmentExpressionSyntax assignment
                    when this.BindsTo(assignment.Left, symbol) => true,
                AssignmentExpressionSyntax { Left: TupleExpressionSyntax leftTuple }
                    when this.TupleAssignmentTargetsInclude(leftTuple, symbol) => true,
                PostfixUnaryExpressionSyntax postfix
                    when (postfix.IsKind(SyntaxKind.PostIncrementExpression)
                            || postfix.IsKind(SyntaxKind.PostDecrementExpression))
                        && this.BindsTo(postfix.Operand, symbol) => true,
                PrefixUnaryExpressionSyntax prefix
                    when (prefix.IsKind(SyntaxKind.PreIncrementExpression)
                            || prefix.IsKind(SyntaxKind.PreDecrementExpression)
                            || prefix.IsKind(SyntaxKind.AddressOfExpression))
                        && this.BindsTo(prefix.Operand, symbol) => true,
                ArgumentSyntax argument
                    when !argument.RefOrOutKeyword.IsKind(SyntaxKind.None)
                        && this.BindsTo(argument.Expression, symbol) => true,
                RefExpressionSyntax refOf
                    when refOf.Expression is IdentifierNameSyntax
                        && this.BindsTo(refOf.Expression, symbol) => true,
                _ => false,
            };

        // Returns true when <paramref name="symbol"/> is assigned, incremented,
        // decremented, or passed by ref/out anywhere in <paramref name="scope"/>.
        // Generalises <see cref="IsLocalReassigned"/> to any symbol (used for
        // value parameters, which are read-only in G#).
        private bool IsSymbolReassigned(ISymbol symbol, SyntaxNode scope)
        {
            if (scope == null)
            {
                return false;
            }

            var key = (symbol, scope);
            if (this.state.SymbolReassignedCache.TryGetValue(key, out bool cached))
            {
                return cached;
            }

            bool result = this.ComputeIsSymbolReassigned(symbol, scope);
            this.state.SymbolReassignedCache[key] = result;
            return result;
        }

        private bool ComputeIsSymbolReassigned(ISymbol symbol, SyntaxNode scope)
        {
            foreach (SyntaxNode node in scope.DescendantNodes())
            {
                if (this.SyntaxNodeWritesSymbol(node, symbol))
                {
                    return true;
                }
            }

            return false;
        }
    }
}
