// <copyright file="OverloadResolutionGenerators.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using FsCheck;
using FsCheck.Fluent;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Binding.OverloadResolution;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Custom FsCheck generators for the overload-resolution property tests.
/// </summary>
public static class OverloadResolutionGenerators
{
    private static readonly ImmutableArray<Type> ArgumentTypes =
    [
        typeof(bool),
        typeof(byte),
        typeof(char),
        typeof(decimal),
        typeof(double),
        typeof(float),
        typeof(int),
        typeof(long),
        typeof(object),
        typeof(sbyte),
        typeof(short),
        typeof(string),
        typeof(uint),
        typeof(ulong),
        typeof(ushort),
    ];

    internal static readonly ImmutableArray<MethodInfo> Methods = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionPropertyFixture")
        .GetMethods(BindingFlags.Public | BindingFlags.Static)
        .Where(m => m.DeclaringType == NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Binding.OverloadResolutionPropertyFixture"))
        .ToImmutableArray();

    private static readonly Gen<Type> TypeGen = Gen.Elements(ArgumentTypes.ToArray());

    /// <summary>
    /// Gets generated candidate arrays.
    /// </summary>
    /// <returns>The arbitrary candidate generator.</returns>
    public static Arbitrary<MethodInfo[]> Candidates()
    {
        var gen =
            from candidateCount in Gen.Choose(0, Math.Min(8, Methods.Length))
            from indexes in Gen.ArrayOf(Gen.Choose(0, Methods.Length - 1), candidateCount)
            select indexes.Distinct().Select(i => Methods[i]).ToArray();

        return Arb.From(gen);
    }

    /// <summary>
    /// Gets generated argument-type arrays.
    /// </summary>
    /// <returns>The arbitrary argument-type generator.</returns>
    public static Arbitrary<Type[]> ArgTypes()
    {
        var gen =
            from argumentCount in Gen.Choose(0, 3)
            from argumentTypes in Gen.ArrayOf(TypeGen, argumentCount)
            select argumentTypes;
        return Arb.From(gen);
    }

    /// <summary>
    /// Gets generated argument types.
    /// </summary>
    /// <returns>The arbitrary type generator.</returns>
    public static Arbitrary<Type> Types()
    {
        return Arb.From(TypeGen);
    }

    internal static ImmutableArray<MethodInfo> FindOneParameterMethods()
        => Methods.Where(m => m.GetParameters().Length == 1).ToImmutableArray();

    internal static ImmutableArray<MethodInfo> FindNumericOneParameterMethods()
        => FindOneParameterMethods()
            .Where(m => IsNumericOrChar(m.GetParameters()[0].ParameterType))
            .ToImmutableArray();

    internal static int CompareExpected(
        ClrOverloadResolution.ImplicitConversionKind firstClassification,
        Type firstTarget,
        ClrOverloadResolution.ImplicitConversionKind secondClassification,
        Type secondTarget,
        Type source)
    {
        if (firstClassification != secondClassification)
        {
            return ((int)firstClassification).CompareTo((int)secondClassification);
        }

        if (firstClassification == ClrOverloadResolution.ImplicitConversionKind.NumericWidening)
        {
            return ClrOverloadResolution.CompareNumericTargets(firstTarget, secondTarget, source);
        }

        return 0;
    }

    internal static bool IsNumericOrChar(Type type)
        => type == typeof(byte)
            || type == typeof(char)
            || type == typeof(decimal)
            || type == typeof(double)
            || type == typeof(float)
            || type == typeof(int)
            || type == typeof(long)
            || type == typeof(sbyte)
            || type == typeof(short)
            || type == typeof(uint)
            || type == typeof(ulong)
            || type == typeof(ushort);

    internal static MethodInfo FindExactOneParameterMethod(Type argumentType)
        => FindOneParameterMethods().Single(m => m.GetParameters()[0].ParameterType == argumentType);
}

internal sealed class MethodIdentityComparer : IEqualityComparer<MethodInfo>
{
    public static readonly MethodIdentityComparer Instance = new();

    private MethodIdentityComparer()
    {
    }

    public bool Equals(MethodInfo x, MethodInfo y)
        => x is null ? y is null : y is not null && x.MetadataToken == y.MetadataToken && x.Module == y.Module;

    public int GetHashCode(MethodInfo obj)
        => HashCode.Combine(obj.Module, obj.MetadataToken);
}
