// <copyright file="ReadOnlyManagedRef.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Values;

#pragma warning disable CS1591, SA1600

/// <summary>A shallow readonly location, with no upgrade to writable storage.</summary>
/// <typeparam name="T">The invariant referent type.</typeparam>
public abstract class ReadOnlyManagedRef<T> : ManagedLocation<T>
{
    public static bool operator ==(ReadOnlyManagedRef<T>? left, ReadOnlyManagedRef<T>? right)
        => ReferenceEquals(left, right) || (left is not null && left.SameLocation(right));

    public static bool operator !=(ReadOnlyManagedRef<T>? left, ReadOnlyManagedRef<T>? right) => !(left == right);

    public abstract ref readonly T Borrow();

    public sealed override bool Equals(object? obj) => base.Equals(obj);

    public sealed override int GetHashCode() => base.GetHashCode();

    public static ReadOnlyManagedRef<T> FromArray(T[] array, int index)
    {
        ManagedRef<T>.CheckArray(array, index);
        return new ArrayLocation(array, index);
    }

    private sealed class ArrayLocation(T[] owner, int index) : ReadOnlyManagedRef<T>
    {
        private readonly ManagedLocationKey location = ManagedLocationKey.Element(owner, index);

        public override ref readonly T Borrow() => ref owner[index];

        public override ManagedLocationKey GetLocation() => location;
    }
}
