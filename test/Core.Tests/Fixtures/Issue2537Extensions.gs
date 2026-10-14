// <copyright file="Issue2537Extensions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.Fixtures

class ImportedPair2537[T] {
    init(first T, second T) {
        First = first
        Second = second
    }

    prop First T {
        get;
    }

    prop Second T {
        get;
    }
}

shared class Issue2537Extensions { }

@ExtensionOwner(typeof(Issue2537Extensions))
func (pair ImportedPair2537[T]) Deconstruct[T](out first T, out second T) {
    first = pair.First
    second = pair.Second
}

@ExtensionOwner(typeof(Issue2537Extensions))
func (pair ImportedPair2537[T]) Transform[T](transform(T) -> T) ImportedPair2537[T] -> ImportedPair2537[T](
    transform(pair.First),
    transform(pair.Second)
)

@ExtensionOwner(typeof(Issue2537Extensions))
func (pair ImportedPair2537[T]) Transform[T, TResult](transform(T) -> TResult) TResult -> transform(pair.First)
