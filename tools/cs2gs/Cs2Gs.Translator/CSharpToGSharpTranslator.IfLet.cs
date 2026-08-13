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

            if (leftmost is not IsPatternExpressionSyntax isPattern)
            {
                return false;
            }

            SingleVariableDesignationSyntax designation;
            RecursivePatternSyntax residualPattern;
            GTypeReference asTarget = null;
            if (!TryExtractSingleTopLevelIfLetPattern(
                isPattern.Pattern,
                out TypeSyntax typeSyntax,
                out designation,
                out residualPattern))
            {
                return false;
            }

            bool bareNonNullPattern = typeSyntax == null;
            if (!bareNonNullPattern && IsTrivialPatternReceiver(isPattern.Expression))
            {
                return false;
            }

            if (!bareNonNullPattern)
            {
                ITypeSymbol targetSymbol = this.context.GetTypeInfo(typeSyntax).Type;
                if (targetSymbol == null ||
                    targetSymbol.TypeKind == TypeKind.Error ||
                    targetSymbol.IsRefLikeType ||
                    CSharpTypeMapper.IsSystemIndexOrRange(targetSymbol))
                {
                    return false;
                }

                asTarget = this.MapTypeSyntax(typeSyntax);
                if (targetSymbol.IsValueType)
                {
                    asTarget = MakeNullable(asTarget);
                }
                else if (!targetSymbol.IsReferenceType)
                {
                    return false;
                }
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

            bool directBinding =
                bareNonNullPattern && !this.IsNullableIfLetReceiver(isPattern.Expression);

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
            GExpression initializer = asTarget == null
                ? receiver
                : new BinaryExpression(receiver, "as", new TypeExpression(asTarget));
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
                if (residualPattern != null)
                {
                    guard = this.TranslateIfLetResidualPattern(residualPattern, name);
                }
                else if (directBinding)
                {
                    guard = new BinaryExpression(
                        new IdentifierExpression(name),
                        "!=",
                        LiteralExpression.Null());
                }

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

            result = directBinding
                ? new BlockExpression(
                    new GStatement[]
                    {
                        new LocalDeclarationStatement(
                            BindingKind.Let,
                            name,
                            initializer: initializer),
                    },
                    new IfExpression(
                        guard ?? LiteralExpression.Bool(true),
                        whenTrue,
                        whenFalse))
                : new IfLetExpression(
                    new List<IfLetBinding> { new IfLetBinding(name, initializer) },
                    guard,
                    whenTrue,
                    whenFalse);
            return true;
        }

        /// <summary>
        /// Issue #3359: rewrites the STATEMENT form
        /// <c>if (receiver is { } name [&amp;&amp; predicate]) { … } [else { … }]</c>
        /// into the canonical G# <c>if let</c> statement (ADR-0071):
        /// <code>
        /// if let name = receiver [&amp;&amp; predicate] { … } [else { … }]
        /// </code>
        /// The statement-position counterpart of ADR-0151's
        /// <see cref="TryTranslateIfLetConditional"/>, sharing its eligibility
        /// rules. Without it the general lowering spills <c>receiver</c> into a
        /// <c>let __spillN</c> (the pattern reads the scrutinee more than once,
        /// issue #1731), which destroys the author's chosen binder name, forces a
        /// <c>!!</c> at every read, and wraps the statement in an extra brace
        /// level to scope the temp. Measured at ~44 occurrences per 100k lines in
        /// dotnet/roslyn and ~186 per 100k in this repository (issue #3347).
        /// </summary>
        /// <param name="ifStatement">The C# <c>if</c> statement.</param>
        /// <param name="result">The translated statements when the rewrite applies.</param>
        /// <returns><see langword="true"/> when the rewrite applied.</returns>
        private bool TryBuildIfLetGuard(
            IfStatementSyntax ifStatement,
            out IReadOnlyList<GStatement> result)
        {
            result = null;

            // Eligibility is decided BEFORE anything is translated: a mid-way
            // bail-out would leave a half-emitted spill prologue behind.
            DecomposeConjunction(ifStatement.Condition, out ExpressionSyntax leftmost, out List<ExpressionSyntax> guards);

            if (leftmost is not IsPatternExpressionSyntax isPattern)
            {
                return false;
            }

            SingleVariableDesignationSyntax designation;
            RecursivePatternSyntax residualPattern;
            GTypeReference asTarget = null;
            if (!TryExtractSingleTopLevelIfLetPattern(
                isPattern.Pattern,
                out TypeSyntax typeSyntax,
                out designation,
                out residualPattern))
            {
                return false;
            }

            bool bareNonNullPattern = typeSyntax == null;
            if (!bareNonNullPattern)
            {
                ITypeSymbol targetSymbol = this.context.GetTypeInfo(typeSyntax).Type;
                if (targetSymbol == null ||
                    targetSymbol.TypeKind == TypeKind.Error ||
                    targetSymbol.IsRefLikeType ||
                    CSharpTypeMapper.IsSystemIndexOrRange(targetSymbol))
                {
                    return false;
                }

                if (IsTrivialPatternReceiver(isPattern.Expression)
                    || (residualPattern == null && !targetSymbol.IsValueType))
                {
                    return false;
                }

                asTarget = this.MapTypeSyntax(typeSyntax);
                if (targetSymbol.IsValueType)
                {
                    asTarget = MakeNullable(asTarget);
                }
                else if (!targetSymbol.IsReferenceType)
                {
                    return false;
                }
            }

            if (this.context.GetDeclaredSymbol(designation) is not ILocalSymbol binder)
            {
                return false;
            }

            // ADR-0071 requires a NULLABLE initializer — the binding exists to
            // strip the nullability. C# allows `s is { } text` on a non-nullable
            // reference too (it is still a runtime null test), but there the
            // translated receiver is `string`, not `string?`, and `if let` is
            // rejected with GS0296. Bind the author's name in a scoped block
            // instead.
            GTypeReference receiverType = this.ResolveExpressionType(isPattern.Expression);
            bool directBinding =
                bareNonNullPattern && receiverType is not { IsNullable: true };

            if (!directBinding && this.IsLocalReassigned(binder))
            {
                return false;
            }

            // A guard that itself hoists a spill would need a statement seam
            // ahead of the `if`, but the spill may read the binding — which is
            // only in scope inside the `if let`. Leave those to the general path.
            if (guards.Any(ContainsSpillHoistingConstruct))
            {
                return false;
            }

            // `if let` binds only for the then-branch, matching C#'s definite
            // assignment. A binder READ in the else-branch (legal in C# when the
            // then-branch exits) has no `if let` spelling; the negated-guard
            // hoist handles that shape instead.
            if (ifStatement.Else != null && ReadsSymbol(ifStatement.Else, binder))
            {
                return false;
            }

            // Issue #1967 parity with TranslateIsPattern: an Index/Range-typed
            // designation has no canonical G# type. Report here so the gap
            // surfaces exactly once on this path too.
            this.ReportIndexOrRangeDesignationsInPattern(isPattern.Pattern);

            GExpression receiver = this.TranslateExpression(isPattern.Expression);
            GExpression initializer = asTarget == null
                ? receiver
                : new BinaryExpression(receiver, "as", new TypeExpression(asTarget));
            string name = SanitizeIdentifier(designation.Identifier.Text);

            // Inside the guard and the then-branch every reference to the C#
            // pattern local reads as the bare G# binding — no `!!`, no `as`
            // narrowing cast, no spill temp.
            bool hadPrevious = this.state.PatternBindings.TryGetValue(binder, out GExpression previous);
            this.state.PatternBindings[binder] = new IdentifierExpression(name);

            GExpression guard = null;
            BlockStatement then;
            try
            {
                if (residualPattern != null)
                {
                    guard = this.TranslateIfLetResidualPattern(residualPattern, name);
                }
                else if (directBinding)
                {
                    guard = new BinaryExpression(
                        new IdentifierExpression(name),
                        "!=",
                        LiteralExpression.Null());
                }

                foreach (ExpressionSyntax conjunct in guards)
                {
                    GExpression translated = this.TranslateExpression(conjunct);
                    guard = guard == null ? translated : new BinaryExpression(guard, "&&", translated);
                }

                then = this.TranslateStatementAsBlock(ifStatement.Statement);
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

            // The else branch is translated with the binding OUT of scope.
            GStatement elseBranch = null;
            if (ifStatement.Else != null)
            {
                elseBranch = ifStatement.Else.Statement is IfStatementSyntax elseIf
                    ? this.TranslateIf(elseIf)
                    : this.TranslateStatementAsBlock(ifStatement.Else.Statement);
            }

            if (directBinding)
            {
                result = new GStatement[]
                {
                    new BlockStatement(
                        new GStatement[]
                        {
                            new LocalDeclarationStatement(
                                this.IsLocalReassigned(binder)
                                    ? BindingKind.Var
                                    : BindingKind.Let,
                                name,
                                initializer: initializer),
                            new IfStatement(
                                guard ?? LiteralExpression.Bool(true),
                                then,
                                elseBranch),
                        }),
                };
                return true;
            }

            // Statement-form `if let` has no guard clause. Nest the residual
            // test/extra conjuncts inside its binding scope. Reuse the same else
            // branch both when binding fails and when the nested guard fails.
            if (guard != null)
            {
                then = new BlockStatement(
                    new GStatement[] { new IfStatement(guard, then, elseBranch) });
            }

            result = new GStatement[]
            {
                new IfLetStatement(
                    new List<IfLetBinding> { new IfLetBinding(name, initializer) },
                    then,
                    elseBranch),
            };
            return true;
        }

        /// <summary>
        /// Issue #3352: emits C#'s body-scoped positive loop-pattern binding as
        /// native G# <c>while let</c> when the condition is exactly a non-null
        /// binding or type-test binding, optionally followed by spill-free
        /// <c>&amp;&amp;</c> guards:
        /// <code>
        /// while (Next() is string text &amp;&amp; text.Length &gt; 0) { body }
        /// // becomes
        /// while let text = Next() as string {
        ///     if !(text.Length &gt; 0) { break }
        ///     body
        /// }
        /// </code>
        /// The native loop owns re-evaluation and continue/break routing, so the
        /// old <c>let __scrutineeN</c> body prologue is unnecessary.
        /// </summary>
        private bool TryBuildWhileLetLoop(
            ExpressionSyntax condition,
            StatementSyntax bodyStatement,
            out IReadOnlyList<GStatement> result)
        {
            result = null;

            DecomposeConjunction(condition, out ExpressionSyntax leftmost, out List<ExpressionSyntax> guards);
            if (leftmost is not IsPatternExpressionSyntax isPattern)
            {
                return false;
            }

            SingleVariableDesignationSyntax designation;
            RecursivePatternSyntax residualPattern;
            GTypeReference asTarget = null;
            if (!TryExtractSingleTopLevelIfLetPattern(
                    isPattern.Pattern,
                    out TypeSyntax typeSyntax,
                    out designation,
                    out residualPattern))
            {
                return false;
            }

            if (residualPattern != null && IsTrivialPatternReceiver(isPattern.Expression))
            {
                return false;
            }

            if (typeSyntax == null)
            {
                // A direct `while let name = receiver` needs an existing
                // nullable layer to strip. Non-nullable receivers keep the
                // general pattern lowering.
                if (!this.IsNullableIfLetReceiver(isPattern.Expression))
                {
                    return false;
                }
            }
            else
            {
                ITypeSymbol targetSymbol = this.context.GetTypeInfo(typeSyntax).Type;
                if (targetSymbol == null ||
                    targetSymbol.TypeKind == TypeKind.Error ||
                    targetSymbol.IsRefLikeType ||
                    CSharpTypeMapper.IsSystemIndexOrRange(targetSymbol))
                {
                    return false;
                }

                asTarget = this.MapTypeSyntax(typeSyntax);
                if (targetSymbol.IsValueType)
                {
                    // `as` requires a nullable value-type target; `while let`
                    // then strips that nullable layer back to the C# binder's T.
                    asTarget = MakeNullable(asTarget);
                }
                else if (!targetSymbol.IsReferenceType)
                {
                    // An unconstrained type parameter cannot be the target of
                    // G#'s testing conversion.
                    return false;
                }
            }

            if (this.context.GetDeclaredSymbol(designation) is not ILocalSymbol binder ||
                this.IsLocalReassigned(binder) ||
                guards.Any(ContainsSpillHoistingConstruct) ||
                ContainsSpillHoistingConstruct(isPattern.Expression))
            {
                return false;
            }

            this.ReportIndexOrRangeDesignationsInPattern(isPattern.Pattern);

            GExpression receiver = this.TranslateExpression(isPattern.Expression);
            GExpression initializer = asTarget == null
                ? receiver
                : new BinaryExpression(receiver, "as", new TypeExpression(asTarget));
            string name = SanitizeIdentifier(designation.Identifier.Text);

            bool hadPrevious = this.state.PatternBindings.TryGetValue(binder, out GExpression previous);
            this.state.PatternBindings[binder] = new IdentifierExpression(name);

            BlockStatement body;
            try
            {
                GExpression guard = residualPattern == null
                    ? null
                    : this.TranslateIfLetResidualPattern(residualPattern, name);
                foreach (ExpressionSyntax conjunct in guards)
                {
                    GExpression translated = this.TranslateExpression(conjunct);
                    guard = guard == null
                        ? translated
                        : new BinaryExpression(guard, "&&", translated);
                }

                body = this.TranslateStatementAsBlock(bodyStatement);
                if (guard != null)
                {
                    var statements = new List<GStatement>
                    {
                        BreakIf(Negate(guard)),
                    };
                    statements.AddRange(body.Statements);
                    body = new BlockStatement(statements);
                }
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

            result = new GStatement[]
            {
                new WhileLetStatement(
                    new List<IfLetBinding> { new IfLetBinding(name, initializer) },
                    body),
            };
            return true;
        }

        private bool TryTranslateIfLetBooleanExpression(
            ExpressionSyntax expression,
            out GExpression result)
        {
            result = null;
            DecomposeConjunction(
                expression,
                out ExpressionSyntax leftmost,
                out List<ExpressionSyntax> guards);
            if (leftmost is not IsPatternExpressionSyntax isPattern
                || !TryExtractSingleTopLevelIfLetPattern(
                    isPattern.Pattern,
                    out TypeSyntax typeSyntax,
                    out SingleVariableDesignationSyntax designation,
                    out RecursivePatternSyntax residualPattern)
                || this.context.GetDeclaredSymbol(designation) is not ILocalSymbol binder
                || this.IsLocalReassigned(binder)
                || IsTrivialPatternReceiver(isPattern.Expression)
                || guards.Any(ContainsSpillHoistingConstruct))
            {
                return false;
            }

            GTypeReference asTarget = null;
            bool directBinding = false;
            if (typeSyntax == null)
            {
                if (!this.IsNullableIfLetReceiver(isPattern.Expression))
                {
                    directBinding = true;
                }
            }
            else
            {
                ITypeSymbol targetSymbol = this.context.GetTypeInfo(typeSyntax).Type;
                if (targetSymbol == null ||
                    targetSymbol.TypeKind == TypeKind.Error ||
                    targetSymbol.IsRefLikeType ||
                    CSharpTypeMapper.IsSystemIndexOrRange(targetSymbol))
                {
                    return false;
                }

                asTarget = this.MapTypeSyntax(typeSyntax);
                if (targetSymbol.IsValueType)
                {
                    asTarget = MakeNullable(asTarget);
                }
                else if (!targetSymbol.IsReferenceType)
                {
                    return false;
                }
            }

            this.ReportIndexOrRangeDesignationsInPattern(isPattern.Pattern);

            GExpression receiver = this.TranslateExpression(isPattern.Expression);
            GExpression initializer = asTarget == null
                ? receiver
                : new BinaryExpression(receiver, "as", new TypeExpression(asTarget));
            string name = SanitizeIdentifier(designation.Identifier.Text);

            bool hadPrevious = this.state.PatternBindings.TryGetValue(
                binder,
                out GExpression previous);
            this.state.PatternBindings[binder] = new IdentifierExpression(name);
            GExpression guard = null;
            try
            {
                if (residualPattern != null)
                {
                    guard = this.TranslateIfLetResidualPattern(residualPattern, name);
                }
                else if (directBinding)
                {
                    guard = new BinaryExpression(
                        new IdentifierExpression(name),
                        "!=",
                        LiteralExpression.Null());
                }

                foreach (ExpressionSyntax conjunct in guards)
                {
                    GExpression translated = this.TranslateExpression(conjunct);
                    guard = guard == null
                        ? translated
                        : new BinaryExpression(guard, "&&", translated);
                }
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

            result = directBinding
                ? new BlockExpression(
                    new GStatement[]
                    {
                        new LocalDeclarationStatement(
                            BindingKind.Let,
                            name,
                            initializer: initializer),
                    },
                    guard ?? LiteralExpression.Bool(true))
                : new IfLetExpression(
                    new List<IfLetBinding> { new IfLetBinding(name, initializer) },
                    guard,
                    LiteralExpression.Bool(true),
                    LiteralExpression.Bool(false));
            return true;
        }

        // True when `node` reads `symbol` anywhere. Used to keep an `if let` from
        // swallowing a shape whose ELSE branch reads the pattern binder — legal in
        // C# when the then-branch exits, but out of scope for a G# `if let`.
        private bool ReadsSymbol(SyntaxNode node, ILocalSymbol symbol)
        {
            foreach (IdentifierNameSyntax identifier in node.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>())
            {
                if (SymbolEqualityComparer.Default.Equals(
                        this.context.GetSymbolInfo(identifier).Symbol, symbol))
                {
                    return true;
                }
            }

            return false;
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
                .Any(assignment =>
                    AssignmentRequiresStatementLowering(assignment)
                    && !IsInsideConditionalExpressionBranch(assignment, branch));
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

        private static bool IsTrivialPatternReceiver(ExpressionSyntax expression) =>
            Unparenthesize(expression) is
                IdentifierNameSyntax or ThisExpressionSyntax or LiteralExpressionSyntax;

        private static bool TryExtractSingleTopLevelIfLetPattern(
            PatternSyntax pattern,
            out TypeSyntax typeSyntax,
            out SingleVariableDesignationSyntax designation,
            out RecursivePatternSyntax residualPattern)
        {
            typeSyntax = null;
            designation = null;
            residualPattern = null;

            if (pattern.DescendantNodesAndSelf()
                    .OfType<SingleVariableDesignationSyntax>()
                    .Count() != 1)
            {
                return false;
            }

            switch (pattern)
            {
                case DeclarationPatternSyntax declaration
                    when declaration.Designation is SingleVariableDesignationSyntax single:
                    typeSyntax = declaration.Type;
                    designation = single;
                    return true;

                case RecursivePatternSyntax recursive
                    when recursive.Designation is SingleVariableDesignationSyntax single:
                    typeSyntax = recursive.Type;
                    designation = single;
                    if (recursive.PositionalPatternClause != null
                        || recursive.PropertyPatternClause is { Subpatterns.Count: > 0 })
                    {
                        residualPattern = recursive;
                    }

                    return true;

                default:
                    return false;
            }
        }

        private GExpression TranslateIfLetResidualPattern(
            RecursivePatternSyntax pattern,
            string bindingName)
        {
            var bindings = new List<(ISymbol Symbol, GExpression Replacement)>();
            var guards = new List<GExpression>();
            GPattern translated = this.TranslateRecursivePattern(
                pattern,
                new IdentifierExpression(bindingName),
                bindings,
                new HashSet<string>(System.StringComparer.Ordinal),
                guards,
                treatAsUntyped: true);
            return new PatternTestExpression(
                new IdentifierExpression(bindingName),
                translated);
        }

        /// <summary>
        /// True when the pattern scrutinee lands in G# as a nullable type, so
        /// a synthesized <c>if let</c> or <c>while let</c> initializer has a
        /// nullable layer to strip (gsc GS0296 otherwise). Covers both an
        /// annotated / taint-promoted reference type and a
        /// <c>Nullable&lt;T&gt;</c> value type.
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
        /// escape an <c>if let</c> / <c>while let</c> binding scope, so those
        /// rewrites bail out and keep their spill-based fallback instead.
        /// Anonymous-function bodies are skipped: they open their own seam and
        /// can never leak into this one.
        /// </summary>
        private static bool ContainsSpillHoistingConstruct(SyntaxNode node)
        {
            foreach (SyntaxNode descendant in node.DescendantNodesAndSelf(
                descendIntoChildren: n => n is not AnonymousFunctionExpressionSyntax || n == node))
            {
                switch (descendant)
                {
                    // Binding patterns, `out var`, deconstruction assignments,
                    // `++`/`--`, and switch arms can still open a seam.
                    case IsPatternExpressionSyntax isPattern
                        when PatternIntroducesBinding(isPattern.Pattern):
                    case AssignmentExpressionSyntax assignment
                        when AssignmentRequiresStatementLowering(assignment):
                    case DeclarationExpressionSyntax:
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
                }
            }

            return false;
        }
    }
}
