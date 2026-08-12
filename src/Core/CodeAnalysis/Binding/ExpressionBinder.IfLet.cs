// <copyright file="ExpressionBinder.IfLet.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1516 // Elements should be separated by blank line

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <content>
/// ADR-0151: the value-producing <c>if let</c> EXPRESSION. It combines the
/// ADR-0071 nullable-binding header (shared with the statement form through
/// <see cref="IfLetBindingSupport"/>) with the ADR-0064 if-expression branch
/// typing rules, and lowers entirely into the existing
/// <see cref="BoundBlockExpression"/> / <see cref="BoundConditionalExpression"/>
/// pair — no new bound-node kind, no emitter or interpreter special case.
/// </content>
internal sealed partial class ExpressionBinder
{
    /// <summary>
    /// ADR-0151: binds
    /// <c>if let a = e [, let b = e2]* [&amp;&amp; guard] { value } else { value }</c>.
    /// </summary>
    /// <remarks>
    /// <para>The lowered shape for <c>if let a = e0, let b = e1 &amp;&amp; g { T } else { F }</c> is shown below.</para>
    /// <code>
    /// ({ let a = e0 } → a != nil ? ({ let b = e1 } → b != nil ? g : false) : false)
    ///     ? T
    ///     : F
    /// </code>
    /// <para>
    /// Each initializer therefore sits inside the arm that is only reached once
    /// every earlier binding matched, which is what gives ADR-0151's
    /// left-to-right short-circuit both under the interpreter (a
    /// <see cref="BoundConditionalExpression"/> evaluates only the selected arm)
    /// and under IL emit (it branches). A <c>&amp;&amp;</c> chain could NOT be
    /// used for the same purpose: <c>Evaluator.EvaluateBinaryExpression</c>
    /// evaluates both operands of a logical operator before combining them.
    /// </para>
    /// <para>
    /// The then/else branches each appear exactly ONCE in the produced tree.
    /// Reusing a single bound-node instance in two positions would alias the
    /// emitter's identity-keyed slot dictionaries (see
    /// <c>SlotDictionaryAliasingAssertionTests</c>), so the nesting is put in
    /// the CONDITION rather than duplicating the arms per binding.
    /// </para>
    /// </remarks>
    private BoundExpression BindIfLetExpression(
        IfLetExpressionSyntax syntax,
        TypeSymbol? targetType,
        bool canBeVoid = false)
    {
        // Issue #1238 parity with BindIfExpression: a bare branchy argument
        // awaiting its parameter target type defers a no-common-type failure
        // instead of reporting it. Consume the flag immediately so nested
        // sub-expressions bind normally.
        var deferOnFailure = targetType == null && binderCtx.DeferTargetlessConditional;
        binderCtx.DeferTargetlessConditional = false;
        var diagMark = Diagnostics.Count;

        // ADR-0151: `else` is mandatory in value position, exactly as for the
        // ADR-0064 if-expression (GS0276).
        if (syntax.ElseExpression == null)
        {
            Diagnostics.ReportIfExpressionMissingElse(syntax.IfKeyword.Location);
            return new BoundErrorExpression(null);
        }

        // The bindings live in their own scope so they are invisible to the
        // else branch (ADR-0071: bindings are then-only). `narrowing` is the
        // single smart-cast frame every binding is added to as it succeeds, so
        // a later initializer, the guard, and the then-block all observe the
        // earlier bindings at their non-null underlying types.
        scope = new BoundScope(scope);
        var narrowing = new Dictionary<AccessPath, TypeSymbol>();
        binderCtx.NarrowedVariables.Add(narrowing);

        var bound = ImmutableArray.CreateBuilder<(IfLetBindingClauseSyntax Syntax, VariableSymbol Variable, BoundExpression Initializer)>();
        var anyInvalid = false;
        BoundExpression? guard = null;
        BoundExpression whenTrue;
        try
        {
            foreach (var binding in syntax.Bindings)
            {
                var clause = IfLetBindingSupport.BindBindingClause(
                    binding,
                    Diagnostics,
                    conversions,
                    bindTypeClause,
                    initializer => BindExpression(initializer),
                    DeclareIfLetLocal);

                if (!clause.IsValid)
                {
                    anyInvalid = true;
                    continue;
                }

                narrowing[clause.Variable] = Invariant.Required(
                    clause.Underlying,
                    "a valid if-let binding has an underlying type");
                bound.Add((binding, clause.Variable, clause.Initializer));
            }

            if (syntax.Guard != null)
            {
                guard = BindExpression(syntax.Guard, TypeSymbol.Bool);
            }

            whenTrue = BindBlockExpressionValue(syntax.ThenBlock, canBeVoid, targetType);
        }
        finally
        {
            binderCtx.NarrowedVariables.RemoveAt(binderCtx.NarrowedVariables.Count - 1);

            scope = scope.Pop();
        }

        // Bound AFTER the binding scope/frame is popped: the else branch never
        // sees the bindings.
        var whenFalse = BindIfLetElseBranch(syntax.ElseExpression, canBeVoid, targetType);

        if (anyInvalid
            || bound.Count == 0
            || guard is BoundErrorExpression
            || whenTrue is BoundErrorExpression
            || whenFalse is BoundErrorExpression)
        {
            return new BoundErrorExpression(null);
        }

        TryAdaptConditionalIntegerLiteralArm(ref whenTrue, ref whenFalse);

        var resultType = ComputeConditionalResultType(whenTrue.Type, whenFalse.Type, targetType);
        if (resultType == null)
        {
            if (deferOnFailure)
            {
                Diagnostics.TruncateTo(diagMark);
                return new BoundErrorExpression(syntax);
            }

            Diagnostics.ReportConditionalNoCommonResultType(
                syntax.Location,
                whenTrue.Type?.Name ?? "?",
                whenFalse.Type?.Name ?? "?");
            return new BoundErrorExpression(null);
        }

        var convertedTrue = ConvertConditionalBranch(syntax.ThenBlock.Location, whenTrue, resultType);
        var convertedFalse = ConvertConditionalBranch(syntax.ElseExpression.Location, whenFalse, resultType);
        if (convertedTrue is BoundErrorExpression || convertedFalse is BoundErrorExpression)
        {
            if (deferOnFailure)
            {
                Diagnostics.TruncateTo(diagMark);
                return new BoundErrorExpression(syntax);
            }

            return new BoundErrorExpression(null);
        }

        var condition = Invariant.Required(
            BuildIfLetCondition(bound.ToImmutable(), 0, guard),
            "a valid if-let expression has at least one binding");
        return new BoundConditionalExpression(null, condition, convertedTrue, convertedFalse, resultType);
    }

    /// <summary>
    /// Declares one ADR-0151 binding local. Routed through the same
    /// <c>DeclarationBinder.BindVariableDeclaration</c> callback the statement
    /// forms use, so duplicate-name reporting (GS0004) and the top-level
    /// global-variable shaping behave identically on both surfaces.
    /// </summary>
    private VariableSymbol DeclareIfLetLocal(SyntaxToken identifier, bool isReadOnly, TypeSymbol type)
    {
        if (bindLocalVariable != null)
        {
            return bindLocalVariable(identifier, isReadOnly, type);
        }

        // Defensive: an ExpressionBinder constructed without the declaration
        // callback (no production path does this) still produces a usable
        // symbol so binding can continue and report the real diagnostics.
        var fallback = new LocalVariableSymbol(identifier.Text ?? "?", isReadOnly, type, declaringSyntax: identifier);
        scope.TryDeclareVariable(fallback);
        return fallback;
    }

    /// <summary>
    /// Builds the boolean condition that declares each binding in turn and
    /// short-circuits on the first <c>nil</c>. See
    /// <see cref="BindIfLetExpression"/> for the produced shape.
    /// </summary>
    private BoundExpression BuildIfLetCondition(
        ImmutableArray<(IfLetBindingClauseSyntax Syntax, VariableSymbol Variable, BoundExpression Initializer)> bindings,
        int index,
        BoundExpression? guard)
    {
        var (bindingSyntax, variable, initializer) = bindings[index];
        var declaration = new BoundVariableDeclaration(bindingSyntax, variable, initializer);
        var test = Invariant.Required(
            IfLetBindingSupport.BuildNilCheckChain(bindingSyntax, new[] { variable }),
            "an if-let binding condition has a nil check");

        BoundExpression value;
        if (index == bindings.Length - 1)
        {
            value = guard == null
                ? test
                : new BoundConditionalExpression(
                    null,
                    test,
                    guard,
                    new BoundLiteralExpression(bindingSyntax, false, TypeSymbol.Bool),
                    TypeSymbol.Bool);
        }
        else
        {
            value = new BoundConditionalExpression(
                null,
                test,
                BuildIfLetCondition(bindings, index + 1, guard),
                new BoundLiteralExpression(bindingSyntax, false, TypeSymbol.Bool),
                TypeSymbol.Bool);
        }

        return new BoundBlockExpression(
            null,
            ImmutableArray.Create<BoundStatement>(declaration),
            value);
    }

    /// <summary>
    /// Binds the branch after <c>else</c>: a chained <c>else if</c> /
    /// <c>else if let</c>, or a plain block expression. Delegates to the
    /// ADR-0064 helper, which already recognises both chain kinds.
    /// </summary>
    private BoundExpression BindIfLetElseBranch(
        ExpressionSyntax elseSyntax,
        bool canBeVoid,
        TypeSymbol? targetType = null)
        => BindIfExpressionElseBranch(elseSyntax, canBeVoid, targetType);
}
