// <copyright file="OverloadResolutionGenerators.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import FsCheck
import FsCheck.Fluent
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

/// Custom FsCheck generators for the overload-resolution property tests.
shared class OverloadResolutionGenerators {
    private let ArgumentTypes ImmutableArray[Type] = ImmutableArray.Create[Type](
        []Type{
            typeof(bool),
            typeof(uint8),
            typeof(char),
            typeof(decimal),
            typeof(float64),
            typeof(float32),
            typeof(int32),
            typeof(int64),
            typeof(object),
            typeof(int8),
            typeof(int16),
            typeof(string),
            typeof(uint32),
            typeof(uint64),
            typeof(uint16)
        }
    )
    internal let Methods ImmutableArray[MethodInfo] = NativeMetadataFixtures
        .GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionPropertyFixture")
        .GetMethods(BindingFlags.Public | BindingFlags.Static)
        .Where(
        (m MethodInfo) -> m.DeclaringType == NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionPropertyFixture"
        )
    )
        .ToImmutableArray()
    private let TypeGen Gen[Type] = Gen.Elements(ArgumentTypes.ToArray())!!

    /// Gets generated candidate arrays.
    /// @returns The arbitrary candidate generator.
    func Candidates() Arbitrary[[]MethodInfo] {
        let gen = Gen
            .Choose(0, Math.Min(8, Methods.Length))
            .SelectMany(
            (candidateCount int32) -> Gen.ArrayOf(Gen.Choose(0, Methods.Length - 1), candidateCount),
            (candidateCount int32, indexes[]int32) -> {
                return (candidateCount, indexes)
            }
        )
            .Select(
            ((candidateCount int32, indexes[]int32)) -> indexes.Distinct().Select((i int32) -> Methods[i]).ToArray()
        )
        return Arb.From(gen)!!
    }

    /// Gets generated argument-type arrays.
    /// @returns The arbitrary argument-type generator.
    func ArgTypes() Arbitrary[[]Type] {
        let gen = Gen
            .Choose(0, 3)
            .SelectMany(
            (argumentCount int32) -> Gen.ArrayOf(TypeGen, argumentCount),
            (argumentCount int32, argumentTypes[]Type) -> {
                return (argumentCount, argumentTypes)
            }
        )
            .Select(((argumentCount int32, argumentTypes[]Type)) -> argumentTypes)
        return Arb.From(gen)
    }

    /// Gets generated argument types.
    /// @returns The arbitrary type generator.
    func Types() Arbitrary[Type] {
        return Arb.From(TypeGen)!!
    }

    internal func FindOneParameterMethods() ImmutableArray[MethodInfo] -> Methods.Where(
        (m MethodInfo) -> m.GetParameters().Length == 1
    )
        .ToImmutableArray()

    internal func FindNumericOneParameterMethods() ImmutableArray[MethodInfo] -> FindOneParameterMethods().Where(
        (m MethodInfo) -> IsNumericOrChar(m.GetParameters()[0].ParameterType)
    )
        .ToImmutableArray()

    internal func CompareExpected(
        firstClassification ClrOverloadResolution.ImplicitConversionKind,
        firstTarget Type,
        secondClassification ClrOverloadResolution.ImplicitConversionKind,
        secondTarget Type,
        source Type
    ) int32 {
        if firstClassification != secondClassification {
            return (int32(firstClassification)).CompareTo(int32(secondClassification))
        }
        if firstClassification == ClrOverloadResolution.ImplicitConversionKind.NumericWidening {
            return ClrOverloadResolution.CompareNumericTargets(firstTarget, secondTarget, source)
        }
        return 0
    }

    internal func IsNumericOrChar(type Type) bool -> type == typeof(uint8) ||
        type == typeof(char) ||
        type == typeof(decimal) ||
        type == typeof(float64) ||
        type == typeof(float32) ||
        type == typeof(int32) ||
        type == typeof(int64) ||
        type == typeof(int8) ||
        type == typeof(int16) ||
        type == typeof(uint32) ||
        type == typeof(uint64) ||
        type == typeof(uint16)

    internal func FindExactOneParameterMethod(argumentType Type) MethodInfo -> FindOneParameterMethods().Single(
        (m MethodInfo) -> m.GetParameters()[0].ParameterType == argumentType
    )
}

internal class MethodIdentityComparer : IEqualityComparer[MethodInfo] {
    private init() { }

    func Equals(x MethodInfo?, y MethodInfo?) bool -> if x == nil {
        y == nil
    } else {
        y != nil && x.MetadataToken == y.MetadataToken && x.Module == y.Module
    }

    func GetHashCode(obj MethodInfo) int32 -> HashCode.Combine(obj.Module, obj.MetadataToken)

    shared {
        let Instance MethodIdentityComparer = MethodIdentityComparer()
    }
}
