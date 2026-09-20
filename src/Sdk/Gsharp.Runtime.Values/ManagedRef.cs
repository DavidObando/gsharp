// <copyright file="ManagedRef.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Values;

#pragma warning disable CS1591, SA1600

/// <summary>A writable heap-storable location; copying it does not copy T.</summary>
/// <typeparam name="T">The invariant referent type.</typeparam>
public abstract class ManagedRef<T> : ManagedLocation<T>
{
    public static bool operator ==(ManagedRef<T>? left, ManagedRef<T>? right)
        => ReferenceEquals(left, right) || (left is not null && left.SameLocation(right));

    public static bool operator !=(ManagedRef<T>? left, ManagedRef<T>? right) => !(left == right);

    public abstract ref T Borrow();

    public ReadOnlyManagedRef<T> AsReadOnly() => new ReadOnlyView(this);

    public sealed override bool Equals(object? obj) => base.Equals(obj);

    public sealed override int GetHashCode() => base.GetHashCode();

    public static ManagedRef<T> FromArray(T[] array, int index)
    {
        CheckArray(array, index);
        return new ArrayLocation(array, index);
    }

    internal static void CheckArray(T[] array, int index)
    {
        ArgumentNullException.ThrowIfNull(array);
        if (!array.GetType().Equals(typeof(T[])))
        {
            throw new ArrayTypeMismatchException();
        }

        if ((uint)index >= (uint)array.Length)
        {
            throw new IndexOutOfRangeException();
        }
    }

    private sealed class ArrayLocation(T[] owner, int index) : ManagedRef<T>
    {
        private readonly ManagedLocationKey location = ManagedLocationKey.Element(owner, index);

        public override ref T Borrow() => ref owner[index];

        public override ManagedLocationKey GetLocation() => location;
    }

    private sealed class ReadOnlyView(ManagedRef<T> source) : ReadOnlyManagedRef<T>
    {
        public override ref readonly T Borrow() => ref source.Borrow();

        public override ManagedLocationKey GetLocation() => source.GetLocation();
    }
}
