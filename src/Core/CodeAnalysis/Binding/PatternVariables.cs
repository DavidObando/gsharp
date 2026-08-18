// <copyright file="PatternVariables.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0166: the flow facts of pattern variables introduced by boolean
/// <c>is</c> expressions. A pattern variable is definitely assigned exactly
/// when its pattern matched, so the binder scopes it to the regions where the
/// enclosing condition is known to be true (or false, through negation).
/// This helper computes those "when true" / "when false" sets structurally
/// over a bound condition, mirroring C#'s definite-assignment rules for
/// <c>&amp;&amp;</c>, <c>||</c>, <c>!</c>, and pattern matches, and mirroring
/// the smart-cast classifiers (<c>ClassifyTypeTestNarrowing</c>) that already
/// walk the same shapes.
/// </summary>
internal static class PatternVariables
{
    /// <summary>The empty result: no pattern variable is assigned on either branch.</summary>
    public static readonly (ImmutableArray<LocalVariableSymbol> WhenTrue, ImmutableArray<LocalVariableSymbol> WhenFalse) None =
        (ImmutableArray<LocalVariableSymbol>.Empty, ImmutableArray<LocalVariableSymbol>.Empty);

    /// <summary>
    /// Collects the source-visible variables a pattern assigns when it matches:
    /// type-pattern designations, slice captures, and their conjunctive and
    /// recursive descendants. <c>or</c> and <c>not</c> operands contribute
    /// nothing (the binder already rejects bindings there).
    /// </summary>
    /// <param name="pattern">The bound pattern.</param>
    /// <returns>The variables in source order.</returns>
    public static ImmutableArray<LocalVariableSymbol> CollectBindings(BoundPattern? pattern)
    {
        if (pattern == null)
        {
            return ImmutableArray<LocalVariableSymbol>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
        Collect(pattern, builder);
        return builder.ToImmutable();
    }

    /// <summary>
    /// Classifies a boolean condition into the pattern variables that are
    /// definitely assigned when it evaluates to <see langword="true"/> and to
    /// <see langword="false"/>.
    /// </summary>
    /// <param name="condition">The bound condition.</param>
    /// <returns>The when-true and when-false variable sets.</returns>
    public static (ImmutableArray<LocalVariableSymbol> WhenTrue, ImmutableArray<LocalVariableSymbol> WhenFalse) Classify(BoundExpression? condition)
    {
        switch (condition)
        {
            case BoundIsExpression isExpression:
                return (CollectBindings(isExpression.Pattern), ImmutableArray<LocalVariableSymbol>.Empty);

            case BoundUnaryExpression unary when unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation:
                {
                    var (whenTrue, whenFalse) = Classify(unary.Operand);
                    return (whenFalse, whenTrue);
                }

            case BoundBinaryExpression binary when binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd:
                {
                    // `A && B` is true only when both were true, so both sides'
                    // when-true variables are assigned; it is false when either
                    // side was false, so only variables assigned on BOTH false
                    // paths survive.
                    var (leftTrue, leftFalse) = Classify(binary.Left);
                    var (rightTrue, rightFalse) = Classify(binary.Right);
                    return (Union(leftTrue, rightTrue), Intersect(leftFalse, rightFalse));
                }

            case BoundBinaryExpression binary when binary.Op.Kind == BoundBinaryOperatorKind.LogicalOr:
                {
                    var (leftTrue, leftFalse) = Classify(binary.Left);
                    var (rightTrue, rightFalse) = Classify(binary.Right);
                    return (Intersect(leftTrue, rightTrue), Union(leftFalse, rightFalse));
                }

            case BoundConversionExpression conversion when conversion.Type == TypeSymbol.Bool:
                return Classify(conversion.Expression);

            default:
                return None;
        }
    }

    /// <summary>
    /// Runs <paramref name="bind"/> with <paramref name="variables"/> declared
    /// in a fresh child scope of the binder's current scope — the region in
    /// which those pattern variables are definitely assigned. Duplicate names
    /// are reported by the construct that merged them (see
    /// <c>ExpressionBinder.ReportDuplicatePatternVariables</c>), so a
    /// redeclaration is silently skipped here.
    /// </summary>
    /// <typeparam name="T">The bound result type.</typeparam>
    /// <param name="binderCtx">The shared binder context whose current scope is extended.</param>
    /// <param name="variables">The pattern variables in scope for the region.</param>
    /// <param name="bind">The binding action.</param>
    /// <returns>The bound result.</returns>
    public static T BindInScope<T>(
        BinderContext binderCtx,
        ImmutableArray<LocalVariableSymbol> variables,
        System.Func<T> bind)
    {
        if (variables.IsDefaultOrEmpty)
        {
            return bind();
        }

        var saved = binderCtx.RootScope;
        var region = new BoundScope(saved);
        binderCtx.RootScope = region;
        try
        {
            foreach (var variable in variables)
            {
                region.TryDeclareVariable(variable);
            }

            return bind();
        }
        finally
        {
            binderCtx.RootScope = saved;

            // Anything else the region declared — an inline `out var` in the
            // right operand of `&&`, for instance — belongs to the enclosing
            // scope exactly as it would without the pattern-variable region
            // (C# scopes expression variables to the enclosing statement), so
            // hoist it out; only the pattern variables stay region-scoped.
            var patternSet = new HashSet<LocalVariableSymbol>(variables);
            foreach (var declared in region.GetDeclaredVariables())
            {
                if (declared is LocalVariableSymbol local && patternSet.Contains(local))
                {
                    continue;
                }

                if (!saved.TryDeclareVariable(declared) && declared.DeclaringSyntax is Syntax.SyntaxNode declaring)
                {
                    binderCtx.Diagnostics.ReportSymbolAlreadyDeclared(declaring.Location, declared.Name);
                }
            }
        }
    }

    private static void Collect(BoundPattern pattern, ImmutableArray<LocalVariableSymbol>.Builder into)
    {
        switch (pattern)
        {
            case BoundDiscardPattern { Variable: not null } varPattern:
                into.Add(varPattern.Variable);
                break;

            case BoundTypePattern typePattern:
                if (typePattern.HasBinding)
                {
                    into.Add(typePattern.Variable);
                }

                if (typePattern.PropertyPattern != null)
                {
                    Collect(typePattern.PropertyPattern, into);
                }

                break;

            case BoundPropertyPattern propertyPattern:
                foreach (var field in propertyPattern.Fields)
                {
                    Collect(field.Pattern, into);
                }

                break;

            case BoundListPattern listPattern:
                foreach (var element in listPattern.Elements)
                {
                    Collect(element, into);
                }

                break;

            case BoundSlicePattern slicePattern:
                if (slicePattern.Variable != null
                    && slicePattern.Syntax is Syntax.SlicePatternSyntax { CaptureIdentifier: not null })
                {
                    into.Add(slicePattern.Variable);
                }

                if (slicePattern.Pattern != null)
                {
                    Collect(slicePattern.Pattern, into);
                }

                break;

            case BoundBinaryPattern binaryPattern when binaryPattern.IsConjunction:
                Collect(binaryPattern.Left, into);
                Collect(binaryPattern.Right, into);
                break;

            default:
                break;
        }
    }

    private static ImmutableArray<LocalVariableSymbol> Union(
        ImmutableArray<LocalVariableSymbol> a,
        ImmutableArray<LocalVariableSymbol> b)
    {
        if (a.IsDefaultOrEmpty)
        {
            return b.IsDefault ? ImmutableArray<LocalVariableSymbol>.Empty : b;
        }

        if (b.IsDefaultOrEmpty)
        {
            return a;
        }

        return a.AddRange(b);
    }

    private static ImmutableArray<LocalVariableSymbol> Intersect(
        ImmutableArray<LocalVariableSymbol> a,
        ImmutableArray<LocalVariableSymbol> b)
    {
        if (a.IsDefaultOrEmpty || b.IsDefaultOrEmpty)
        {
            return ImmutableArray<LocalVariableSymbol>.Empty;
        }

        var set = new HashSet<LocalVariableSymbol>(b);
        var builder = ImmutableArray.CreateBuilder<LocalVariableSymbol>();
        foreach (var variable in a)
        {
            if (set.Contains(variable))
            {
                builder.Add(variable);
            }
        }

        return builder.ToImmutable();
    }
}
