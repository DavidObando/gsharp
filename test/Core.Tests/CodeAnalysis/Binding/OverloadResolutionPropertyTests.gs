// <copyright file="OverloadResolutionPropertyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import FsCheck.Xunit
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import System
import System.Linq
import System.Reflection

/// Property-based tests for (cref:ClrOverloadResolution).
open class OverloadResolutionPropertyTests {
    /// Resolving the same candidate set and arguments repeatedly is deterministic.
    /// @param candidates The generated candidate method set.
    /// @param argTypes The generated argument types.
    /// @returns `true` when both attempts produce the same result.
    @Property(MaxTest = int32(300), Arbitrary = []Type{typeof(OverloadResolutionGenerators)})
    func Resolution_is_deterministic(candidates[]MethodInfo, argTypes[]Type) bool {
        let first = ClrOverloadResolution.Resolve(candidates, argTypes)
        let second = ClrOverloadResolution.Resolve(candidates, argTypes)
        return first.Outcome == second.Outcome && MethodIdentityComparer.Instance.Equals(first.Best, second.Best) &&
            first
            .Ambiguous
            .SequenceEqual(second.Ambiguous, MethodIdentityComparer.Instance)
    }

    /// Resolution results maintain their public shape invariants.
    /// @param candidates The generated candidate method set.
    /// @param argTypes The generated argument types.
    /// @returns `true` when the outcome and payload agree.
    @Property(MaxTest = int32(300), Arbitrary = []Type{typeof(OverloadResolutionGenerators)})
    func Outcome_payloads_match_outcome(candidates[]MethodInfo, argTypes[]Type) bool {
        let result = ClrOverloadResolution.Resolve(candidates, argTypes)
        return switch result.Outcome {
            case ClrOverloadResolution.ResolutionOutcome.NoneApplicable: result.Best == nil && result.Ambiguous.IsEmpty
            case ClrOverloadResolution.ResolutionOutcome.Resolved: result.Best != nil && result.Ambiguous.IsEmpty
            case ClrOverloadResolution.ResolutionOutcome.Ambiguous: result.Best == nil && result.Ambiguous.Length >= 2
            default: false
        }
    }

    /// Every reported best or ambiguous method came from the original candidate set.
    /// @param candidates The generated candidate method set.
    /// @param argTypes The generated argument types.
    /// @returns `true` when all returned methods were supplied as candidates.
    @Property(MaxTest = int32(300), Arbitrary = []Type{typeof(OverloadResolutionGenerators)})
    func Resolution_only_returns_input_candidates(candidates[]MethodInfo, argTypes[]Type) bool {
        let result = ClrOverloadResolution.Resolve(candidates, argTypes)
        return switch result.Outcome {
            case ClrOverloadResolution.ResolutionOutcome.Resolved: Contains(candidates, result.Best)
            case ClrOverloadResolution.ResolutionOutcome.Ambiguous: result.Ambiguous.All(
                (m MethodInfo) -> Contains(candidates, m)
            )
            default: true
        }
    }

    /// An applicable identity conversion wins over widening, boxing, and reference conversions.
    /// @param argumentType The generated argument type whose exact one-parameter method must win.
    /// @param distractors The generated non-exact candidates competing with it.
    /// @returns `true` when the exact candidate resolves.
    @Property(MaxTest = int32(200), Arbitrary = []Type{typeof(OverloadResolutionGenerators)})
    func Exact_match_is_preferred(argumentType Type, distractors[]MethodInfo) bool {
        let exact = OverloadResolutionGenerators.FindExactOneParameterMethod(argumentType)
        let candidates = []MethodInfo{exact}
            .Concat(distractors.Where((m MethodInfo) -> !MethodIdentityComparer.Instance.Equals(m, exact)))
            .Distinct(MethodIdentityComparer.Instance)
            .ToArray()
        let result = ClrOverloadResolution.Resolve(candidates, []Type? {argumentType})
        return result.Outcome == ClrOverloadResolution
            .ResolutionOutcome
            .Resolved &&
            MethodIdentityComparer
            .Instance
            .Equals(exact, result.Best)
    }

    /// Numeric better-conversion ordering is antisymmetric and drives overload choice.
    /// @param source The generated source type of the single argument.
    /// @param firstIndex Index selecting the first numeric candidate.
    /// @param secondIndex Index selecting the second numeric candidate.
    /// @returns `true` when the expected numeric target resolves.
    @Property(MaxTest = int32(300), Arbitrary = []Type{typeof(OverloadResolutionGenerators)})
    func Numeric_betterness_is_antisymmetric_and_selects_expected_candidate(
        source Type,
        firstIndex int32,
        secondIndex int32
    ) bool {
        if !OverloadResolutionGenerators.IsNumericOrChar(source) {
            return true
        }
        let methods = OverloadResolutionGenerators.FindNumericOneParameterMethods()
        let first = methods[PositiveModulo(firstIndex, methods.Length)]
        let second = methods[PositiveModulo(secondIndex, methods.Length)]
        if MethodIdentityComparer.Instance.Equals(first, second) {
            return true
        }
        let firstTarget = first.GetParameters()[0].ParameterType
        let secondTarget = second.GetParameters()[0].ParameterType
        let firstClassification = ClrOverloadResolution.ClassifyImplicit(firstTarget, source)
        let secondClassification = ClrOverloadResolution.ClassifyImplicit(secondTarget, source)
        if firstClassification == ClrOverloadResolution
            .ImplicitConversionKind
            .None ||
            secondClassification == ClrOverloadResolution
            .ImplicitConversionKind
            .None {
            return true
        }
        let comparison = OverloadResolutionGenerators.CompareExpected(
            firstClassification,
            firstTarget,
            secondClassification,
            secondTarget,
            source
        )
        if comparison == 0 {
            return true
        }
        let expected = if comparison < 0 {
            first
        } else {
            second
        }
        let forward = ClrOverloadResolution.CompareNumericTargets(firstTarget, secondTarget, source)
        let reverse = ClrOverloadResolution.CompareNumericTargets(secondTarget, firstTarget, source)
        if forward != -reverse {
            return false
        }
        let result = ClrOverloadResolution.Resolve([]MethodInfo{first, second}, []Type? {source})
        return result.Outcome == ClrOverloadResolution
            .ResolutionOutcome
            .Resolved &&
            MethodIdentityComparer
            .Instance
            .Equals(expected, result.Best)
    }

    shared {
        private func PositiveModulo(value int32, modulus int32) int32 -> int32(
            ((int64(value) - int64(int32.MinValue)) % int64(modulus))
        )

        private func Contains(candidates[]MethodInfo, method MethodInfo?) bool -> candidates.Any(
            (candidate MethodInfo) -> MethodIdentityComparer.Instance.Equals(candidate, method)
        )
    }
}
