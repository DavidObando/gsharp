// <copyright file="ManagedLocation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Gsharp.Values;

#pragma warning disable CS1591, SA1600

/// <summary>
/// Compiler-facing common identity contract. Subclasses must describe stable
/// GC-owned storage and their Borrow implementation must identify that storage.
/// </summary>
/// <typeparam name="T">The invariant referent type.</typeparam>
public abstract class ManagedLocation<T>
{
    public abstract ManagedLocationKey GetLocation();

    public bool SameLocation(ManagedLocation<T>? other)
        => other is not null && GetLocation().Equals(other.GetLocation());

    public override bool Equals(object? obj) => obj is ManagedLocation<T> other && SameLocation(other);

    public override int GetHashCode() => GetLocation().GetHashCode();
}
