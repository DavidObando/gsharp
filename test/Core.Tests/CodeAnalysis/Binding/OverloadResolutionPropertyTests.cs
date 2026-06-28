// <copyright file="OverloadResolutionPropertyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Reflection;
using FsCheck.Xunit;
using GSharp.Core.CodeAnalysis.Binding;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Property-based tests for <see cref="OverloadResolution"/>.
/// </summary>
public class OverloadResolutionPropertyTests
{
    /// <summary>
    /// Resolving the same candidate set and arguments repeatedly is deterministic.
    /// </summary>
    /// <param name="scenario">The generated overload-resolution input.</param>
    /// <returns><see langword="true"/> when both attempts produce the same result.</returns>
    [Property(MaxTest = 300, Arbitrary = [typeof(OverloadResolutionGenerators)])]
    public bool Resolution_is_deterministic(MethodInfo[] candidates, Type[] argTypes)
    {
        var first = OverloadResolution.Resolve(candidates, argTypes);
        var second = OverloadResolution.Resolve(candidates, argTypes);

        return first.Outcome == second.Outcome
            && MethodIdentityComparer.Instance.Equals(first.Best, second.Best)
            && first.Ambiguous.SequenceEqual(second.Ambiguous, MethodIdentityComparer.Instance);
    }

    /// <summary>
    /// Resolution results maintain their public shape invariants.
    /// </summary>
    /// <param name="scenario">The generated overload-resolution input.</param>
    /// <returns><see langword="true"/> when the outcome and payload agree.</returns>
    [Property(MaxTest = 300, Arbitrary = [typeof(OverloadResolutionGenerators)])]
    public bool Outcome_payloads_match_outcome(MethodInfo[] candidates, Type[] argTypes)
    {
        var result = OverloadResolution.Resolve(candidates, argTypes);

        return result.Outcome switch
        {
            OverloadResolution.ResolutionOutcome.NoneApplicable =>
                result.Best is null && result.Ambiguous.IsEmpty,
            OverloadResolution.ResolutionOutcome.Resolved =>
                result.Best is not null && result.Ambiguous.IsEmpty,
            OverloadResolution.ResolutionOutcome.Ambiguous =>
                result.Best is null && result.Ambiguous.Length >= 2,
            _ => false,
        };
    }

    /// <summary>
    /// Every reported best or ambiguous method came from the original candidate set.
    /// </summary>
    /// <param name="scenario">The generated overload-resolution input.</param>
    /// <returns><see langword="true"/> when all returned methods were supplied as candidates.</returns>
    [Property(MaxTest = 300, Arbitrary = [typeof(OverloadResolutionGenerators)])]
    public bool Resolution_only_returns_input_candidates(MethodInfo[] candidates, Type[] argTypes)
    {
        var result = OverloadResolution.Resolve(candidates, argTypes);

        return result.Outcome switch
        {
            OverloadResolution.ResolutionOutcome.Resolved =>
                Contains(candidates, result.Best),
            OverloadResolution.ResolutionOutcome.Ambiguous =>
                result.Ambiguous.All(m => Contains(candidates, m)),
            _ => true,
        };
    }

    /// <summary>
    /// An applicable identity conversion wins over widening, boxing, and reference conversions.
    /// </summary>
    /// <param name="scenario">The generated exact-match scenario.</param>
    /// <returns><see langword="true"/> when the exact candidate resolves.</returns>
    [Property(MaxTest = 200, Arbitrary = [typeof(OverloadResolutionGenerators)])]
    public bool Exact_match_is_preferred(Type argumentType, MethodInfo[] distractors)
    {
        var exact = OverloadResolutionGenerators.FindExactOneParameterMethod(argumentType);
        var candidates = new[] { exact }
            .Concat(distractors.Where(m => !MethodIdentityComparer.Instance.Equals(m, exact)))
            .Distinct(MethodIdentityComparer.Instance)
            .ToArray();
        var result = OverloadResolution.Resolve(candidates, [argumentType]);

        return result.Outcome == OverloadResolution.ResolutionOutcome.Resolved
            && MethodIdentityComparer.Instance.Equals(exact, result.Best);
    }

    /// <summary>
    /// Numeric better-conversion ordering is antisymmetric and drives overload choice.
    /// </summary>
    /// <param name="scenario">The generated numeric-betterness scenario.</param>
    /// <returns><see langword="true"/> when the expected numeric target resolves.</returns>
    [Property(MaxTest = 300, Arbitrary = [typeof(OverloadResolutionGenerators)])]
    public bool Numeric_betterness_is_antisymmetric_and_selects_expected_candidate(
        Type source,
        int firstIndex,
        int secondIndex)
    {
        if (!OverloadResolutionGenerators.IsNumericOrChar(source))
        {
            return true;
        }

        var methods = OverloadResolutionGenerators.FindNumericOneParameterMethods();
        var first = methods[PositiveModulo(firstIndex, methods.Length)];
        var second = methods[PositiveModulo(secondIndex, methods.Length)];
        if (MethodIdentityComparer.Instance.Equals(first, second))
        {
            return true;
        }

        var firstTarget = first.GetParameters()[0].ParameterType;
        var secondTarget = second.GetParameters()[0].ParameterType;
        var firstClassification = OverloadResolution.ClassifyImplicit(firstTarget, source);
        var secondClassification = OverloadResolution.ClassifyImplicit(secondTarget, source);
        if (firstClassification == OverloadResolution.ImplicitConversionKind.None
            || secondClassification == OverloadResolution.ImplicitConversionKind.None)
        {
            return true;
        }

        var comparison = OverloadResolutionGenerators.CompareExpected(
            firstClassification,
            firstTarget,
            secondClassification,
            secondTarget,
            source);
        if (comparison == 0)
        {
            return true;
        }

        var expected = comparison < 0 ? first : second;
        var forward = OverloadResolution.CompareNumericTargets(firstTarget, secondTarget, source);
        var reverse = OverloadResolution.CompareNumericTargets(secondTarget, firstTarget, source);
        if (forward != -reverse)
        {
            return false;
        }

        var result = OverloadResolution.Resolve(new[] { first, second }, [source]);
        return result.Outcome == OverloadResolution.ResolutionOutcome.Resolved
            && MethodIdentityComparer.Instance.Equals(expected, result.Best);
    }

    private static int PositiveModulo(int value, int modulus)
        => (int)(((long)value - int.MinValue) % modulus);

    private static bool Contains(MethodInfo[] candidates, MethodInfo method)
        => candidates.Any(candidate => MethodIdentityComparer.Instance.Equals(candidate, method));
}
