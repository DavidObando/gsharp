// <copyright file="Issue3076ProbeRefTypes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Compiler.Tests;

/// <summary>CLR generic static storage used by issue #3076 evaluation tests.</summary>
public static class Issue3076GenericStaticSlot<T>
{
    /// <summary>Gets or sets per-construction property storage.</summary>
    public static int Property { get; set; }

    /// <summary>Per-construction field storage.</summary>
    public static int Field;

    /// <summary>Reads per-construction property storage from the fixture assembly.</summary>
    /// <returns>The property value.</returns>
    public static int ReadProperty() => Property;

    /// <summary>Reads per-construction field storage from the fixture assembly.</summary>
    /// <returns>The field value.</returns>
    public static int ReadField() => Field;
}

/// <summary>CLR two-parameter generic static storage used by issue #3076 evaluation tests.</summary>
public static class Issue3076GenericPairSlot<TFirst, TSecond>
{
    /// <summary>Gets or sets per-construction property storage.</summary>
    public static int Property { get; set; }

    /// <summary>Per-construction field storage.</summary>
    public static int Field;
}

/// <summary>CLR generic type used as a nested type argument by issue #3076 tests.</summary>
public sealed class Issue3076GenericBox<T>
{
}

/// <summary>CLR non-generic static-storage control used by issue #3076 tests.</summary>
public static class Issue3076PlainStaticSlot
{
    /// <summary>Gets or sets property storage.</summary>
    public static int Property { get; set; }

    /// <summary>Field storage.</summary>
    public static int Field;
}
