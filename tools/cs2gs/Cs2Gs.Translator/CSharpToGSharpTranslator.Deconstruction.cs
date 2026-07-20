// <copyright file="CSharpToGSharpTranslator.Deconstruction.cs" company="GSharp">
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
        /// Translates an expression that may embed VALUE-POSITION assignments
        /// (`M(x = 5)`, `while ((line = r.ReadLine()) != null)`, `if ((x = f()) >
        /// 0)`), hoisting each into a preceding assignment statement. G# models
        /// assignment as a statement, not a value-yielding expression, so a
        /// naive translation drops the write and keeps only the read (issue
        /// #1723). <paramref name="includeSelf"/> controls whether
        /// <paramref name="expression"/> ITSELF counts as a hoist candidate when
        /// it is an assignment: statement-position callers (where the whole
        /// expression already IS the statement, e.g. `a += 5;`) pass <c>false</c>
        /// so only assignments NESTED inside it (e.g. `a += (b = c);`) are
        /// hoisted; condition callers (`if`/`while`/`for`, where the whole
        /// condition can itself be a bare assignment, e.g. `if (x = f())`) pass
        /// <c>true</c>.
        /// </summary>
        private IEnumerable<GStatement> WithHoistedAssignments(
            ExpressionSyntax expression,
            bool includeSelf,
            Func<List<GStatement>> buildMain)
        {
            List<AssignmentExpressionSyntax> embedded = this.CollectEmbeddedAssignments(expression, includeSelf);
            if (embedded.Count == 0)
            {
                return buildMain();
            }

            var hoisted = new List<GStatement>();
            foreach (AssignmentExpressionSyntax node in embedded)
            {
                hoisted.AddRange(this.FlattenChainedAssignment(node));
            }

            foreach (AssignmentExpressionSyntax node in embedded)
            {
                this.state.SuppressedAssignments.Add(node);
            }

            List<GStatement> main;
            try
            {
                main = buildMain();
            }
            finally
            {
                foreach (AssignmentExpressionSyntax node in embedded)
                {
                    this.state.SuppressedAssignments.Remove(node);
                }
            }

            hoisted.AddRange(main);
            return hoisted;
        }

        /// <summary>
        /// Translates <paramref name="expression"/> (typically a condition:
        /// `if`/`while`/`for`), hoisting any embedded value-position assignment
        /// into <paramref name="prologue"/> as a preceding assignment statement
        /// and returning the condition with each hoisted assignment read as its
        /// already-written target (issue #1723). The whole expression counts as
        /// a hoist candidate (a bare `if (x = f())` condition IS the assignment).
        /// </summary>
        private GExpression TranslateConditionWithHoist(ExpressionSyntax expression, List<GStatement> prologue)
        {
            // Any spill hoisted while translating `expression` (issue #1731) is
            // redirected into `prologue` — the SAME preceding-statement list an
            // embedded assignment hoists into below — rather than the enclosing
            // statement's own ambient prologue, so both kinds of hoist land in
            // the same list in evaluation order.
            List<GStatement> outerSpillPrologue = this.state.PendingSpillPrologue;
            this.state.PendingSpillPrologue = prologue;
            try
            {
                return this.TranslateConditionWithHoistCore(expression, prologue);
            }
            finally
            {
                this.state.PendingSpillPrologue = outerSpillPrologue;
            }
        }

        private GExpression TranslateConditionWithHoistCore(ExpressionSyntax expression, List<GStatement> prologue)
        {
            List<AssignmentExpressionSyntax> embedded = this.CollectEmbeddedAssignments(expression, includeSelf: true);
            if (embedded.Count == 0)
            {
                return this.TranslateExpression(expression);
            }

            foreach (AssignmentExpressionSyntax node in embedded)
            {
                prologue.AddRange(this.FlattenChainedAssignment(node));
            }

            foreach (AssignmentExpressionSyntax node in embedded)
            {
                this.state.SuppressedAssignments.Add(node);
            }

            try
            {
                return this.TranslateExpression(expression);
            }
            finally
            {
                foreach (AssignmentExpressionSyntax node in embedded)
                {
                    this.state.SuppressedAssignments.Remove(node);
                }
            }
        }

        /// <summary>
        /// Finds the outermost value-position assignment nodes in
        /// <paramref name="expression"/> (in evaluation/document order),
        /// excluding ones inside a nested lambda/local function (their own
        /// statement seam) and — for chained links (`a = b = c`) — excluding the
        /// inner links of a chain already captured by the outer node (see
        /// <see cref="FlattenChainedAssignment"/>). An assignment hidden inside the
        /// short-circuited operand of `&amp;&amp;`/`||` or a `?:` branch would change
        /// evaluation COUNT/order if hoisted, so it is flagged unsupported instead
        /// (issue #1723).
        /// </summary>
        private List<AssignmentExpressionSyntax> CollectEmbeddedAssignments(ExpressionSyntax expression, bool includeSelf)
        {
            // Issue #1892: an object/`with` initializer's `Field = value`
            // elements (InitializerExpressionSyntax children of kind
            // ObjectInitializerExpression/WithInitializerExpression) are
            // AssignmentExpressionSyntax nodes syntactically, but they are
            // composite-literal/with-expression MEMBERS, not real value-position
            // assignments — collecting the member assignment itself would hoist
            // every initializer member into a stray bare `Field = value;`
            // statement in front of the (correct) literal/with-expression that
            // already carries it. Array/collection initializer elements
            // (ArrayInitializerExpression/CollectionInitializerExpression), by
            // contrast, are plain VALUES — an `AssignmentExpressionSyntax`
            // element there (`new[] { x = 5 }`) is a genuine value-position
            // assignment and must still be collected.
            //
            // Issue #1947: even for a skipped member-assignment, its VALUE may
            // itself embed a genuine value-position assignment
            // (`new T { A = (x = 3) }`) — that must still be found/hoisted, so
            // the member assignment's Right is scanned rather than skipped
            // wholesale.
            static bool IsInitializerMember(AssignmentExpressionSyntax assignment) =>
                assignment.Parent is InitializerExpressionSyntax initializer &&
                (initializer.IsKind(SyntaxKind.ObjectInitializerExpression) || initializer.IsKind(SyntaxKind.WithInitializerExpression));

            IEnumerable<AssignmentExpressionSyntax> Scan(SyntaxNode node)
            {
                if (node is AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax)
                {
                    yield break;
                }

                if (node is AssignmentExpressionSyntax assignment)
                {
                    if (IsInitializerMember(assignment))
                    {
                        foreach (AssignmentExpressionSyntax found in Scan(assignment.Right))
                        {
                            yield return found;
                        }

                        yield break;
                    }

                    // Outermost assignment: its own descendants are NOT scanned
                    // further here — a chained link (`a = b = c`) is walked by
                    // FlattenChainedAssignment instead.
                    yield return assignment;
                    yield break;
                }

                foreach (SyntaxNode child in node.ChildNodes())
                {
                    foreach (AssignmentExpressionSyntax found in Scan(child))
                    {
                        yield return found;
                    }
                }
            }

            IEnumerable<AssignmentExpressionSyntax> candidates = includeSelf || expression is not AssignmentExpressionSyntax rootAssignment
                ? Scan(expression)
                : Scan(rootAssignment.Left).Concat(Scan(rootAssignment.Right));

            var safe = new List<AssignmentExpressionSyntax>();
            foreach (AssignmentExpressionSyntax candidate in candidates)
            {
                if (IsInShortCircuitOrConditionalBranch(candidate, expression))
                {
                    this.context.ReportUnsupported(
                        candidate,
                        "assignment inside a short-circuited '&&'/'||' operand or a conditional ('?:') branch has no side-effect-preserving G# lowering yet (issue #1723).");
                    continue;
                }

                safe.Add(candidate);
            }

            return safe;
        }

        // True when `node` is reached only through a not-always-evaluated operand
        // inside `root`: the right operand of a `&&`/`||`, either branch of a
        // `?:`, the right operand of `??`, or the "when not null" side of a
        // `?.`/`?[...]` conditional-access chain (including any member/element
        // access further chained off it). Hoisting such an assignment out in
        // front of `root` would evaluate/mutate it unconditionally, changing C#
        // semantics.
        private static bool IsInShortCircuitOrConditionalBranch(SyntaxNode node, ExpressionSyntax root)
        {
            for (SyntaxNode current = node; current != null && current != root; current = current.Parent)
            {
                SyntaxNode parent = current.Parent;
                if (parent is BinaryExpressionSyntax binary &&
                    (binary.IsKind(SyntaxKind.LogicalAndExpression) || binary.IsKind(SyntaxKind.LogicalOrExpression) ||
                     binary.IsKind(SyntaxKind.CoalesceExpression)) &&
                    current == binary.Right)
                {
                    return true;
                }

                if (parent is ConditionalExpressionSyntax conditional &&
                    (current == conditional.WhenTrue || current == conditional.WhenFalse))
                {
                    return true;
                }

                if (parent is ConditionalAccessExpressionSyntax conditionalAccess &&
                    current == conditionalAccess.WhenNotNull)
                {
                    return true;
                }
            }

            return false;
        }

        private static List<PostfixUnaryExpressionSyntax> CollectEmbeddedPostfix(ExpressionSyntax expression)
        {
            // Collect `i++` / `i--` nodes nested inside `expression` (in document
            // order), excluding any that live inside a nested lambda / local
            // function (those belong to that body's own statement seam).
            return expression.DescendantNodes(descendIntoChildren: node =>
                    node is not (AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax))
                .OfType<PostfixUnaryExpressionSyntax>()
                .Where(p => p.IsKind(SyntaxKind.PostIncrementExpression) || p.IsKind(SyntaxKind.PostDecrementExpression))
                .ToList();
        }

        private IEnumerable<GStatement> FlattenChainedAssignment(AssignmentExpressionSyntax assignment)
        {
            // Follows the chain through ANY assignment operator (`=`, `+=`, …), not
            // just `=`: `a = b += c` is `a = (b += c)`, so the `+=` link must also be
            // captured or its mutation of `b` is silently dropped (issue #1723). The
            // walk is parenthesis-transparent (`a = (b = c)`) since a link's RHS may
            // be a parenthesized nested assignment.
            var lefts = new List<(GExpression Target, string Op)>();
            ExpressionSyntax current = assignment;
            TupleExpressionSyntax tupleLink = null;
            ExpressionSyntax tupleLinkRight = null;
            while (true)
            {
                ExpressionSyntax unwrapped = current;
                while (unwrapped is ParenthesizedExpressionSyntax paren)
                {
                    unwrapped = paren.Expression;
                }

                if (unwrapped is not AssignmentExpressionSyntax link)
                {
                    break;
                }

                if (link.Left is TupleExpressionSyntax linkTuple)
                {
                    // A deconstruction-assignment link (`(a, b) = ...`) used in
                    // value position, either standalone (`var r = ((x, y) = (1,
                    // 2));`) or feeding an outer chain (`x = (a, b) = (1, 2);`).
                    // It has no single further "target" of its own, so the
                    // chain walk ends here (issue #1974).
                    tupleLink = linkTuple;
                    tupleLinkRight = link.Right;
                    break;
                }

                lefts.Add((this.TranslateExpression(link.Left), link.OperatorToken.Text));
                current = link.Right;
            }

            var statements = new List<GStatement>();

            // C# evaluates every target's receiver/index sub-expression
            // left-to-right — outermost first, matching source order — BEFORE
            // the shared RHS is evaluated (`a[F()] = b[G()] = c` runs F() then
            // G() then c). Spill each target's side-effecting parts here, in
            // that order; a target that is already an identifier/`this`/field
            // with no side-effecting sub-part passes through untouched.
            var safeTargets = new GExpression[lefts.Count];
            for (int i = 0; i < lefts.Count; i++)
            {
                safeTargets[i] = this.MakeDuplicationSafeTarget(lefts[i].Target, statements);
            }

            GExpression value;
            if (tupleLink != null)
            {
                // A non-identifier target (`arr[i]`, `obj.F`, ...) anywhere in the
                // (possibly nested) target shape is handled by
                // `LowerTupleAssignmentForValue` capturing its receiver/index
                // FIRST, before the RHS is spilled (issue #2234, generalizing
                // #1895/#1974).
                (List<GStatement> tupleStatements, GExpression tupleValue) =
                    this.LowerTupleAssignmentForValue(tupleLink, tupleLinkRight);
                statements.AddRange(tupleStatements);
                value = tupleValue;
            }
            else
            {
                value = this.TranslateExpression(current);
            }

            // Walk the chain innermost-out, assigning to each target in turn.
            // C# assigns the SAME rhs VALUE to every target in a run of plain
            // `=` links — it never re-reads an inner target's getter to obtain
            // the value carried to the next (outer) link (issue #1845): `a =
            // obj.P = c` calls `P`'s setter once and never its getter. A
            // compound link (`+=`, …) genuinely produces a NEW value — the
            // target's old value combined with the operand — so its result
            // still has to be read back for the next link; that read is real
            // C# semantics, unrelated to the #1845 divergence, and is left as
            // it was under the #1731/#1842 fix (the target was already made
            // safe to re-embed above). BUT when a compound link itself has an
            // outer `=` link depending on its result (`a = b = c.P += d`), G#
            // assignment is statement-only (no expression form), so the only
            // way to hand the produced value up the chain is to re-embed the
            // target. Re-embedding the target expression as-is re-reads its
            // getter once per outer link (issue #1875) — instead of doing
            // that, the read/combine/store is expanded manually (mirroring
            // exactly what the compound operator does) so the combined value
            // is captured directly, with no re-read at all.
            bool valueIsShared = false;
            for (int i = lefts.Count - 1; i >= 0; i--)
            {
                bool hasOuterLink = i > 0;
                GExpression assignedValue = value;
                if (hasOuterLink && lefts[i].Op == "=" && !valueIsShared)
                {
                    // About to be assigned to more than one target — spill once
                    // so the RHS expression is evaluated exactly one time, then
                    // every remaining target reuses the same temp/trivial value.
                    assignedValue = this.SpillOperand(value, statements);
                    value = assignedValue;
                    valueIsShared = true;
                }

                if (hasOuterLink && lefts[i].Op != "=" &&
                    !IsTrivialOperand(safeTargets[i]) &&
                    CompoundToBinaryOperator(lefts[i].Op) is string binaryOp)
                {
                    // `c.P += d` reused above (`a = b = c.P += d`): re-embedding
                    // a NON-trivial target (a property/indexer read, unlike a
                    // bare local) would re-run its getter once per outer link
                    // (issue #1875). Instead read c.P's getter exactly once,
                    // combine it with the operand, and store the result — the
                    // combined value (not a re-read of c.P) is what every
                    // outer `=` link reuses, matching C#'s single-getter-call
                    // semantics. A trivial target (bare local/`this`) has no
                    // getter to protect, so it keeps the simpler read-back
                    // below unchanged.
                    GExpression oldValue = this.SpillOperand(safeTargets[i], statements);
                    GExpression newValue = this.SpillOperand(new BinaryExpression(oldValue, binaryOp, assignedValue), statements);
                    statements.Add(new AssignmentStatement(safeTargets[i], newValue, "="));
                    value = newValue;
                    valueIsShared = true;
                    continue;
                }

                statements.Add(new AssignmentStatement(safeTargets[i], assignedValue, lefts[i].Op));

                if (hasOuterLink && lefts[i].Op != "=")
                {
                    // Trivial target (bare local/`this`): reading it back has
                    // no getter to worry about, so it stays the simple
                    // read-back this fix has always used for compound links.
                    // `??=` also lands here regardless of target triviality —
                    // it has no side-effect-free binary-expression equivalent
                    // (it must only evaluate/store the right-hand side when
                    // the target is null) — so a non-trivial `??=` target
                    // costs one extra getter call total (not one per outer
                    // link), the minimum faithful cost without reimplementing
                    // its short-circuit semantics.
                    value = IsTrivialOperand(safeTargets[i]) ? safeTargets[i] : this.SpillOperand(safeTargets[i], statements);
                    valueIsShared = true;
                }
            }

            return statements;
        }

        // Maps a C# compound-assignment operator token (`+=`, `-=`, …) to its
        // underlying binary operator (`+`, `-`, …), or null for `??=` (which
        // has no side-effect-preserving binary-expression equivalent — see
        // <see cref="FlattenChainedAssignment"/>).
        private static string CompoundToBinaryOperator(string compoundOp) => compoundOp switch
        {
            "+=" => "+",
            "-=" => "-",
            "*=" => "*",
            "/=" => "/",
            "%=" => "%",
            "&=" => "&",
            "|=" => "|",
            "^=" => "^",
            "<<=" => "<<",
            ">>=" => ">>",
            ">>>=" => ">>>",
            _ => null,
        };

        // True when a discard element — either the bare-assignment form
        // (`(x, _) = ...`) or the declaration form (`(x, var _) = ...`,
        // parsed as a `DeclarationExpressionSyntax` wrapping a
        // `DiscardDesignationSyntax`).
        private bool IsDeconstructionDiscard(ExpressionSyntax targetExpr) =>
            (targetExpr is IdentifierNameSyntax discardCandidate &&
                discardCandidate.Identifier.ValueText == "_" &&
                this.IsTrueDiscard(discardCandidate)) ||
                targetExpr is DeclarationExpressionSyntax { Designation: DiscardDesignationSyntax };

        // True when EVERY leaf of a (possibly nested) tuple pattern is a
        // discard, e.g. `(_, _)` or `(_, (_, _))` — the whole arm is then
        // dead and can be skipped without allocating any temp or recursing
        // into it (issue #2099, item 3).
        private bool IsAllDiscardTuple(TupleExpressionSyntax pattern)
        {
            foreach (ArgumentSyntax argument in pattern.Arguments)
            {
                ExpressionSyntax element = argument.Expression;
                bool elementIsAllDiscard = element is TupleExpressionSyntax nestedTuple
                    ? this.IsAllDiscardTuple(nestedTuple)
                    : this.IsDeconstructionDiscard(element);
                if (!elementIsAllDiscard)
                {
                    return false;
                }
            }

            return true;
        }

        // Statement-position deconstruction assignment (`(a, b) = (x, y);`):
        // the resulting per-element values are never read back, so discards
        // stay true discards (no temp allocated for them).
        private IEnumerable<GStatement> LowerTupleAssignment(
            TupleExpressionSyntax leftTuple,
            ExpressionSyntax right)
        {
            var statements = new List<GStatement>();
            Dictionary<ExpressionSyntax, GExpression> captured = this.CaptureDeconstructionStorageTargets(leftTuple, statements);
            this.LowerTuplePattern(leftTuple, this.TranslateExpression(right), forceRealTemps: false, statements, captured);
            return statements;
        }

        // Expression-position deconstruction assignment (`var r = ((x, y) =
        // (1, 2));`, `M((a, b) = e)`, ...): the assignment's VALUE — a tuple
        // of the assigned elements, in target order — is needed by the
        // enclosing expression, so every element (including a discard) is
        // captured in a real temp and the value is rebuilt as a tuple literal
        // over those temps (issue #1974).
        private (List<GStatement> Statements, GExpression Value) LowerTupleAssignmentForValue(
            TupleExpressionSyntax leftTuple,
            ExpressionSyntax right)
        {
            var statements = new List<GStatement>();
            Dictionary<ExpressionSyntax, GExpression> captured = this.CaptureDeconstructionStorageTargets(leftTuple, statements);
            List<GExpression> values = this.LowerTuplePattern(leftTuple, this.TranslateExpression(right), forceRealTemps: true, statements, captured);
            GExpression value = new TupleLiteralExpression(values);
            this.state.TupleAssignmentValues[leftTuple] = value;
            return (statements, value);
        }

        // Walks a (possibly nested) deconstruction-assignment target shape
        // and, for every indexer/member-access (or other existing storage-
        // location) leaf, spills its receiver/index sub-expression into a
        // temp via `MakeDuplicationSafeTarget` — the SAME machinery chained
        // assignment (`a[F()] = b[G()] = c`, issue #1731) already uses —
        // emitted into `statements` BEFORE anything about the right-hand
        // side. This preserves C#'s left-to-right, targets-then-value
        // evaluation order (issue #2234, generalizing #1895/#1974: a plain
        // identifier or a new `var`/nested-`var` binding has nothing
        // pre-existing to evaluate, so needs no capture; a nested tuple
        // target is walked recursively, since its own leaves are storage
        // locations too). Returns a map from each captured leaf's original
        // syntax to its now-single-evaluation-safe G# replacement, consulted
        // by `LowerTuplePattern` when it emits the final per-target
        // assignment.
        private Dictionary<ExpressionSyntax, GExpression> CaptureDeconstructionStorageTargets(
            TupleExpressionSyntax pattern,
            List<GStatement> statements)
        {
            var captured = new Dictionary<ExpressionSyntax, GExpression>();
            this.CaptureDeconstructionStorageTargets(pattern, statements, captured);
            return captured;
        }

        private void CaptureDeconstructionStorageTargets(
            TupleExpressionSyntax pattern,
            List<GStatement> statements,
            Dictionary<ExpressionSyntax, GExpression> captured)
        {
            foreach (ArgumentSyntax argument in pattern.Arguments)
            {
                ExpressionSyntax targetExpr = argument.Expression;
                switch (targetExpr)
                {
                    case TupleExpressionSyntax nested:
                        this.CaptureDeconstructionStorageTargets(nested, statements, captured);
                        break;

                    case IdentifierNameSyntax:
                    case DeclarationExpressionSyntax:
                        // No pre-existing storage to evaluate: an identifier is
                        // already a stable reference, and a declaration
                        // (`var y`) is a brand-new local.
                        break;

                    default:
                        // An existing storage location (`arr[i]`, `obj.F`, ...):
                        // spill its receiver/index once, now, before the RHS.
                        captured[targetExpr] = this.MakeDuplicationSafeTarget(this.TranslateExpression(targetExpr), statements);
                        break;
                }
            }
        }

        // Core recursive lowering shared by the statement- and
        // expression-position forms above. `rhsValue` is the G# expression to
        // deconstruct — the fully translated original right-hand side on the
        // OUTERMOST call, or a bare temp-identifier read on a recursive call
        // for a nested target (already single-evaluation-safe, so it needs no
        // further spilling). Returns each element's resulting value (`null`
        // for a true discard when `forceRealTemps` is false, since nothing
        // captures its value in that case).
        private List<GExpression> LowerTuplePattern(
            TupleExpressionSyntax pattern,
            GExpression rhsValue,
            bool forceRealTemps,
            List<GStatement> statements,
            Dictionary<ExpressionSyntax, GExpression> captured)
        {
            int count = pattern.Arguments.Count;
            var temps = new List<string>(count);
            for (int i = 0; i < count; i++)
            {
                ExpressionSyntax targetExpr = pattern.Arguments[i].Expression;

                // A nested tuple target needs its own real temp to recurse
                // into — UNLESS every leaf underneath it is itself a true
                // discard, in which case the whole nested arm is dead and
                // recursing into it would only emit a pointless inner
                // `let (_, _) = __deconN` binding (issue #2099, item 3).
                bool needsRealTemp = forceRealTemps ||
                    (targetExpr is TupleExpressionSyntax nestedDiscardCheck
                        ? !this.IsAllDiscardTuple(nestedDiscardCheck)
                        : !this.IsDeconstructionDiscard(targetExpr));
                temps.Add(needsRealTemp ? $"__decon{this.state.DeconCounter++}" : "_");
            }

            // Spill the WHOLE right-hand side in one native decon-binding.
            // G#'s tuple-deconstruction grammar only accepts `let (...)`
            // (docs/adr/0032-data-struct-ergonomics.md), never `var (...)`,
            // but that is no loss here — these temps are single-use compiler
            // internals, never reassigned. This is exactly the mechanism the
            // declaration form (`var (a, b) = e`) already uses, so it inherits
            // the same RHS-shape support for free.
            statements.Add(new TupleDeconstructionStatement(BindingKind.Let, temps, rhsValue));

            var values = new List<GExpression>(count);
            for (int i = 0; i < count; i++)
            {
                ExpressionSyntax targetExpr = pattern.Arguments[i].Expression;
                if (temps[i] == "_")
                {
                    values.Add(null);
                    continue;
                }

                var tempRead = (GExpression)new IdentifierExpression(temps[i]);

                if (targetExpr is TupleExpressionSyntax nestedTuple)
                {
                    // Nested target (`((a, b), c) = ...`): the outer temp
                    // holds the nested element's value, itself a tuple — spill
                    // IT with a second native decon-binding rather than trying
                    // to flatten every depth into one `let (...)` (issue
                    // #1974). The recursive rhsValue is already a bare temp
                    // read, so no further spill is needed before recursing.
                    List<GExpression> nestedValues = this.LowerTuplePattern(nestedTuple, tempRead, forceRealTemps, statements, captured);
                    values.Add(forceRealTemps ? new TupleLiteralExpression(nestedValues) : null);
                    continue;
                }

                if (targetExpr is DeclarationExpressionSyntax declaration)
                {
                    // Mixed form, e.g. `(x, var y) = ...`: `y` is a NEW local,
                    // not a write to an existing one — bind it directly from
                    // the temp, `var`/`let` per whether it is reassigned later
                    // (mirrors the plain-declaration path's mutability rule).
                    string name = declaration.Designation switch
                    {
                        SingleVariableDesignationSyntax single => single.Identifier.Text,
                        _ => "_",
                    };

                    if (name == "_")
                    {
                        values.Add(forceRealTemps ? tempRead : null);
                        continue;
                    }

                    ILocalSymbol localSymbol = declaration.Designation is SingleVariableDesignationSyntax singleDesignation
                        ? this.context.GetDeclaredSymbol(singleDesignation) as ILocalSymbol
                        : null;

                    // Issue #1967: `(x, Index i) = ...` declares `i` via this
                    // mixed-tuple-assignment designation, not a declarator.
                    if (declaration.Designation is SingleVariableDesignationSyntax indexCheckDesignation)
                    {
                        this.ReportIfIndexOrRangeTypedDesignation(indexCheckDesignation);
                    }

                    BindingKind binding = localSymbol != null && this.IsLocalReassigned(localSymbol)
                        ? BindingKind.Var
                        : BindingKind.Let;
                    statements.Add(new LocalDeclarationStatement(
                        binding,
                        name,
                        type: null,
                        initializer: tempRead));
                    values.Add(new IdentifierExpression(name));
                    continue;
                }

                // An existing local (or member/element access) target: write
                // the spilled value back. A discard target still gets a real
                // temp here (`forceRealTemps=true`, e.g. expression-position
                // `(x, _) = (1, 2)`) so its value can be reconstructed into
                // the outer tuple, but `_` isn't a real assignable location —
                // skip the write itself to avoid emitting a stray, dead
                // `_ = __decon1;` statement (issue #2099).
                if (!this.IsDeconstructionDiscard(targetExpr))
                {
                    // A member/element-access target was already captured
                    // into a duplication-safe replacement BEFORE the RHS was
                    // spilled above (issue #2234); a plain identifier has no
                    // entry and translates as-is.
                    GExpression assignTarget = captured.TryGetValue(targetExpr, out GExpression safeTarget)
                        ? safeTarget
                        : this.TranslateExpression(targetExpr);
                    statements.Add(new AssignmentStatement(assignTarget, tempRead));
                }

                values.Add(tempRead);
            }

            return values;
        }

        private bool TryGetDeconstructionTargets(
            ExpressionSyntax left,
            out BindingKind binding,
            out IReadOnlyList<string> names)
        {
            binding = BindingKind.Let;
            names = null;

            // `var (a, b) = e`.
            if (left is DeclarationExpressionSyntax { Designation: ParenthesizedVariableDesignationSyntax parenthesized })
            {
                var collected = new List<string>();
                foreach (VariableDesignationSyntax designation in parenthesized.Variables)
                {
                    collected.Add(designation switch
                    {
                        SingleVariableDesignationSyntax single => single.Identifier.Text,
                        _ => "_",
                    });

                    // Issue #1967: `var (i, r) = ...` declares each element via a
                    // designation, not a declarator.
                    if (designation is SingleVariableDesignationSyntax indexCheckSingle)
                    {
                        this.ReportIfIndexOrRangeTypedDesignation(indexCheckSingle);
                    }
                }

                names = collected;
                return true;
            }

            // `(var a, var b) = e`.
            if (left is TupleExpressionSyntax tuple &&
                tuple.Arguments.All(a => a.Expression is DeclarationExpressionSyntax))
            {
                var collected = new List<string>();
                foreach (ArgumentSyntax argument in tuple.Arguments)
                {
                    var declaration = (DeclarationExpressionSyntax)argument.Expression;
                    collected.Add(declaration.Designation switch
                    {
                        SingleVariableDesignationSyntax single => single.Identifier.Text,
                        _ => "_",
                    });

                    // Issue #1967: `(var i, var r) = ...` — same as above, one
                    // designation per tuple element.
                    if (declaration.Designation is SingleVariableDesignationSyntax indexCheckSingle)
                    {
                        this.ReportIfIndexOrRangeTypedDesignation(indexCheckSingle);
                    }
                }

                names = collected;
                return true;
            }

            return false;
        }

        private GStatement TranslateLock(LockStatementSyntax lockStatement)
        {
            // Issue #1885: G# has a first-class `lock target { body }` statement
            // with the SAME single-evaluation, Monitor.Enter/try-finally/
            // Monitor.Exit semantics as C#'s `lock`, so the translated target
            // is emitted once and gsc lowers it — no manual Monitor lowering
            // (and no missing `import System.Threading`) needed here.
            GExpression target = this.TranslateExpression(lockStatement.Expression);
            BlockStatement body = this.TranslateStatementAsBlock(lockStatement.Statement);
            return new LockStatement(target, body);
        }

        // True when duplicating `expression` in the output has no observable
        // effect — a bare identifier, `this`, or a literal never has a side
        // effect and always reads the same value, so it is safe to embed at more
        // than one output position without spilling it to a temp first (issue
        // #1731). Anything else (a method/property/indexer read, an arithmetic
        // expression, …) may run a side effect or re-read a mutable value and
        // must be evaluated exactly once if it needs to appear more than once.
        private static bool IsTrivialOperand(GExpression expression) =>
            expression is IdentifierExpression or ThisExpression or LiteralExpression;

        // Spills `operand` into a fresh `let` in the active statement seam's
        // prologue (see <see cref="pendingSpillPrologue"/>/<see
        // cref="WithSpillSeam"/>) and returns a reference to that local, UNLESS
        // `operand` is already trivial (see <see cref="IsTrivialOperand"/>) — a
        // bare local/`this`/literal is safe to duplicate as-is, so spilling it
        // would only add clutter. When no statement seam is active (translating
        // outside any statement, or across a lambda/local-function boundary —
        // see <see cref="TranslateLambda"/>/<see cref="TranslateLocalFunction"/>)
        // the operand is conservatively left embedded as-is rather than spilled
        // into an unrelated scope.
        private GExpression SpillOperand(GExpression operand) => this.SpillOperand(operand, this.state.PendingSpillPrologue);

        // As above, but for a call site that CAN be reached from a "null-seam"
        // expression context — a field/property initializer or a
        // base(...)/this(...) constructor-initializer argument (issue #1731
        // N1) — where `this.state.PendingSpillPrologue` is null and G#'s grammar has
        // no expression-only way to host a spill `let`: a bare block-with-
        // trailing-expression is only legal directly inside a lambda arrow
        // body or an if/else branch (not a field initializer or a `base`/
        // `this` argument list), and G# has no "call an arbitrary parenthesized
        // expression" postfix form to smuggle one in as an immediately-invoked
        // lambda either (ParsePostfixChainCore has no open-paren/invocation
        // case for a non-name target). Issue #1849: when a null-seam capture
        // session IS active (`TranslateNullSeamExpression`/
        // `TranslateNullSeamArgument` opened one), `operand` is instead captured
        // as a synthetic helper parameter — the caller lowers the whole
        // null-seam expression to a call to a synthesized private static helper,
        // which gives a real seam for `operand` to be evaluated exactly once.
        // Only when NO capture session is active either (a shape that reaches
        // `SpillOperand` from somewhere `TranslateNullSeamExpression` does not
        // guard, e.g. a future null-seam call site not yet routed through it)
        // does this fall back to the old, loud `Unsupported` diagnostic — still
        // embedding the untouched operand so translation keeps producing
        // (compiling, if diagnostically-flagged) output.
        private GExpression SpillOperand(GExpression operand, SyntaxNode operandSyntaxForDiagnostic)
        {
            if (this.state.PendingSpillPrologue != null || IsTrivialOperand(operand))
            {
                return this.SpillOperand(operand);
            }

            if (this.state.PendingHelperCaptures != null)
            {
                string paramName = $"__p{this.state.PendingHelperCaptures.Count}";
                GTypeReference type = operandSyntaxForDiagnostic is ExpressionSyntax operandExpression
                    ? this.ResolveExpressionType(operandExpression)
                    : null;
                this.state.PendingHelperCaptures.Add(
                    (paramName, operand, type ?? new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType)));
                return new IdentifierExpression(paramName);
            }

            string message =
                "a non-trivial pattern-scrutinee/range-slice operand here has no enclosing statement to host a " +
                "single-evaluation spill (a field/property initializer or a base(...)/this(...) constructor " +
                "argument has no G# lowering for this yet); it is embedded as-is, which re-evaluates it if it " +
                "is read more than once (issue #1731 N1).";
            this.context.ReportUnsupported(operandSyntaxForDiagnostic, message);
            return operand;
        }

        // Issue #1849: translates `expression` at a null-seam site (a field/
        // property initializer) so that a non-trivial `is`-pattern scrutinee or
        // range-slice start operand nested inside it is evaluated exactly once
        // even though the site has no statement to host a spill `let`. When a
        // spill seam IS active (this null-seam site is unreachable, or is
        // nested inside one some other way), translation proceeds exactly as
        // before — this only changes behavior at a genuine null seam. When the
        // owning type is unknown or `expression`'s type cannot be resolved, a
        // synthetic helper cannot be synthesized/typed; translation falls back
        // to the plain path, which still surfaces the existing `Unsupported`
        // diagnostic via `SpillOperand` if a non-trivial operand is actually
        // encountered. Otherwise, if translating `expression` captured one or
        // more non-trivial operands (see `pendingHelperCaptures`), a private
        // static helper — `private static R __initN(T0 p0, T1 p1, ...) => body;`
        // — is synthesized into `pendingSynthHelpers` and `expression` is
        // rewritten to call it, passing the captured operands (translated in
        // their original left-to-right order) as arguments. Each captured
        // operand is thus evaluated exactly once, by the CALLER, before the
        // helper runs the pattern/range-slice logic against the parameter.
        private GExpression TranslateNullSeamExpression(ExpressionSyntax expression, INamedTypeSymbol containingType)
        {
            if (this.state.PendingSpillPrologue != null)
            {
                return this.CoerceArrayCovarianceConversion(expression, this.TranslateExpression(expression));
            }

            GTypeReference returnType = containingType != null ? this.ResolveExpressionType(expression) : null;
            if (returnType == null)
            {
                return this.CoerceArrayCovarianceConversion(expression, this.TranslateExpression(expression));
            }

            return this.CoerceArrayCovarianceConversion(
                expression,
                this.WrapInNullSeamHelperIfCaptured(() => this.TranslateExpression(expression), returnType, containingType));
        }

        // Issue #1849: as <see cref="TranslateNullSeamExpression"/>, but for a
        // whole base(...)/this(...) constructor-initializer argument LIST — each
        // argument is lowered independently via <see cref="TranslateNullSeamArgument"/>.
        // A named argument list is left to the existing `TranslateArguments`
        // reordering-safety logic untouched (out of scope here; named args in a
        // ctor initializer are rare and that path already reports its own
        // diagnostics for anything unsafe to reorder).
        private List<GExpression> TranslateNullSeamArguments(
            SeparatedSyntaxList<ArgumentSyntax> arguments,
            IMethodSymbol ctorSymbol)
        {
            if (this.state.PendingSpillPrologue != null || arguments.Any(a => a.NameColon != null))
            {
                return this.TranslateArguments(arguments);
            }

            return arguments.Select(a => this.TranslateNullSeamArgument(a, ctorSymbol)).ToList();
        }

        // Issue #1849: as <see cref="TranslateNullSeamExpression"/>, but for a
        // single base(...)/this(...) constructor-initializer argument —
        // `TranslateArgument` already handles ref/out/nullability-assertion
        // shapes, so this reuses it as the capture-mode translation delegate
        // rather than duplicating that logic. Each argument in a base/this
        // argument list is lowered independently: only an argument that itself
        // captures a non-trivial operand gets rewritten into a helper call, the
        // rest of the argument list is untouched.
        //
        // Unlike a field/property initializer, a ctor-initializer argument CAN
        // read the enclosing constructor's own parameters (`: this(s[Next()..j])`)
        // — and unlike a normal double-embed, a bare reference to one of those
        // parameters is not just "safe to duplicate", it is only IN SCOPE at all
        // inside the constructor; if the argument gets rewritten into a call to a
        // new static helper method, any such parameter reference in the body
        // would become an undefined identifier unless it is ALSO threaded through
        // as a same-named helper parameter. `CollectCtorParameterCaptures` finds
        // every constructor parameter this argument reads and pre-seeds the
        // capture list with a same-named passthrough capture for each (a
        // parameter read has no side effect, so its position in the final
        // parameter list relative to a genuinely spilled operand is immaterial —
        // only the spilled operands' own relative order matters, and that is
        // still exactly source order since they are appended by `SpillOperand`
        // as translation encounters them).
        private GExpression TranslateNullSeamArgument(ArgumentSyntax argument, IMethodSymbol ctorSymbol)
        {
            // Issue #1849 review: a `ref`/`out` argument's value IS the
            // caller's own variable — a helper cannot `return` it back into
            // that slot, so a non-trivial nested null-seam operand inside one
            // (exotic: `ref`/`out` in a base/this ctor-init argument) is never
            // routed through the helper lowering. `TranslateArgument` still
            // reports the ordinary loud `Unsupported` diagnostic via
            // `SpillOperand` if such an operand is actually encountered, since
            // no capture session is opened here.
            if (argument.RefKindKeyword.Kind() is SyntaxKind.RefKeyword or SyntaxKind.OutKeyword)
            {
                return this.TranslateArgument(argument);
            }

            INamedTypeSymbol containingType = ctorSymbol?.ContainingType;
            GTypeReference returnType = containingType != null
                ? this.ResolveExpressionType(argument.Expression)
                : null;
            if (returnType == null)
            {
                return this.TranslateArgument(argument);
            }

            List<(string Name, GExpression Operand, GTypeReference Type)> preSeeded =
                ctorSymbol != null ? this.CollectCtorParameterCaptures(argument.Expression, ctorSymbol) : null;

            return this.WrapInNullSeamHelperIfCaptured(
                () => this.TranslateArgument(argument), returnType, containingType, preSeeded);
        }

        // Issue #1849: finds every DISTINCT parameter of `ctorSymbol` that
        // `expression` reads, in first-occurrence order, for pre-seeding
        // <see cref="WrapInNullSeamHelperIfCaptured"/>'s capture list (see
        // <see cref="TranslateNullSeamArgument"/>). Each is captured as a
        // same-named passthrough parameter, so no rewriting of the reference
        // itself is needed — the existing sanitized identifier already reads
        // correctly as the helper's own parameter of the same name.
        private List<(string Name, GExpression Operand, GTypeReference Type)> CollectCtorParameterCaptures(
            ExpressionSyntax expression, IMethodSymbol ctorSymbol)
        {
            var seen = new HashSet<IParameterSymbol>(SymbolEqualityComparer.Default);
            var result = new List<(string Name, GExpression Operand, GTypeReference Type)>();
            foreach (IdentifierNameSyntax id in expression.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>())
            {
                if (this.context.GetSymbolInfo(id).Symbol is IParameterSymbol parameter &&
                    SymbolEqualityComparer.Default.Equals(parameter.ContainingSymbol, ctorSymbol) &&
                    seen.Add(parameter))
                {
                    string name = SanitizeIdentifier(parameter.Name);
                    GTypeReference type = this.typeMapper.Map(parameter.Type, this.context, id.GetLocation());
                    result.Add((name, new IdentifierExpression(name), type));
                }
            }

            return result;
        }

        // Issue #1849: runs `translate` inside a fresh null-seam helper-capture
        // session (see `pendingHelperCaptures`), optionally pre-seeded with
        // `preSeededCaptures` (constructor-parameter passthroughs — see
        // <see cref="TranslateNullSeamArgument"/>). If translating `translate`
        // captured no NEW (non-pre-seeded) operand, the pre-seed is discarded and
        // the translated expression is returned unchanged — the common case:
        // most initializers/arguments contain no non-trivial pattern/range-slice
        // operand at all, so no helper is warranted just because the expression
        // happens to read a constructor parameter. Otherwise a private static
        // helper taking every capture (pre-seeded passthroughs plus newly
        // spilled operands) as parameters — in capture order, which for the
        // spilled operands is left-to-right source order since `SpillOperand`
        // records a capture the first time each non-trivial operand is
        // translated — is synthesized with `returnType` and queued in
        // `pendingSynthHelpers`, and a call to it (passing the captured operand
        // expressions as arguments) is returned in place of the original
        // expression.
        private GExpression WrapInNullSeamHelperIfCaptured(
            Func<GExpression> translate,
            GTypeReference returnType,
            INamedTypeSymbol containingType,
            List<(string Name, GExpression Operand, GTypeReference Type)> preSeededCaptures = null)
        {
            List<(string Name, GExpression Operand, GTypeReference Type)> outerCaptures = this.state.PendingHelperCaptures;
            var captures = new List<(string Name, GExpression Operand, GTypeReference Type)>();
            if (preSeededCaptures != null)
            {
                captures.AddRange(preSeededCaptures);
            }

            int preSeedCount = captures.Count;
            this.state.PendingHelperCaptures = captures;
            GExpression body;
            try
            {
                body = translate();
            }
            finally
            {
                this.state.PendingHelperCaptures = outerCaptures;
            }

            if (captures.Count == preSeedCount)
            {
                return body;
            }

            // Issue #1849 review: a capture's own call-site OPERAND (the
            // argument expression this helper will be invoked with) can itself
            // reference a sibling capture's synthesized parameter name — this
            // happens when a null-seam operand is ITSELF nested inside another
            // null-seam operand (e.g. a range-slice start spilled inside an
            // is-pattern scrutinee that is also spilled: `Y[Z()..a] is [1,2]`).
            // The inner spill's `__pN` placeholder only exists as a PARAMETER
            // inside this helper's own body — it is not in scope at the call
            // site, so passing it as a sibling argument would emit a dangling
            // identifier. Detect any such cross-reference and bail to the loud
            // `Unsupported` diagnostic (re-translating with no capture session
            // active, so `SpillOperand` reports it) instead of emitting a
            // broken call.
            // Pre-seeded ctor-parameter passthroughs (see `TranslateNullSeamArgument`)
            // are real, in-scope-at-the-call-site names — only a capture
            // introduced by `SpillOperand` itself (a synthesized `__pN`) is
            // unsafe to reference from a sibling capture's operand.
            var paramNames = new HashSet<string>(
                captures.Skip(preSeedCount).Select(c => c.Name), StringComparer.Ordinal);
            if (captures.Any(c => ContainsIdentifierReference(c.Operand, paramNames)))
            {
                this.state.PendingHelperCaptures = null;
                try
                {
                    return translate();
                }
                finally
                {
                    this.state.PendingHelperCaptures = outerCaptures;
                }
            }

            string helperName = this.NextSynthHelperName(containingType);
            List<Parameter> parameters = captures
                .Select(c => new Parameter(c.Name, c.Type))
                .ToList();
            this.state.PendingSynthHelpers.Add(new MethodDeclaration(
                helperName,
                parameters,
                returnType,
                new BlockStatement(new List<GStatement> { new ReturnStatement(body) }),
                visibility: Visibility.Private));

            return new InvocationExpression(
                new IdentifierExpression(helperName),
                captures.Select(c => c.Operand).ToList());
        }

        // Issue #1849 review: true if `node` (a capture's call-site operand, or
        // any sub-tree of one) reads an identifier whose name is in `names` —
        // used by <see cref="WrapInNullSeamHelperIfCaptured"/> to detect a
        // sibling capture's synthesized `__pN` parameter name leaking into
        // another capture's own call-site argument. Walks every public
        // property of the AST node reflectively (rather than hand-listing each
        // of the ~30 <see cref="GExpression"/> subtypes) so it stays correct
        // for arbitrarily nested/mixed shapes without needing a matching case
        // added here every time a new expression node is introduced.
        private static bool ContainsIdentifierReference(GNode node, ISet<string> names)
        {
            if (node == null)
            {
                return false;
            }

            if (node is IdentifierExpression identifier)
            {
                return names.Contains(identifier.Name);
            }

            foreach (System.Reflection.PropertyInfo property in node.GetType().GetProperties())
            {
                object value = property.GetValue(node);
                if (value is GNode child && ContainsIdentifierReference(child, names))
                {
                    return true;
                }

                if (value is System.Collections.IEnumerable items and not string)
                {
                    foreach (object item in items)
                    {
                        if (item is GNode itemNode && ContainsIdentifierReference(itemNode, names))
                        {
                            return true;
                        }
                    }
                }
            }

            return false;
        }

        // Issue #1849: picks a synthetic null-seam helper method name
        // (`__init0`, `__init1`, ...) unique against both `containingType`'s
        // existing members and every helper already queued for this same
        // aggregate in `pendingSynthHelpers` (avoids a collision when a type
        // already happens to declare a same-named member, or between two
        // helpers synthesized for the same type in one translation pass).
        private string NextSynthHelperName(INamedTypeSymbol containingType)
        {
            var existingNames = new HashSet<string>(
                containingType.GetMembers().Select(m => m.Name), StringComparer.Ordinal);
            string name;
            do
            {
                name = $"__init{this.state.SynthHelperCounter++}";
            }
            while (existingNames.Contains(name) ||
                this.state.PendingSynthHelpers.Any(h => h.Name == name));

            return name;
        }

        // As above, but appends the spill declaration directly to an explicit
        // `prologue` list rather than the ambient one — used by callers (e.g.
        // <see cref="FlattenChainedAssignment"/>) that already build their own
        // ordered statement list and know exactly where the spill must land,
        // independent of whatever statement seam happens to be active.
        private GExpression SpillOperand(GExpression operand, List<GStatement> prologue)
        {
            if (IsTrivialOperand(operand) || prologue == null)
            {
                return operand;
            }

            string temp = $"__spill{this.state.SpillCounter++}";
            prologue.Add(new LocalDeclarationStatement(BindingKind.Let, temp, type: null, initializer: operand));
            return new IdentifierExpression(temp);
        }

        // Rebuilds an assignment TARGET (a link's left-hand side in a chained
        // assignment `a = TARGET = c`) so its receiver/index sub-expression is
        // evaluated exactly once even though the target is written to (and, for
        // a compound-operator link, read back — see
        // <see cref="FlattenChainedAssignment"/>) — the receiver of a member
        // access and the index of an element access are each spilled at most
        // once via <see cref="SpillOperand(GExpression, List{GStatement})"/>,
        // and the target is rebuilt from those (now-trivial) pieces (issue
        // #1731). A target that is already an identifier/`this`/literal, or a
        // member access whose receiver needs no spilling, passes through
        // untouched.
        private GExpression MakeDuplicationSafeTarget(GExpression target, List<GStatement> prologue)
        {
            switch (target)
            {
                case MemberAccessExpression member:
                    return new MemberAccessExpression(this.MakeDuplicationSafeTarget(member.Target, prologue), member.MemberName);

                case IndexExpression index:
                    return new IndexExpression(
                        this.MakeDuplicationSafeTarget(index.Target, prologue),
                        this.SpillOperand(index.Index, prologue));

                default:
                    return this.SpillOperand(target, prologue);
            }
        }

        // Establishes a fresh statement seam (issue #1731) around a single
        // value-producing translation that has no `TranslateStatement` seam of
        // its own — a member/lambda/local-function arrow body, which behaves
        // like an implicit `return expr;` statement. Any spill collected while
        // running `translate` is emitted immediately ahead of its result, then
        // the ambient seam is restored (mirrors <see cref="TranslateStatement"/>).
        private IReadOnlyList<GStatement> WithSpillSeam(Func<IReadOnlyList<GStatement>> translate)
        {
            List<GStatement> outerSpillPrologue = this.state.PendingSpillPrologue;
            var spillPrologue = new List<GStatement>();
            this.state.PendingSpillPrologue = spillPrologue;
            try
            {
                IReadOnlyList<GStatement> core = translate();
                if (spillPrologue.Count == 0)
                {
                    return core;
                }

                var combined = new List<GStatement>(spillPrologue);
                combined.AddRange(core);
                return combined;
            }
            finally
            {
                this.state.PendingSpillPrologue = outerSpillPrologue;
            }
        }

        private GStatement TranslateLocalFunction(LocalFunctionStatementSyntax localFunction)
        {
            // Issue #1900: a ref-returning local function (`static ref int
            // Pick(...)`) has no G# canonical form. A C# local function lowers to
            // a G# `func` LITERAL bound via `let` (ParseFunctionLiteralExpression
            // has no `ref`-return-modifier slot at all — only a genuine top-level
            // `func`/method declaration does, ADR-0060 §follow-up/issue #490), and
            // gsc separately forbids a managed pointer as a function-literal
            // return type outright (GS9004 "a managed pointer (*T) cannot be the
            // return type of a function literal"). There is no lowering that
            // preserves ref-aliasing through a func literal, so this gaps loudly
            // rather than emitting a form that either drops the aliasing (a
            // silent semantic change) or fails to compile.
            if (this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol { ReturnsByRef: true })
            {
                this.context.ReportUnsupported(
                    localFunction,
                    $"ref-returning local function '{localFunction.Identifier.Text}' has no canonical G# form: a local function lowers to a `func` literal, and G#'s `ref` return modifier only exists on a genuine top-level/method function declaration (issue #1900).");
                return new RawStatement($"// unsupported: ref-returning local function '{localFunction.Identifier.Text}'");
            }

            // A C# local function maps to a G# local `let` bound to a function
            // literal `func (params) RetType { … }` (NOT an arrow lambda — a local
            // function may be recursive and needs an explicit return type).
            var parameters = new List<Parameter>();
            foreach (ParameterSyntax parameter in localFunction.ParameterList.Parameters)
            {
                parameters.Add(this.MapLambdaParameter(parameter));
            }

            bool isAsync = localFunction.Modifiers.Any(m => m.IsKind(SyntaxKind.AsyncKeyword));

            // A local function renders as a `func` literal (NOT an arrow lambda):
            // a value-returning one needs an explicit return type (else the literal
            // is inferred void and `return expr` is rejected), and the explicit type
            // also supports recursion. The declared symbol carries the real return
            // type / void-ness; the async unwrap mirrors method `func`s.
            IMethodSymbol localSymbol = this.context.GetDeclaredSymbol(localFunction) as IMethodSymbol;
            GTypeReference returnType = localSymbol != null
                ? this.MapDelegateLikeReturnType(localSymbol, isAsync, localFunction.ReturnType.GetLocation())
                : null;

            // Issue #2438: an `async void` LOCAL function (Oahu's
            // `AaxFileConversionProgressUpdate` shape) needs the exact same
            // fire-and-forget rewrite as an `async void` METHOD — see
            // BuildAsyncVoidHandlerWrapperBody. The local function still
            // lowers to a single `let`-bound literal either way, so its
            // name/identity for `+=`/`-=` subscription is unaffected: only
            // the literal it is bound to changes shape (non-async wrapper
            // instead of the raw async literal).
            bool isAsyncVoidHandler = localSymbol != null && IsCSharpAsyncVoidHandler(localSymbol);

            // A local function's body is its own evaluation scope: a spill hoisted
            // while translating it (issue #1731) must never leak into the
            // ENCLOSING statement's prologue (that would evaluate the operand once,
            // eagerly, at the local-function declaration instead of per call). The
            // ambient seam is suspended for the body's translation; each statement
            // inside a block body still opens its own fresh seam via
            // <see cref="TranslateStatement"/>.
            List<GStatement> outerSpillPrologue = this.state.PendingSpillPrologue;
            this.state.PendingSpillPrologue = null;
            LambdaExpression lambda;
            try
            {
                if (localFunction.Body != null)
                {
                    BlockStatement innerBody = this.WithParameterShadows(localFunction, this.TranslateBlock(localFunction.Body));
                    lambda = isAsyncVoidHandler
                        ? new LambdaExpression(parameters, blockBody: this.BuildAsyncVoidHandlerWrapperBody(parameters, innerBody, localFunction.GetLocation()), isAsync: false, returnType: null, isFunctionLiteral: true)
                        : new LambdaExpression(parameters, blockBody: innerBody, isAsync: isAsync, returnType: returnType, isFunctionLiteral: true);
                }
                else if (localFunction.ExpressionBody != null)
                {
                    // The expression body has no per-statement seam of its own
                    // (unlike a block body — see below), so a nested spill (issue
                    // #1731) must open a fresh seam here via
                    // <see cref="WithSpillSeam"/> — evaluated per call, inside this
                    // very body, rather than being silently dropped by the
                    // enclosing null seam above.
                    BlockStatement innerBody = new BlockStatement(this.WithSpillSeam(
                        () => this.TranslateExpressionStatements(localFunction.ExpressionBody.Expression).ToList()).ToList());
                    lambda = isAsyncVoidHandler
                        ? new LambdaExpression(parameters, blockBody: this.BuildAsyncVoidHandlerWrapperBody(parameters, innerBody, localFunction.GetLocation()), isAsync: false, returnType: null, isFunctionLiteral: true)
                        : new LambdaExpression(parameters, blockBody: innerBody, isAsync: isAsync, returnType: returnType, isFunctionLiteral: true);
                }
                else
                {
                    lambda = new LambdaExpression(parameters, blockBody: new BlockStatement(new List<GStatement>()), isAsync: isAsync, returnType: returnType, isFunctionLiteral: true);
                }
            }
            finally
            {
                this.state.PendingSpillPrologue = outerSpillPrologue;
            }

            // Issue #1886: a generic local function (`T First<T>(a, b) { ... }`)
            // carries its type parameters on the `let` binding, not the anonymous
            // function literal (which has no name to hang `[T]` off) — see
            // `let Name[T, U] = func (...) ... { ... }` in G#.
            var typeParameters = localFunction.TypeParameterList?.Parameters
                .Select(tp => SanitizeIdentifier(tp.Identifier.Text))
                .ToList();

            return new LocalFunctionStatement(SanitizeIdentifier(localFunction.Identifier.Text), lambda, typeParameters);
        }

        /// <summary>
        /// Parenthesizes a statement-condition whose printed form would otherwise be
        /// misparsed. A condition ending in an index expression (`… a[i]`) directly
        /// precedes the block's `{`, which the G# parser greedily reads as a
        /// composite-literal initializer (`a[i]{ … }`); wrapping the condition in
        /// parentheses disambiguates it (G# parser limitation; see PR notes).
        /// </summary>
        private static GExpression GuardBlockCondition(GExpression condition)
        {
            if (condition is ParenthesizedExpression)
            {
                return condition;
            }

            return EndsWithIndexExpression(condition)
                ? new ParenthesizedExpression(condition)
                : condition;
        }

        private static bool EndsWithIndexExpression(GExpression expression)
        {
            return expression switch
            {
                IndexExpression => true,
                BinaryExpression binary => EndsWithIndexExpression(binary.Right),
                _ => false,
            };
        }
    }
}
