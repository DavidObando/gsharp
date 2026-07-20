// <copyright file="Issue2537Extensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.Tests.Fixtures;

public sealed class ImportedPair2537<T>
{
    public ImportedPair2537(T first, T second)
    {
        First = first;
        Second = second;
    }

    public T First { get; }

    public T Second { get; }
}

public static class Issue2537Extensions
{
    public static void Deconstruct<T>(this ImportedPair2537<T> pair, out T first, out T second)
    {
        first = pair.First;
        second = pair.Second;
    }

    public static ImportedPair2537<T> Transform<T>(
        this ImportedPair2537<T> pair,
        System.Func<T, T> transform)
        => new(transform(pair.First), transform(pair.Second));

    public static TResult Transform<T, TResult>(
        this ImportedPair2537<T> pair,
        System.Func<T, TResult> transform)
        => transform(pair.First);
}
