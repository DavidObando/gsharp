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
        /// Hosts value-position deconstruction assignments, the lone assignment
        /// shape without a native G# expression form. Ordinary and compound
        /// assignments remain in place as ADR-0161 assignment expressions.
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
        /// Translates a condition while redirecting any spill or embedded
        /// deconstruction-assignment statements into <paramref name="prologue"/>.
        /// </summary>
        private GExpression TranslateConditionWithHoist(ExpressionSyntax expression, List<GStatement> prologue)
        {
            // Any spill hoisted while translating `expression` (issue #1731) is
            // redirected into `prologue` — the SAME preceding-statement list an
            // embedded deconstruction assignment uses — rather than the enclosing
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
        /// Finds value-position deconstruction-assignment nodes in
        /// <paramref name="expression"/> (in evaluation/document order),
        /// excluding ones inside a nested lambda/local function (their own
        /// statement seam). Assignments inside a conditional
        /// (`?:`) arm are left for that arm's native G# block-expression seam.
        /// Assignments hidden inside any other short-circuited operand would change
        /// evaluation COUNT/order if hoisted, so they are flagged unsupported
        /// instead (issue #1723).
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

                // Issue #3348: a query CLAUSE's expression is translated inside the
                // lambda that clause lowers to (see <see cref="BuildScopeLambda"/> /
                // <see cref="LowerLetClause"/>) — its own evaluation scope, exactly
                // like an explicit lambda's, even though it is not an
                // `AnonymousFunctionExpressionSyntax` syntactically. Hoisting an
                // assignment out of one would move the write into the ENCLOSING
                // statement, where the range variable it reads is not in scope at
                // all, and would run it once for the whole query instead of once per
                // element. Only the sub-expressions a query evaluates EAGERLY, in the
                // enclosing scope, are scanned here: the source of the first `from`,
                // and each `join`'s `in` source (C# forbids either from referencing a
                // range variable, so neither can capture one). Every clause body is
                // left to its own lambda's seam, which hoists into the lambda.
                if (node is QueryExpressionSyntax query)
                {
                    foreach (ExpressionSyntax eager in EagerQuerySources(query))
                    {
                        foreach (AssignmentExpressionSyntax found in Scan(eager))
                        {
                            yield return found;
                        }
                    }

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

                    // ADR-0161 / issue #3347: ordinary assignment expressions,
                    // including `??=`, stay where C# put them. Only
                    // deconstruction still requires statement-hosting fallback.
                    if (AssignmentRequiresStatementLowering(assignment))
                    {
                        yield return assignment;
                        yield break;
                    }

                    foreach (SyntaxNode child in assignment.ChildNodes())
                    {
                        foreach (AssignmentExpressionSyntax found in Scan(child))
                        {
                            yield return found;
                        }
                    }

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
                if (IsInsideConditionalValueBranch(candidate, expression))
                {
                    continue;
                }

                if (IsInShortCircuitedSubexpression(candidate, expression))
                {
                    // ADR-0161 / issue #3350: a short-circuited operand's write must
                    // run only when that operand is evaluated, so it cannot be
                    // hoisted into a preceding statement — but it does not need to
                    // be. G# assignment is a value-yielding expression, so
                    // `TranslateAssignmentAsExpression` emits it in place, exactly
                    // where C# put it. Skipping it here leaves it to that path.
                    //
                    // This previously reported Unsupported and then DROPPED the
                    // write entirely (issue #1723), on the mistaken premise that G#
                    // assignment was statement-only.
                    continue;
                }

                safe.Add(candidate);
            }

            return safe;
        }

        private static bool AssignmentRequiresStatementLowering(
            AssignmentExpressionSyntax assignment) =>
            assignment.Left is TupleExpressionSyntax;

        // Issue #3348: the sub-expressions of `query` that are evaluated EAGERLY, in
        // the scope enclosing the query, rather than inside one of the lambdas its
        // clauses lower to — the first `from`'s source, and every `join`'s `in`
        // source (including those in an `into` continuation's body). C# forbids both
        // from referencing a range variable, so a hoist out of either is safe.
        // Everything else in a query is a clause body and belongs to its own lambda.
        private static IEnumerable<ExpressionSyntax> EagerQuerySources(QueryExpressionSyntax query)
        {
            yield return query.FromClause.Expression;

            for (QueryBodySyntax body = query.Body; body != null; body = body.Continuation?.Body)
            {
                foreach (QueryClauseSyntax clause in body.Clauses)
                {
                    if (clause is JoinClauseSyntax join)
                    {
                        yield return join.InExpression;
                    }
                }
            }
        }

        // Conditional and switch-expression arms own block-expression seams. An
        // enclosing seam must leave each assignment inside its selected arm.
        private static bool IsInsideConditionalValueBranch(SyntaxNode node, ExpressionSyntax root)
        {
            for (SyntaxNode current = node; current != null && current != root; current = current.Parent)
            {
                SyntaxNode parent = current.Parent;
                if (parent is ConditionalExpressionSyntax conditional &&
                    (current == conditional.WhenTrue || current == conditional.WhenFalse))
                {
                    return true;
                }

                if (parent is SwitchExpressionArmSyntax switchArm &&
                    current == switchArm.Expression)
                {
                    return true;
                }
            }

            return false;
        }

        // True when `node` is reached only through a not-always-evaluated operand
        // inside `root`: the right operand of `&&`/`||`/`??`, or the "when not
        // null" side of a `?.`/`?[...]` conditional-access chain (including any
        // member/element access further chained off it). Unlike a `?:` arm, these
        // positions have no native statement-hosting expression seam.
        private static bool IsInShortCircuitedSubexpression(SyntaxNode node, ExpressionSyntax root)
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
            // Collect eagerly evaluated `i++` / `i--` nodes in document order.
            // Conditional/short-circuited operands keep G#'s native inline form.
            return expression.DescendantNodes(descendIntoChildren: node =>
                    node is not (AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax))
                .OfType<PostfixUnaryExpressionSyntax>()
                .Where(p => p.IsKind(SyntaxKind.PostIncrementExpression) || p.IsKind(SyntaxKind.PostDecrementExpression))
                .Where(p => !IsInsideConditionalValueBranch(p, expression))
                .Where(p => !IsInShortCircuitedSubexpression(p, expression))
                .ToList();
        }

        private IEnumerable<GStatement> FlattenChainedAssignment(
            AssignmentExpressionSyntax assignment,
            bool preserveValue = true)
        {
            // Follows the chain through ANY assignment operator (`=`, `+=`, …), not
            // just `=`: `a = b += c` is `a = (b += c)`, so the `+=` link must also be
            // captured or its mutation of `b` is silently dropped (issue #1723). The
            // walk is parenthesis-transparent (`a = (b = c)`) since a link's RHS may
            // be a parenthesized nested assignment.
            var lefts = new List<(GExpression Target, string Op, ExpressionSyntax Syntax)>();
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

                lefts.Add((this.TranslateExpression(link.Left), link.OperatorToken.Text, link.Left));
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
                safeTargets[i] = this.MakeDuplicationSafeTarget(lefts[i].Target, statements, lefts[i].Syntax);
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
            // safe to re-embed above). This fallback is now reached only by a
            // chain containing a tuple-valued link, which has no native
            // assignment-expression form. Re-embedding a compound target
            // expression as-is would re-read its
            // getter once per outer link (issue #1875) — instead of doing
            // that, the read/combine/store is expanded manually (mirroring
            // exactly what the compound operator does) so the combined value
            // is captured directly, with no re-read at all.
            bool valueIsShared = false;
            for (int i = lefts.Count - 1; i >= 0; i--)
            {
                bool hasOuterLink = i > 0;
                bool targetNeedsCapturedValue =
                    this.AssignmentTargetNeedsCapturedValue(lefts[i].Syntax);
                bool captureRootSimpleValue =
                    preserveValue &&
                    i == 0 &&
                    assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) &&
                    targetNeedsCapturedValue;
                string compoundBinaryOp = lefts[i].Op == "="
                    ? null
                    : CompoundToBinaryOperator(lefts[i].Op);
                bool captureRootCompoundValue =
                    preserveValue &&
                    i == 0 &&
                    targetNeedsCapturedValue &&
                    compoundBinaryOp != null;
                GExpression assignedValue = value;
                if (lefts[i].Op == "=")
                {
                    ISymbol target = this.context.GetSymbolInfo(lefts[i].Syntax).Symbol;
                    ITypeSymbol targetType = target switch
                    {
                        ILocalSymbol local => local.Type,
                        IParameterSymbol parameter => parameter.Type,
                        IFieldSymbol field => field.Type,
                        IPropertySymbol property => property.Type,
                        _ => this.context.GetTypeInfo(lefts[i].Syntax).Type,
                    };
                    ISymbol promotionTarget = target;
                    if (target is ILocalSymbol inferredLocal
                        && inferredLocal.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
                            is VariableDeclaratorSyntax { Initializer.Value: { } initializer } declarator
                        && declarator.Ancestors().OfType<VariableDeclarationSyntax>()
                            .FirstOrDefault()?.Type.IsVar == true)
                    {
                        targetType = this.context.GetTypeInfo(initializer).Type;
                        promotionTarget = null;
                    }

                    assignedValue = this.ForgiveNullableReferenceValue(
                        current,
                        assignedValue,
                        targetType,
                        promotionTarget,
                        includePromotedValue: true);
                }

                if (captureRootSimpleValue)
                {
                    // C# yields the converted RHS, never a post-set target read.
                    // A typed temp preserves that value for properties, set-only
                    // storage, and targets whose receiver/index had to be spilled.
                    assignedValue = this.CaptureAssignmentValue(
                        assignment,
                        assignedValue,
                        statements);
                }
                else if (hasOuterLink && lefts[i].Op == "=" && !valueIsShared)
                {
                    // About to be assigned to more than one target — spill once
                    // so the RHS expression is evaluated exactly one time, then
                    // every remaining target reuses the same temp/trivial value.
                    assignedValue = this.SpillOperand(value, statements);
                    value = assignedValue;
                    valueIsShared = true;
                }

                if ((hasOuterLink || captureRootCompoundValue) &&
                    targetNeedsCapturedValue &&
                    compoundBinaryOp is string binaryOp)
                {
                    // A non-trivial compound target must yield its computed value
                    // without re-reading the getter: both an outer assignment chain
                    // (`a = c.P += d`, issue #1875) and a standalone value position
                    // (`Echo(c.P += d)`) reuse the captured combined value.
                    GExpression oldValue = this.SpillOperand(safeTargets[i], statements);
                    GExpression combinedValue =
                        new BinaryExpression(oldValue, binaryOp, assignedValue);
                    GExpression newValue = captureRootCompoundValue
                        ? this.CaptureAssignmentValue(
                            assignment,
                            combinedValue,
                            statements)
                        : this.SpillOperand(combinedValue, statements);
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

        private GExpression CaptureAssignmentValue(
            AssignmentExpressionSyntax assignment,
            GExpression value,
            List<GStatement> statements)
        {
            string temp = $"__spill{this.state.SpillCounter++}";
            statements.Add(new LocalDeclarationStatement(
                BindingKind.Let,
                temp,
                this.ResolveExpressionType(assignment),
                value));
            var captured = new IdentifierExpression(temp);
            this.state.AssignmentValues[assignment] = captured;
            return captured;
        }

        private bool AssignmentTargetNeedsCapturedValue(ExpressionSyntax target)
        {
            if (this.context.GetSymbolInfo(target).Symbol is IPropertySymbol)
            {
                return true;
            }

            return target is not IdentifierNameSyntax;
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
            // Issues #3353/#3358: G#'s native multi-target assignment now
            // accepts storage targets and a tuple-valued single RHS while
            // preserving C#'s targets-then-RHS-then-writes order.
            if (this.TryLowerNativeMultiAssignment(leftTuple, right, out IReadOnlyList<GStatement> native))
            {
                return native;
            }

            var statements = new List<GStatement>();
            Dictionary<ExpressionSyntax, GExpression> captured = this.CaptureDeconstructionStorageTargets(leftTuple, statements);
            this.LowerTuplePattern(leftTuple, this.TranslateExpression(right), forceRealTemps: false, statements, captured);
            return statements;
        }

        /// <summary>
        /// Issue #3358: renders a C# deconstruction assignment as G#'s native
        /// multi-target assignment (<c>a, b = b, a</c>, ADR-0015) when every part
        /// of the shape is expressible, replacing the
        /// <c>let (__decon0, __decon1) = …</c> plus per-target-write triple.
        /// </summary>
        /// <remarks>
        /// ADR-0015 evaluates every right-hand expression left-to-right into
        /// temporaries before any write, then assigns left-to-right — exactly the
        /// order C# specifies, so aliasing swaps and storage targets stay correct.
        /// <para>
        /// Mixed fresh/existing targets use ADR-0168 inline bindings. Nested
        /// target tuples keep the existing lowering. Non-tuple deconstruction
        /// sources also keep it because native multi-assignment unifies tuple
        /// values only.
        /// </para>
        /// </remarks>
        /// <param name="leftTuple">The C# deconstruction target tuple.</param>
        /// <param name="right">The right-hand side.</param>
        /// <param name="result">The emitted statements when the rewrite applies.</param>
        /// <returns><see langword="true"/> when the rewrite applied.</returns>
        private bool TryLowerNativeMultiAssignment(
            TupleExpressionSyntax leftTuple,
            ExpressionSyntax right,
            out IReadOnlyList<GStatement> result)
        {
            result = null;

            if (this.context.GetTypeInfo(right).Type is not INamedTypeSymbol { IsTupleType: true } rightType
                || rightType.TupleElements.Length != leftTuple.Arguments.Count)
            {
                return false;
            }

            // Nested target tuples/designations still need recursive lowering.
            // Flat fresh `var` declarations can use G#'s inline let/var targets.
            foreach (ArgumentSyntax argument in leftTuple.Arguments)
            {
                if (argument.Expression is TupleExpressionSyntax
                    || (argument.Expression is DeclarationExpressionSyntax declaration
                        && (!declaration.Type.IsVar
                            || declaration.Designation is ParenthesizedVariableDesignationSyntax)))
                {
                    return false;
                }
            }

            var targets = new List<GExpression>(leftTuple.Arguments.Count);
            var targetBindings = new List<BindingKind?>(leftTuple.Arguments.Count);
            foreach (ArgumentSyntax argument in leftTuple.Arguments)
            {
                if (argument.Expression is DeclarationExpressionSyntax declaration)
                {
                    if (declaration.Designation is not SingleVariableDesignationSyntax single)
                    {
                        targets.Add(new IdentifierExpression("_"));
                        targetBindings.Add(null);
                        continue;
                    }

                    string name = this.EmittedName(single, single.Identifier);
                    if (name == "_")
                    {
                        targets.Add(new IdentifierExpression(name));
                        targetBindings.Add(null);
                        continue;
                    }

                    this.ReportIfIndexOrRangeTypedDesignation(single);
                    ILocalSymbol local = this.context.GetDeclaredSymbol(single) as ILocalSymbol;
                    targets.Add(new IdentifierExpression(name));
                    targetBindings.Add(local != null && this.IsLocalReassigned(local)
                        ? BindingKind.Var
                        : BindingKind.Let);
                    continue;
                }

                targets.Add(this.TranslateExpression(argument.Expression));
                targetBindings.Add(null);
            }

            ExpressionSyntax unwrappedRight = right;
            while (unwrappedRight is ParenthesizedExpressionSyntax parenthesized)
            {
                unwrappedRight = parenthesized.Expression;
            }

            IReadOnlyList<GExpression> values = unwrappedRight is TupleExpressionSyntax rightTuple
                ? rightTuple.Arguments.Select(argument => this.TranslateExpression(argument.Expression)).ToList()
                : new[] { this.TranslateExpression(right) };
            result = new GStatement[] { new MultiAssignmentStatement(targets, values, targetBindings) };
            return true;
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
                        captured[targetExpr] = this.MakeDuplicationSafeTarget(
                            this.TranslateExpression(targetExpr),
                            statements,
                            targetExpr);
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
            // These temps are single-use compiler internals, never reassigned,
            // so use the immutable `let (...)` spelling even though ADR-0168
            // also permits mutable `var (...)`. This is exactly the mechanism the
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
                    values.Add(this.LowerDeconstructionDeclaration(
                        declaration.Designation,
                        tempRead,
                        forceRealTemps,
                        statements));
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

        private GExpression LowerDeconstructionDeclaration(
            VariableDesignationSyntax designation,
            GExpression value,
            bool preserveValue,
            List<GStatement> statements)
        {
            if (designation is DiscardDesignationSyntax)
            {
                return preserveValue ? value : null;
            }

            if (designation is SingleVariableDesignationSyntax single)
            {
                this.ReportIfIndexOrRangeTypedDesignation(single);
                string name = this.EmittedName(single, single.Identifier);
                ILocalSymbol local = this.context.GetDeclaredSymbol(single) as ILocalSymbol;
                statements.Add(new LocalDeclarationStatement(
                    local != null && this.IsLocalReassigned(local)
                        ? BindingKind.Var
                        : BindingKind.Let,
                    name,
                    type: null,
                    initializer: value));
                return new IdentifierExpression(name);
            }

            var parenthesized = (ParenthesizedVariableDesignationSyntax)designation;
            var temps = new List<string>(parenthesized.Variables.Count);
            foreach (VariableDesignationSyntax child in parenthesized.Variables)
            {
                temps.Add(child is DiscardDesignationSyntax && !preserveValue
                    ? "_"
                    : $"__decon{this.state.DeconCounter++}");
            }

            statements.Add(new TupleDeconstructionStatement(BindingKind.Let, temps, value));
            var values = new List<GExpression>(parenthesized.Variables.Count);
            for (int i = 0; i < parenthesized.Variables.Count; i++)
            {
                if (temps[i] == "_")
                {
                    values.Add(null);
                    continue;
                }

                values.Add(this.LowerDeconstructionDeclaration(
                    parenthesized.Variables[i],
                    new IdentifierExpression(temps[i]),
                    preserveValue,
                    statements));
            }

            return preserveValue ? new TupleLiteralExpression(values) : null;
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
                        SingleVariableDesignationSyntax single => this.EmittedName(single, single.Identifier),
                        _ => "_",
                    });

                    // Issue #1967: `var (i, r) = ...` declares each element via a
                    // designation, not a declarator.
                    if (designation is SingleVariableDesignationSyntax indexCheckSingle)
                    {
                        this.ReportIfIndexOrRangeTypedDesignation(indexCheckSingle);
                        if (this.context.GetDeclaredSymbol(indexCheckSingle) is ILocalSymbol local
                            && this.IsLocalReassigned(local))
                        {
                            binding = BindingKind.Var;
                        }
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
                        SingleVariableDesignationSyntax single => this.EmittedName(single, single.Identifier),
                        _ => "_",
                    });

                    // Issue #1967: `(var i, var r) = ...` — same as above, one
                    // designation per tuple element.
                    if (declaration.Designation is SingleVariableDesignationSyntax indexCheckSingle)
                    {
                        this.ReportIfIndexOrRangeTypedDesignation(indexCheckSingle);
                        if (this.context.GetDeclaredSymbol(indexCheckSingle) is ILocalSymbol local
                            && this.IsLocalReassigned(local))
                        {
                            binding = BindingKind.Var;
                        }
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
        // effect — a bare identifier, `this`, literal, or type-name receiver never
        // has a side effect and always denotes the same value/name, so it is safe
        // to embed at more than one output position without spilling it to a temp
        // first (issue #1731). Anything else (a method/property/indexer read, an
        // arithmetic expression, …) may run a side effect or re-read a mutable
        // value and must be evaluated exactly once if it needs to appear more than
        // once.
        private static bool IsTrivialOperand(GExpression expression) =>
            expression is IdentifierExpression or ThisExpression or LiteralExpression or TypeExpression;

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

        // As above, but retains a loud fallback for a future expression-only
        // site that fails to open either a statement seam or issue #3355's
        // native block-expression seam.
        private GExpression SpillOperand(GExpression operand, SyntaxNode operandSyntaxForDiagnostic)
        {
            if (IsTrivialOperand(operand))
            {
                return operand;
            }

            if (this.CanAssignShortCircuitSpill(operandSyntaxForDiagnostic))
            {
                return this.AssignShortCircuitSpill(operand, operandSyntaxForDiagnostic);
            }

            if (this.state.PendingSpillPrologue != null)
            {
                return this.SpillOperand(operand);
            }

            string message =
                "a non-trivial operand reached an expression-only translation site without opening " +
                "a native block-expression spill seam; emitting it would evaluate it more than once.";
            this.context.ReportUnsupported(operandSyntaxForDiagnostic, message);
            return operand;
        }

        private bool CanAssignShortCircuitSpill(SyntaxNode operandSyntax)
        {
            if (this.state.ShortCircuitSpillDeclarations == null
                || this.state.PendingSpillPrologue == null
                || this.state.ShortCircuitSpillScope == null)
            {
                return false;
            }

            for (SyntaxNode current = operandSyntax; current != null; current = current.Parent)
            {
                if (current == this.state.ShortCircuitSpillScope)
                {
                    return true;
                }

                if (current is AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax)
                {
                    return false;
                }
            }

            return false;
        }

        private GExpression AssignShortCircuitSpill(
            GExpression operand,
            SyntaxNode operandSyntax)
        {
            TypeInfo typeInfo = this.context.GetTypeInfo(operandSyntax);
            ITypeSymbol operandType = typeInfo.Type ?? typeInfo.ConvertedType;
            if (operandType == null || operandType.TypeKind == TypeKind.Error)
            {
                this.context.ReportUnsupported(
                    operandSyntax,
                    "a short-circuited fallback pattern scrutinee has no resolvable type for its deferred spill local (issue #3419).");
                return this.SpillOperand(operand);
            }

            GTypeReference spillType = this.typeMapper.Map(
                operandType,
                this.context,
                operandSyntax.GetLocation());
            if (operandType.IsReferenceType)
            {
                spillType = MakeNullable(spillType);
            }

            string temp = $"__spill{this.state.SpillCounter++}";
            var reference = new IdentifierExpression(temp);
            this.state.ShortCircuitSpillDeclarations.Add(
                new LocalDeclarationStatement(
                    BindingKind.Var,
                    temp,
                    spillType));
            this.state.PendingSpillPrologue.Add(
                new AssignmentStatement(reference, operand));
            return reference;
        }

        // Issue #3355: field/property initializers and constructor-initializer
        // arguments can host spill statements directly in a native block
        // expression. No result-type lookup or synthesized helper is needed.
        private GExpression TranslateNullSeamExpression(ExpressionSyntax expression)
        {
            return this.TranslateWithBlockSpillSeam(() => this.TranslateExpression(expression));
        }

        private List<GExpression> TranslateNullSeamArguments(
            SeparatedSyntaxList<ArgumentSyntax> arguments,
            bool preserveNames = true)
        {
            return arguments.Select(argument => this.TranslateNullSeamArgument(argument, preserveNames)).ToList();
        }

        private GExpression TranslateNullSeamArgument(ArgumentSyntax argument, bool preserveName)
        {
            GExpression value;
            if (argument.RefKindKeyword.Kind() is SyntaxKind.RefKeyword or SyntaxKind.OutKeyword
                && argument.Expression is not DeclarationExpressionSyntax
                && argument.Expression is not IdentifierNameSyntax { Identifier.ValueText: "_" })
            {
                // Keep address-of outermost so gsc's ref/out call binder sees
                // the expected argument shape: `&{ spills; lvalue }`.
                value = new UnaryExpression(
                    "&",
                    this.TranslateWithBlockSpillSeam(
                        () => this.TranslateExpression(argument.Expression)));
            }
            else
            {
                value = this.TranslateWithBlockSpillSeam(
                    () => this.TranslateArgumentValue(argument));
            }

            return argument.NameColon == null || !preserveName
                ? value
                : new NamedArgumentExpression(
                    this.EmittedName(
                        this.context.GetSymbolInfo(argument.NameColon.Name).Symbol,
                        argument.NameColon.Name.Identifier.ValueText),
                    value);
        }

        private GExpression TranslateWithBlockSpillSeam(Func<GExpression> translate)
        {
            if (this.state.PendingSpillPrologue != null)
            {
                return translate();
            }

            List<GStatement> outerSpillPrologue = this.state.PendingSpillPrologue;
            var spillPrologue = new List<GStatement>();
            this.state.PendingSpillPrologue = spillPrologue;
            try
            {
                GExpression value = translate();
                return spillPrologue.Count == 0
                    ? value
                    : new BlockExpression(spillPrologue, value);
            }
            finally
            {
                this.state.PendingSpillPrologue = outerSpillPrologue;
            }
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
        private GExpression MakeDuplicationSafeTarget(
            GExpression target,
            List<GStatement> prologue,
            ExpressionSyntax syntax = null)
        {
            switch (target)
            {
                case MemberAccessExpression member:
                    return new MemberAccessExpression(
                        this.MakeDuplicationSafeTarget(
                            member.Target,
                            prologue,
                            (syntax as MemberAccessExpressionSyntax)?.Expression),
                        member.MemberName);

                case IndexExpression index:
                    // `^n` is contextual index syntax: spilling the whole expression
                    // turns `target[^n]` into `let i = ^n; target[i]`, which loses
                    // from-end semantics. Spill only `n` and keep `^` at the access.
                    GExpression safeTarget = this.MakeDuplicationSafeTarget(
                        index.Target,
                        prologue,
                        (syntax as ElementAccessExpressionSyntax)?.Expression);
                    bool isFromEnd = syntax is ElementAccessExpressionSyntax elementAccess
                        && elementAccess.ArgumentList.Arguments.Count == 1
                        && elementAccess.ArgumentList.Arguments[0].Expression.IsKind(SyntaxKind.IndexExpression);
                    GExpression safeIndex = isFromEnd
                        && index.Index is UnaryExpression { Operator: "^" } fromEnd
                        ? new UnaryExpression("^", this.SpillOperand(fromEnd.Operand, prologue))
                        : this.SpillOperand(index.Index, prologue);
                    return new IndexExpression(
                        safeTarget,
                        safeIndex);

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

        private IReadOnlyList<GStatement> TranslateLocalFunction(LocalFunctionStatementSyntax localFunction)
        {
            if (this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol recursiveLocal
                && this.state.LiftedRecursiveLocalFunctions.TryGetValue(
                    recursiveLocal,
                    out LiftedRecursiveLocalFunction recursiveLift))
            {
                bool liftedIsAsync = localFunction.Modifiers.Any(SyntaxKind.AsyncKeyword);
                List<Parameter> liftedParameters = this.MapParameters(
                    recursiveLocal,
                    localFunction.ParameterList,
                    skipFirst: false);
                foreach (LiftedLocalFunctionCapture capture in recursiveLift.Captures)
                {
                    ITypeSymbol captureType = capture.Symbol switch
                    {
                        ILocalSymbol local => local.Type,
                        IParameterSymbol parameter => parameter.Type,
                        _ => null,
                    };
                    if (captureType == null)
                    {
                        continue;
                    }

                    if (captureType.IsReferenceType
                        && !CaptureHasExplicitNullableType(capture.Symbol))
                    {
                        captureType = captureType.WithNullableAnnotation(
                            NullableAnnotation.NotAnnotated);
                    }

                    liftedParameters.Add(new Parameter(
                        this.EmittedName(capture.Symbol, capture.Symbol.Name),
                        this.typeMapper.Map(
                            captureType,
                            this.context,
                            capture.Symbol.Locations.FirstOrDefault()),
                        refKind: capture.IsByRef ? "ref" : null));
                }

                GTypeReference liftedReturnType = this.MapDelegateLikeReturnType(
                    recursiveLocal,
                    liftedIsAsync,
                    localFunction.ReturnType.GetLocation());
                List<TypeParameter> liftedTypeParameters = this.MapMethodTypeParameters(recursiveLocal);
                BlockStatement liftedBody = this.TranslateBody(
                    localFunction,
                    $"recursive local function '{localFunction.Identifier.Text}'");
                var helper = new MethodDeclaration(
                    recursiveLift.Name,
                    liftedParameters,
                    liftedReturnType,
                    liftedBody,
                    liftedTypeParameters,
                    visibility: Visibility.Private,
                    isAsync: liftedIsAsync,
                    isRefReturn: recursiveLocal.ReturnsByRef);
                if (recursiveLift.IsStatic)
                {
                    (this.state.PendingStaticSynthHelpers
                        ?? throw new InvalidOperationException(
                            "A recursive static local-function lift must be emitted inside an aggregate."))
                        .Add(helper);
                }
                else
                {
                    (this.state.PendingInstanceSynthHelpers
                        ?? throw new InvalidOperationException(
                            "A recursive instance local-function lift must be emitted inside an aggregate."))
                        .Add(helper);
                }

                return new GStatement[]
                {
                    new RawStatement($"// lifted recursive local function {recursiveLift.Name}"),
                };
            }

            if (localFunction.Modifiers.Any(SyntaxKind.StaticKeyword)
                && this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol staticLocal
                && this.state.LiftedStaticLocalFunctions.TryGetValue(staticLocal, out string liftedName)
                && this.state.PendingStaticSynthHelpers != null)
            {
                bool liftedIsAsync = localFunction.Modifiers.Any(SyntaxKind.AsyncKeyword);
                List<Parameter> liftedParameters = this.MapParameters(
                    staticLocal,
                    localFunction.ParameterList,
                    skipFirst: false);
                GTypeReference liftedReturnType = this.MapDelegateLikeReturnType(
                    staticLocal,
                    liftedIsAsync,
                    localFunction.ReturnType.GetLocation());
                List<TypeParameter> liftedTypeParameters = this.MapMethodTypeParameters(staticLocal);
                BlockStatement liftedBody = this.TranslateBody(
                    localFunction,
                    $"static local function '{localFunction.Identifier.Text}'");
                this.state.PendingStaticSynthHelpers.Add(new MethodDeclaration(
                    liftedName,
                    liftedParameters,
                    liftedReturnType,
                    liftedBody,
                    liftedTypeParameters,
                    visibility: Visibility.Private,
                    isAsync: liftedIsAsync,
                    isRefReturn: staticLocal.ReturnsByRef));
                return new GStatement[]
                {
                    new RawStatement($"// lifted static local function {liftedName}"),
                };
            }

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
                return new GStatement[]
                {
                    new RawStatement($"// unsupported: ref-returning local function '{localFunction.Identifier.Text}'"),
                };
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
            SyntaxNode previousBodyScope = this.state.CurrentBodyScope;
            this.state.PendingSpillPrologue = null;
            this.state.CurrentBodyScope = localFunction;
            LambdaExpression lambda;
            try
            {
                if (localFunction.Body != null)
                {
                    BlockStatement innerBody = this.WithParameterShadows(localFunction, this.TranslateBlock(localFunction.Body));
                    innerBody = AddIteratorExitLabel(localFunction, innerBody);
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
                    BlockStatement innerBody = localSymbol?.ReturnsVoid == false
                        ? new BlockStatement(this.WithSpillSeam(
                            () => new List<GStatement>
                            {
                                new ReturnStatement(
                                    this.TranslateValueWithNullForgiveness(localFunction.ExpressionBody.Expression)),
                            }).ToList())
                        : new BlockStatement(this.WithSpillSeam(
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
                this.state.CurrentBodyScope = previousBodyScope;
            }

            // Issue #1886: a generic local function (`T First<T>(a, b) { ... }`)
            // carries its type parameters on the `let` binding, not the anonymous
            // function literal (which has no name to hang `[T]` off) — see
            // `let Name[T, U] = func (...) ... { ... }` in G#.
            var typeParameters = localFunction.TypeParameterList?.Parameters
                .Select(tp => this.EmittedName(tp, tp.Identifier))
                .ToList();

            // Issue #3399: this local participates in a recursive/mutually
            // recursive SCC of capturing local functions — a bare non-recursive
            // `let` binding of the literal cannot reference itself, so gsc loses
            // the binding for every call (GS0130/GS0125). Lower the whole SCC via
            // G#'s nullable-function-local scheme instead: emit the members'
            // nil-initialized `var Name (… -> R)? = nil` declarations exactly once
            // (the first member translated in document order; all declarations
            // must precede the first assignment because a G# closure body cannot
            // reference a not-yet-declared sibling local), then assign this
            // member's function literal to its own local. SCC partners are
            // reached from a closure body through the nullable local via `!!`
            // (see the TranslateIdentifierName/Invocations rewrite). G#'s
            // capture-by-reference closures preserve C#'s shared mutation of the
            // captured sibling locals.
            if (localSymbol is not null
                && this.state.RecursiveLocalFunctionGroups.TryGetValue(
                    localSymbol, out RecursiveLocalFunctionGroup recursiveBinding))
            {
                var statements = new List<GStatement>();
                if (!recursiveBinding.Members.Any(m => this.state.EmittedRecursiveGroupMembers.Contains(m)))
                {
                    recursiveBinding.DeclarationsEmitted = true;
                    foreach (IMethodSymbol member in recursiveBinding.Members)
                    {
                        this.state.EmittedRecursiveGroupMembers.Add(member);
                    }

                    statements.AddRange(recursiveBinding.Declarations);
                }

                statements.Add(new AssignmentStatement(
                    new IdentifierExpression(recursiveBinding.NameOf(localSymbol)),
                    lambda));
                return statements;
            }

            return new GStatement[]
            {
                new LocalFunctionStatement(
                    this.EmittedName(localSymbol, localFunction.Identifier.ValueText),
                    lambda,
                    typeParameters),
            };
        }

        private static bool CaptureHasExplicitNullableType(ISymbol symbol)
        {
            foreach (SyntaxReference reference in symbol.DeclaringSyntaxReferences)
            {
                SyntaxNode syntax = reference.GetSyntax();
                TypeSyntax type = syntax switch
                {
                    ParameterSyntax parameter => parameter.Type,
                    VariableDeclaratorSyntax { Parent: VariableDeclarationSyntax declaration } =>
                        declaration.Type,
                    _ => null,
                };

                if (type is NullableTypeSyntax)
                {
                    return true;
                }
            }

            return false;
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
