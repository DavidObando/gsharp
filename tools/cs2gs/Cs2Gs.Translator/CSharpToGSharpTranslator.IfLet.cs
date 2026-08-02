// <copyright file="CSharpToGSharpTranslator.IfLet.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Cs2Gs.Translator;

public sealed partial class CSharpToGSharpTranslator
{
    private sealed partial class DeclarationVisitor
    {
        /// <summary>
        /// ADR-0151: rewrites a C# conditional whose condition is a bare
        /// non-null declaration pattern — <c>receiver is { } name</c>,
        /// optionally <c>&amp;&amp;</c>-joined with further predicates — into
        /// the canonical G# value-position <c>if let</c>:
        /// <code>
        /// receiver is { } name &amp;&amp; predicate ? whenTrue : whenFalse
        ///     =&gt;  if let name = receiver &amp;&amp; predicate { whenTrue } else { whenFalse }
        /// </code>
        /// The general lowering has to spill <c>receiver</c> into a
        /// <c>let __spillN</c> (the pattern reads the scrutinee more than once,
        /// issue #1731) and re-assert non-nullness at every binder reference,
        /// which both litters the output and forces an expression-bodied member
        /// to become a block-bodied accessor. The <c>if let</c> form evaluates
        /// the receiver exactly once by construction and binds the name at its
        /// non-null type, so neither is needed.
        /// </summary>
        /// <param name="conditional">The C# conditional expression.</param>
        /// <param name="result">The translated <c>if let</c> expression when the rewrite applies.</param>
        /// <returns><see langword="true"/> when the rewrite applied; otherwise <see langword="false"/> and nothing was translated.</returns>
        private bool TryTranslateIfLetConditional(
            ConditionalExpressionSyntax conditional,
            out GExpression result)
        {
            result = null;

            // Eligibility is decided ENTIRELY before anything is translated:
            // a mid-way bail-out would leave a half-emitted spill prologue and
            // duplicated diagnostics behind.
            DecomposeConjunction(conditional.Condition, out ExpressionSyntax leftmost, out List<ExpressionSyntax> guards);

            if (leftmost is not IsPatternExpressionSyntax isPattern
                || !IsBareNonNullDeclarationPattern(isPattern.Pattern, out SingleVariableDesignationSyntax designation))
            {
                return false;
            }

            if (this.context.GetDeclaredSymbol(designation) is not { } binder)
            {
                return false;
            }

            // G# `let` is immutable: a C# binder that is written to anywhere in
            // scope cannot become one.
            if (this.IsSymbolReassigned(binder, this.state.CurrentBodyScope ?? conditional))
            {
                return false;
            }

            // gsc rejects a non-nullable `if let` initializer with GS0296, so
            // only a receiver that lands in G# as `T?` is representable.
            if (!this.IsNullableIfLetReceiver(isPattern.Expression))
            {
                return false;
            }

            // A guard/true-arm construct that hoists a spill `let` keeps the
            // conservative fallback: the true arm can depend on the if-let
            // binding, and existing spill rewrites are not binding-aware. A
            // false-arm assignment owned by THIS conditional likewise falls
            // back so the general if-expression lowering can host its write
            // inside that arm. Assignments owned by a nested conditional arm
            // are left to the nested conditional's own seam.
            if (guards.Any(ContainsSpillHoistingConstruct)
                || ContainsSpillHoistingConstruct(conditional.WhenTrue)
                || ContainsAssignmentNeedingBranchSeam(conditional.WhenFalse))
            {
                return false;
            }

            // Issue #1967 parity with TranslateIsPattern: an Index/Range-typed
            // designation has no canonical G# type, and this rewrite bypasses
            // that entry point — report the gap here so the diagnostic surfaces
            // exactly once on both paths.
            this.ReportIndexOrRangeDesignationsInPattern(isPattern.Pattern);

            GExpression receiver = this.TranslateExpression(isPattern.Expression);
            string name = SanitizeIdentifier(designation.Identifier.Text);

            // While the guard and the true arm are translated, every reference
            // to the C# pattern local reads as the bare G# binding — no `!!`,
            // no `as` narrowing cast, no spill temp.
            bool hadPrevious = this.state.PatternBindings.TryGetValue(binder, out GExpression previous);
            this.state.PatternBindings[binder] = new IdentifierExpression(name);

            GExpression guard = null;
            GExpression whenTrue;
            try
            {
                foreach (ExpressionSyntax conjunct in guards)
                {
                    GExpression translated = this.TranslateExpression(conjunct);
                    guard = guard == null ? translated : new BinaryExpression(guard, "&&", translated);
                }

                whenTrue = this.TranslateValueWithNullForgiveness(conditional.WhenTrue);
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

            // The else arm is translated with the binding OUT of scope, matching
            // both C# definite-assignment and G#'s then-only binding scope.
            GExpression whenFalse = this.TranslateValueWithNullForgiveness(conditional.WhenFalse);

            (whenTrue, whenFalse) = this.CoerceConditionalArms(conditional, whenTrue, whenFalse);

            result = new IfLetExpression(
                new List<IfLetBinding> { new IfLetBinding(name, receiver) },
                guard,
                whenTrue,
                whenFalse);
            return true;
        }

        private static bool ContainsAssignmentNeedingBranchSeam(ExpressionSyntax branch)
        {
            return branch.DescendantNodesAndSelf(
                    descendIntoChildren: node =>
                        node is not (AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax))
                .OfType<AssignmentExpressionSyntax>()
                .Where(assignment =>
                    assignment.Parent is not InitializerExpressionSyntax initializer ||
                    (!initializer.IsKind(SyntaxKind.ObjectInitializerExpression) &&
                     !initializer.IsKind(SyntaxKind.WithInitializerExpression)))
                .Any(assignment => !IsInsideConditionalExpressionBranch(assignment, branch));
        }

        /// <summary>
        /// Splits a left-associative <c>&amp;&amp;</c> chain into its leftmost
        /// leaf and the remaining conjuncts in source order. A condition that is
        /// not a conjunction yields itself and an empty list.
        /// </summary>
        private static void DecomposeConjunction(
            ExpressionSyntax condition,
            out ExpressionSyntax leftmost,
            out List<ExpressionSyntax> conjuncts)
        {
            conjuncts = new List<ExpressionSyntax>();
            ExpressionSyntax current = Unparenthesize(condition);
            while (current is BinaryExpressionSyntax binary && binary.IsKind(SyntaxKind.LogicalAndExpression))
            {
                conjuncts.Insert(0, binary.Right);
                current = Unparenthesize(binary.Left);
            }

            leftmost = current;
        }

        private static ExpressionSyntax Unparenthesize(ExpressionSyntax expression)
        {
            while (expression is ParenthesizedExpressionSyntax parenthesized)
            {
                expression = parenthesized.Expression;
            }

            return expression;
        }

        /// <summary>
        /// True for exactly <c>x is { } name</c>: an empty property-pattern
        /// clause, no type prefix, no positional clause, and a single variable
        /// designation. Any other pattern shape changes the TEST (a type test,
        /// member tests, a positional deconstruction), which an
        /// <c>if let</c> binding cannot express.
        /// </summary>
        private static bool IsBareNonNullDeclarationPattern(
            PatternSyntax pattern,
            out SingleVariableDesignationSyntax designation)
        {
            designation = null;
            if (pattern is not RecursivePatternSyntax recursive
                || recursive.Type != null
                || recursive.PositionalPatternClause != null
                || recursive.PropertyPatternClause == null
                || recursive.PropertyPatternClause.Subpatterns.Count > 0
                || recursive.Designation is not SingleVariableDesignationSyntax single)
            {
                return false;
            }

            designation = single;
            return true;
        }

        /// <summary>
        /// True when the pattern scrutinee lands in G# as a nullable type, so
        /// the synthesized <c>if let</c> initializer has a nullable layer to
        /// strip (gsc GS0296 otherwise). Covers both an annotated / taint-
        /// promoted reference type and a <c>Nullable&lt;T&gt;</c> value type.
        /// </summary>
        private bool IsNullableIfLetReceiver(ExpressionSyntax receiver)
        {
            ITypeSymbol type = this.context.GetTypeInfo(receiver).Type;
            if (type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T })
            {
                return true;
            }

            return type is { IsReferenceType: true } && this.IsNullablePromotedValue(receiver);
        }

        /// <summary>
        /// True when translating <paramref name="node"/> can hoist a spill
        /// <c>let</c> into the active statement seam (issue #1731 machinery) or
        /// hoist a write/mutation out of the expression. Such a hoist must not
        /// escape an <c>if let</c> guard or then-branch, so the rewrite bails
        /// out and the spill-based <see cref="IfExpression"/> fallback is used
        /// instead. Anonymous-function bodies are skipped: they open their own
        /// seam and can never leak into this one.
        /// </summary>
        private static bool ContainsSpillHoistingConstruct(SyntaxNode node)
        {
            foreach (SyntaxNode descendant in node.DescendantNodesAndSelf(
                descendIntoChildren: n => n is not AnonymousFunctionExpressionSyntax || n == node))
            {
                switch (descendant)
                {
                    // A nested pattern spills its scrutinee; `out var` and
                    // ranges spill their operands; a value-position assignment,
                    // `++`/`--`, or `switch` arm is hoisted into a preceding
                    // statement by the enclosing seam.
                    case IsPatternExpressionSyntax:
                    case AssignmentExpressionSyntax:
                    case DeclarationExpressionSyntax:
                    case RangeExpressionSyntax:
                    case SwitchExpressionSyntax:
                        return true;

                    case PrefixUnaryExpressionSyntax prefix
                        when prefix.IsKind(SyntaxKind.PreIncrementExpression)
                            || prefix.IsKind(SyntaxKind.PreDecrementExpression):
                        return true;

                    case PostfixUnaryExpressionSyntax postfix
                        when postfix.IsKind(SyntaxKind.PostIncrementExpression)
                            || postfix.IsKind(SyntaxKind.PostDecrementExpression):
                        return true;

                    // `recv?.Invoke(a)` spills the receiver so it is evaluated
                    // exactly once (TryTranslateNullConditionalDelegateInvoke).
                    case InvocationExpressionSyntax { Expression: MemberBindingExpressionSyntax binding }
                        when binding.Name.Identifier.Text == "Invoke":
                        return true;
                }
            }

            return false;
        }
    }
}
