// <copyright file="TypeArgsKey.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Runtime.CompilerServices;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Issue #1621: dictionary key for constructed-generic caches (<see cref="StructSymbol"/>,
/// <see cref="InterfaceSymbol"/>, <see cref="DelegateTypeSymbol"/>) that compares a vector of
/// type arguments by REFERENCE identity, not by a stringified <see cref="RuntimeHelpers.GetHashCode"/>.
/// TypeSymbols are reference-identity throughout the codebase, so a hash-only key risks silently
/// aliasing two distinct constructions whose type arguments' identity hashes collide (the hash is
/// at most 31 bits and is not guaranteed unique). <see cref="Equals(TypeArgsKey)"/> performs the
/// real, correct-by-construction comparison; <see cref="GetHashCode"/> is only a bucketing hint.
/// </summary>
internal readonly struct TypeArgsKey : System.IEquatable<TypeArgsKey>
{
    private readonly ImmutableArray<TypeSymbol> args;

    public TypeArgsKey(ImmutableArray<TypeSymbol> args)
    {
        this.args = args.IsDefault ? ImmutableArray<TypeSymbol>.Empty : args;
    }

    public bool Equals(TypeArgsKey other)
    {
        if (this.args.Length != other.args.Length)
        {
            return false;
        }

        for (var i = 0; i < this.args.Length; i++)
        {
            if (!ReferenceEquals(this.args[i], other.args[i]))
            {
                return false;
            }
        }

        return true;
    }

    public override bool Equals(object obj) => obj is TypeArgsKey other && this.Equals(other);

    public override int GetHashCode()
    {
        var hash = 17;
        for (var i = 0; i < this.args.Length; i++)
        {
            hash = unchecked((hash * 31) + RuntimeHelpers.GetHashCode(this.args[i]));
        }

        return hash;
    }
}
