// <copyright file="ManagedLocationKey.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Runtime.CompilerServices;

namespace Gsharp.Values;

#pragma warning disable CS1591, SA1600

/// <summary>
/// Immutable compiler-facing location identity. Field tokens are paired with
/// their constructed declaring types; neither wrapper identity nor mutable
/// referent contents participate in equality.
/// </summary>
public sealed class ManagedLocationKey : IEquatable<ManagedLocationKey>
{
    private readonly object owner;
    private readonly int index;
    private readonly (RuntimeFieldHandle Field, RuntimeTypeHandle Type)[] path;
    private readonly int hash;

    private ManagedLocationKey(object owner, int index, (RuntimeFieldHandle, RuntimeTypeHandle)[] path)
    {
        ArgumentNullException.ThrowIfNull(owner);
        this.owner = owner;
        this.index = index;
        this.path = path;
        var value = default(HashCode);
        value.Add(RuntimeHelpers.GetHashCode(owner));
        value.Add(index);
        foreach (var field in path)
        {
            value.Add(field);
        }

        hash = value.ToHashCode();
    }

    public static ManagedLocationKey Object(object owner) => new(owner, -1, []);

    public ManagedLocationKey Field(RuntimeFieldHandle field, RuntimeTypeHandle declaringType)
    {
        var fields = new (RuntimeFieldHandle, RuntimeTypeHandle)[path.Length + 1];
        path.CopyTo(fields, 0);
        fields[^1] = (field, declaringType);
        return new ManagedLocationKey(owner, index, fields);
    }

    public bool Equals(ManagedLocationKey? other)
        => other is not null && ReferenceEquals(owner, other.owner)
            && index == other.index && path.AsSpan().SequenceEqual(other.path);

    public override bool Equals(object? obj) => obj is ManagedLocationKey other && Equals(other);

    public override int GetHashCode() => hash;

    internal static ManagedLocationKey Element(object owner, int index) => new(owner, index, []);
}
