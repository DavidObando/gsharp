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
        /// re-declaring <c>out var n</c> (→ GS0102). Pattern/out-var bindings in a
        /// <c>while</c> condition are also invisible in the body (GS0125), and G#
        /// narrows locals in <c>if</c> bodies but not <c>while</c> bodies.
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

        // A loop-condition clause needs hoisting when it is an `is`-pattern whose
        // lowering would duplicate a side-effecting scrutinee (an `and`/`or`
        // combinator re-emits the receiver), declare an `out var` more than once
        // (GS0102), or bind a pattern variable the G# loop body cannot see
        // (GS0125); or when it contains a value-position assignment (`(line =
        // r.ReadLine()) != null`) — G# assignment is a statement, so the write
        // must be hoisted into the loop body, run once per iteration (issue
        // #1723).
        private bool ClauseRequiresConditionHoist(ExpressionSyntax clause)
        {
            return (clause is IsPatternExpressionSyntax isPattern &&
                (PatternIntroducesBinding(isPattern.Pattern) ||
                 PatternDuplicatesScrutinee(isPattern.Pattern) ||
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
                .Any();

        private static bool PatternIntroducesBinding(PatternSyntax pattern) =>
            pattern.DescendantNodesAndSelf().OfType<SingleVariableDesignationSyntax>().Any();

        private static bool PatternDuplicatesScrutinee(PatternSyntax pattern) =>
            pattern.DescendantNodesAndSelf().OfType<BinaryPatternSyntax>().Any();

        private static bool ExpressionDeclaresOutVar(ExpressionSyntax expression) =>
            expression.DescendantNodesAndSelf().OfType<DeclarationExpressionSyntax>().Any();

        // Emits the hoisted statements for a single loop-condition clause: a pure
        // clause becomes a negated `break` guard; a clause carrying a
        // value-position assignment (`(line = r.ReadLine()) != null`) hoists the
        // assignment(s) as preceding statement(s) — re-run every iteration, exactly
        // where C# would re-evaluate them — then becomes a negated `break` guard
        // over the now-hoisted read (issue #1723); an `is`-pattern clause evaluates
        // its scrutinee once into a local and turns the pattern's must-hold tests
        // into `break` guards (issue #914).
        private void HoistLoopConditionClause(ExpressionSyntax clause, List<GStatement> into)
        {
            // Any spill hoisted while translating `clause` (issue #1731 — e.g. a
            // non-trivial pattern scrutinee or range-slice start nested inside the
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
                List<AssignmentExpressionSyntax> embedded = this.CollectEmbeddedAssignments(clause, includeSelf: true);
                if (embedded.Count == 0)
                {
                    into.Add(BreakIf(Negate(this.TranslateExpression(clause))));
                    return;
                }

                foreach (AssignmentExpressionSyntax node in embedded)
                {
                    into.AddRange(this.FlattenChainedAssignment(node));
                }

                foreach (AssignmentExpressionSyntax node in embedded)
                {
                    this.state.SuppressedAssignments.Add(node);
                }

                try
                {
                    into.Add(BreakIf(Negate(this.TranslateExpression(clause))));
                }
                finally
                {
                    foreach (AssignmentExpressionSyntax node in embedded)
                    {
                        this.state.SuppressedAssignments.Remove(node);
                    }
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
                ? SanitizeIdentifier(mainBinder.Name)
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
            if (this.TryBuildNegatedGuardHoist(ifStatement, out IReadOnlyList<GStatement> hoisted))
            {
                return hoisted;
            }

            if (this.TryBuildPositiveGuardHoist(ifStatement, out IReadOnlyList<GStatement> positiveHoisted))
            {
                return positiveHoisted;
            }

            return new[] { this.TranslateIf(ifStatement) };
        }

        /// <summary>
        /// Lowers a C# positive type-pattern guard <c>if (receiver is T t) { … }</c>
        /// to the smart-cast-friendly G# form below, but only when the pattern
        /// variable <c>t</c> is referenced *outside* the then-block (C# leaks a
        /// positive declaration-pattern variable into the enclosing scope under
        /// definite-assignment rules, so later code reads or reassigns it).
        /// <code>
        /// var t T? = receiver as T   // 'let' when t is never reassigned
        /// if t != nil { … }          // t smart-casts to T inside the guard
        /// … later statements using t …
        /// </code>
        /// When <c>t</c> is used only inside the then-block the existing
        /// smart-cast binding (no hoist) is kept, so currently passing tests do not
        /// regress. Only applies over a reference (non-value) target type, where the
        /// <c>as T</c> + nil-guard form is valid.
        /// </summary>
        private bool TryBuildPositiveGuardHoist(
            IfStatementSyntax ifStatement, out IReadOnlyList<GStatement> result)
        {
            result = null;

            if (ifStatement.Condition is not IsPatternExpressionSyntax isPattern ||
                !TryExtractSingleVarTypePattern(
                    isPattern.Pattern, out TypeSyntax typeSyntax, out SingleVariableDesignationSyntax single))
            {
                return false;
            }

            // The hoisted `as T` + `!= nil` guard is only valid when T is a
            // reference type (or nullable value type); a non-nullable value-type
            // target keeps the existing then-block smart-cast binding.
            ITypeSymbol targetSymbol = this.context.GetTypeInfo(typeSyntax).Type;
            if (targetSymbol == null || targetSymbol.IsValueType)
            {
                return false;
            }

            // Hoist when EITHER the pattern variable escapes the then-block, OR the
            // scrutinee is a non-trivial expression that gsc cannot smart-cast. gsc
            // narrows only a bare local/parameter (ADR-0069); a method-call result,
            // member-access chain or field reference re-emitted at each use of `t`
            // would not smart-cast (→ GS0158) and, for a side-effecting scrutinee
            // such as `M(out var x)`, would be re-evaluated (→ GS0102). When the
            // scrutinee IS a smart-castable local and `t` is used solely inside the
            // guarded block, the existing smart cast (rewriting `t` to the receiver)
            // is correct and avoids an unnecessary local.
            if (this.context.GetDeclaredSymbol(single) is not ILocalSymbol patternSymbol)
            {
                return false;
            }

            GTypeReference targetType = this.MapTypeSyntax(typeSyntax);
            bool escapesThenBlock =
                this.IsSymbolReferencedOutside(patternSymbol, ifStatement.Statement);

            // The broadened "non-smart-castable scrutinee" hoist requires a
            // well-formed nullable local annotation. NamedTypeReference (`T?`) and
            // ArrayTypeReference (`[]?T`, incl. nullable jagged arrays `[]?[]T`,
            // issue #1351) both nullable-annotate and round-trip-parse in gsc; a
            // pointer/tuple target's nullable form does not yet, so for those keep
            // the existing smart cast when the binder does not escape.
            if (!escapesThenBlock &&
                (this.IsSmartCastableScrutinee(isPattern.Expression) ||
                 targetType is not (NamedTypeReference or ArrayTypeReference)))
            {
                return false;
            }

            string localName = SanitizeIdentifier(single.Identifier.Text);
            GExpression receiver = this.TranslateExpression(isPattern.Expression);

            // Record that this pattern variable is now a nullable G# local so an
            // assignment-LHS use inside the guard is null-forgiven (gsc narrows
            // reads but not write receivers).
            this.state.HoistedNullableGuardLocals.Add(patternSymbol);

            // `var t T? = receiver as T` when the leaked variable is reassigned
            // anywhere in the body (C# allows it); otherwise an immutable `let`.
            BindingKind binding = this.IsLocalReassigned(patternSymbol)
                ? BindingKind.Var
                : BindingKind.Let;

            var hoist = new LocalDeclarationStatement(
                binding,
                localName,
                MakeNullable(targetType),
                new BinaryExpression(receiver, "as", new TypeExpression(targetType)));

            // `if t != nil { <then> }` — the positive guard; the then-block runs on a
            // successful cast and `t` smart-casts to non-null T inside it. References
            // to `t` print as the hoisted local (no patternBindings entry registered).
            GExpression guard = new BinaryExpression(
                new IdentifierExpression(localName), "!=", LiteralExpression.Null());
            BlockStatement then = this.TranslateStatementAsBlock(ifStatement.Statement);

            GStatement elseBranch = null;
            if (ifStatement.Else != null)
            {
                elseBranch = ifStatement.Else.Statement is IfStatementSyntax elseIf
                    ? this.TranslateIf(elseIf)
                    : this.TranslateStatementAsBlock(ifStatement.Else.Statement);
            }

            result = new GStatement[] { hoist, new IfStatement(guard, then, elseBranch) };
            return true;
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

        // Returns true when <paramref name="symbol"/> is referenced anywhere in the
        // current body scope outside <paramref name="excludedSubtree"/> (e.g. a
        // pattern variable read or written after/around its `if`). Mirrors the
        // body-walk in <see cref="IsLocalReassigned"/>.
        private bool IsSymbolReferencedOutside(ISymbol symbol, SyntaxNode excludedSubtree)
        {
            SyntaxNode scope = this.state.CurrentBodyScope;
            if (scope == null)
            {
                return false;
            }

            foreach (SyntaxNode node in scope.DescendantNodes())
            {
                if (node is not IdentifierNameSyntax identifier)
                {
                    continue;
                }

                if (excludedSubtree != null && excludedSubtree.Contains(identifier))
                {
                    continue;
                }

                ISymbol referenced = this.context.GetSymbolInfo(identifier).Symbol;
                if (referenced != null && SymbolEqualityComparer.Default.Equals(referenced, symbol))
                {
                    return true;
                }
            }

            return false;
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

            if (ifStatement.Condition is not IsPatternExpressionSyntax isPattern ||
                isPattern.Pattern is not UnaryPatternSyntax notPattern ||
                !notPattern.IsKind(SyntaxKind.NotPattern))
            {
                return false;
            }

            TypeSyntax typeSyntax;
            VariableDesignationSyntax designation;
            switch (notPattern.Pattern)
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

                case RecursivePatternSyntax { Type: null } bareRecursive
                    when bareRecursive.PropertyPatternClause is null or { Subpatterns.Count: 0 }:
                    // `is not { } t` — no explicit type test; the target type is
                    // the receiver's own (non-null) type (issue #2233).
                    typeSyntax = null;
                    designation = bareRecursive.Designation;
                    break;

                default:
                    return false;
            }

            if (designation is not SingleVariableDesignationSyntax single)
            {
                return false;
            }

            string localName = SanitizeIdentifier(single.Identifier.Text);
            GExpression receiver = this.TranslateExpression(isPattern.Expression);
            GExpression hoistInitializer;
            GTypeReference targetType;

            if (typeSyntax != null)
            {
                // The hoisted `as T` + `== nil` guard is only valid when T is a
                // reference type (or nullable value type); a non-nullable value-type
                // target keeps the existing then-block binding behaviour.
                ITypeSymbol targetSymbol = this.context.GetTypeInfo(typeSyntax).Type;
                if (targetSymbol == null || targetSymbol.IsValueType)
                {
                    return false;
                }

                targetType = this.MapTypeSyntax(typeSyntax);
                hoistInitializer = new BinaryExpression(receiver, "as", new TypeExpression(targetType));
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
            var hoist = new LocalDeclarationStatement(
                BindingKind.Let,
                localName,
                MakeNullable(targetType),
                hoistInitializer);

            // `if t == nil { <then> }` reproduces the negated guard: when the cast
            // fails the local is nil, so the original then-block runs.
            GExpression guard = new BinaryExpression(
                new IdentifierExpression(localName), "==", LiteralExpression.Null());
            BlockStatement then = this.TranslateStatementAsBlock(ifStatement.Statement);

            GStatement elseBranch = null;
            if (ifStatement.Else != null)
            {
                elseBranch = ifStatement.Else.Statement is IfStatementSyntax elseIf
                    ? this.TranslateIf(elseIf)
                    : this.TranslateStatementAsBlock(ifStatement.Else.Statement);
            }

            result = new GStatement[] { hoist, new IfStatement(guard, then, elseBranch) };
            return true;
        }

        // Returns a nullable (`T?`) copy of a type reference, preserving the
        // concrete reference kind (named/array/pointer/tuple). Used when hoisting a
        // negated type-pattern guard local so the `== nil` test type-checks.
        private static GTypeReference MakeNullable(GTypeReference reference)
        {
            return reference switch
            {
                NamedTypeReference named =>
                    new NamedTypeReference(named.Name, named.TypeArguments) { IsNullable = true },
                ArrayTypeReference array =>
                    new ArrayTypeReference(array.ElementType) { IsNullable = true },
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
            // Translate the condition first so any `x is T t` declaration pattern
            // registers its Kotlin-style smart-cast binding before the guarded
            // block is translated; the binding is scoped to the then-block only.
            // A value-position assignment in the condition (`if ((x = f()) > 0)`,
            // `if (x = f())`) is hoisted into a preceding assignment statement — it
            // runs once, exactly where C# would evaluate it (issue #1723).
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
                if (ifStatement.Else.Statement is IfStatementSyntax elseIf)
                {
                    elseBranch = this.TranslateIf(elseIf);
                }
                else
                {
                    elseBranch = this.TranslateStatementAsBlock(ifStatement.Else.Statement);
                }
            }

            GStatement result = new IfStatement(condition, then, elseBranch);
            if (conditionPrologue.Count > 0)
            {
                conditionPrologue.Add(result);
                result = new BlockStatement(conditionPrologue);
            }

            return result;
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
                switch (node)
                {
                    case AssignmentExpressionSyntax assignment
                        when this.BindsTo(assignment.Left, symbol):
                        return true;

                    // `(x, y) = (y, x)` deconstruction-ASSIGNMENT: `assignment.Left`
                    // is the whole tuple, not `symbol` itself, so the plain
                    // `BindsTo` case above never matches — without this, an
                    // existing local written only via deconstruction-assignment
                    // was (mis-)classified as never-reassigned and bound `let`,
                    // then the element-wise write-back lowering (see
                    // `LowerTupleAssignment`) failed gsc GS0127 "read-only"
                    // (issue #1895). A tuple element that is itself a
                    // declaration (`var y` in the mixed `(x, var y) = ...` form)
                    // introduces a NEW binding, not a write to `symbol`, so it is
                    // deliberately excluded by `TupleAssignmentTargetsInclude`.
                    case AssignmentExpressionSyntax tupleAssignment
                        when tupleAssignment.Left is TupleExpressionSyntax leftTuple
                            && this.TupleAssignmentTargetsInclude(leftTuple, symbol):
                        return true;

                    case PostfixUnaryExpressionSyntax postfix
                        when (postfix.IsKind(SyntaxKind.PostIncrementExpression)
                                || postfix.IsKind(SyntaxKind.PostDecrementExpression))
                            && this.BindsTo(postfix.Operand, symbol):
                        return true;

                    case PrefixUnaryExpressionSyntax prefix
                        when (prefix.IsKind(SyntaxKind.PreIncrementExpression)
                                || prefix.IsKind(SyntaxKind.PreDecrementExpression))
                            && this.BindsTo(prefix.Operand, symbol):
                        return true;

                    case ArgumentSyntax argument
                        when !argument.RefOrOutKeyword.IsKind(SyntaxKind.None)
                            && this.BindsTo(argument.Expression, symbol):
                        return true;

                    case PrefixUnaryExpressionSyntax addressOf
                        when addressOf.IsKind(SyntaxKind.AddressOfExpression)
                            && this.BindsTo(addressOf.Operand, symbol):
                        return true;

                    // Issue #1900: `ref int alias = ref v;` aliases `v`'s storage
                    // through G#'s native ref-local (`let/var ref alias T = v`,
                    // no address-of operator on the RHS — see
                    // TranslateRefExpression). gsc's ref-alias binder rejects
                    // aliasing a `let`-bound (read-only) variable
                    // (GS9005-equivalent "cannot take address of constant"), so
                    // `v` must be forced to `var` here exactly like a variable
                    // whose address is taken with the unsafe `&` operator above.
                    case RefExpressionSyntax refOf
                        when refOf.Expression is IdentifierNameSyntax
                            && this.BindsTo(refOf.Expression, symbol):
                        return true;
                }
            }

            return false;
        }
    }
}
