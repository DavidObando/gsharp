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

    internal static readonly ImmutableArray<MethodInfo> Methods = typeof(OverloadResolutionPropertyFixture)
        .GetMethods(BindingFlags.Public | BindingFlags.Static)
        .Where(m => m.DeclaringType == typeof(OverloadResolutionPropertyFixture))
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
        OverloadResolution.ImplicitConversionKind firstClassification,
        Type firstTarget,
        OverloadResolution.ImplicitConversionKind secondClassification,
        Type secondTarget,
        Type source)
    {
        if (firstClassification != secondClassification)
        {
            return ((int)firstClassification).CompareTo((int)secondClassification);
        }

        if (firstClassification == OverloadResolution.ImplicitConversionKind.NumericWidening)
        {
            return OverloadResolution.CompareNumericTargets(firstTarget, secondTarget, source);
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

/// <summary>
/// Fixture methods used by property-based overload-resolution tests.
/// </summary>
public static class OverloadResolutionPropertyFixture
{
    /// <summary>Accepts a Boolean value.</summary>
    /// <param name="value">The value.</param>
    public static void Bool(bool value) => _ = value;

    /// <summary>Accepts a byte value.</summary>
    /// <param name="value">The value.</param>
    public static void Byte(byte value) => _ = value;

    /// <summary>Accepts a char value.</summary>
    /// <param name="value">The value.</param>
    public static void Char(char value) => _ = value;

    /// <summary>Accepts a decimal value.</summary>
    /// <param name="value">The value.</param>
    public static void Decimal(decimal value) => _ = value;

    /// <summary>Accepts a double value.</summary>
    /// <param name="value">The value.</param>
    public static void Double(double value) => _ = value;

    /// <summary>Accepts a float value.</summary>
    /// <param name="value">The value.</param>
    public static void Float(float value) => _ = value;

    /// <summary>Accepts an int value.</summary>
    /// <param name="value">The value.</param>
    public static void Int(int value) => _ = value;

    /// <summary>Accepts a long value.</summary>
    /// <param name="value">The value.</param>
    public static void Long(long value) => _ = value;

    /// <summary>Accepts an object value.</summary>
    /// <param name="value">The value.</param>
    public static void Object(object value) => _ = value;

    /// <summary>Accepts an sbyte value.</summary>
    /// <param name="value">The value.</param>
    public static void SByte(sbyte value) => _ = value;

    /// <summary>Accepts a short value.</summary>
    /// <param name="value">The value.</param>
    public static void Short(short value) => _ = value;

    /// <summary>Accepts a string value.</summary>
    /// <param name="value">The value.</param>
    public static void String(string value) => _ = value;

    /// <summary>Accepts a uint value.</summary>
    /// <param name="value">The value.</param>
    public static void UInt(uint value) => _ = value;

    /// <summary>Accepts a ulong value.</summary>
    /// <param name="value">The value.</param>
    public static void ULong(ulong value) => _ = value;

    /// <summary>Accepts a ushort value.</summary>
    /// <param name="value">The value.</param>
    public static void UShort(ushort value) => _ = value;

    /// <summary>Accepts two int values.</summary>
    /// <param name="first">The first value.</param>
    /// <param name="second">The second value.</param>
    public static void PairIntInt(int first, int second)
    {
        _ = first;
        _ = second;
    }

    /// <summary>Accepts two long values.</summary>
    /// <param name="first">The first value.</param>
    /// <param name="second">The second value.</param>
    public static void PairLongLong(long first, long second)
    {
        _ = first;
        _ = second;
    }

    /// <summary>Accepts an int and a long.</summary>
    /// <param name="first">The first value.</param>
    /// <param name="second">The second value.</param>
    public static void PairIntLong(int first, long second)
    {
        _ = first;
        _ = second;
    }

    /// <summary>Accepts a long and an int.</summary>
    /// <param name="first">The first value.</param>
    /// <param name="second">The second value.</param>
    public static void PairLongInt(long first, int second)
    {
        _ = first;
        _ = second;
    }

    /// <summary>Accepts three int values.</summary>
    /// <param name="first">The first value.</param>
    /// <param name="second">The second value.</param>
    /// <param name="third">The third value.</param>
    public static void TripleInt(int first, int second, int third)
    {
        _ = first;
        _ = second;
        _ = third;
    }
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
