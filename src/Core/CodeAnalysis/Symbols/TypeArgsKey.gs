// <copyright file="TypeArgsKey.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Immutable
import System.Runtime.CompilerServices

/// Issue #1621: dictionary key for constructed-generic caches ((cref:StructSymbol),
/// (cref:InterfaceSymbol), (cref:DelegateTypeSymbol)) that compares a vector of
/// type arguments by REFERENCE identity, not by a stringified (cref:RuntimeHelpers.GetHashCode).
/// TypeSymbols are reference-identity throughout the codebase, so a hash-only key risks silently
/// aliasing two distinct constructions whose type arguments' identity hashes collide (the hash is
/// at most 31 bits and is not guaranteed unique). (cref:Equals(TypeArgsKey)) performs the
/// real, correct-by-construction comparison; (cref:GetHashCode) is only a bucketing hint.
internal class TypeArgsKey : IEquatable[TypeArgsKey] {
    private let args ImmutableArray[TypeSymbol]

    init(args ImmutableArray[TypeSymbol]) {
        this.args = if args.IsDefault {
            ImmutableArray[TypeSymbol].Empty
        } else {
            args
        }
    }

    func Equals(other TypeArgsKey?) bool {
        if other == nil || this.args.Length != other.args.Length {
            return false
        }
        for var i = 0; i < this.args.Length; i++ {
            if !object.ReferenceEquals(this.args[i], other.args[i]) {
                return false
            }
        }
        return true
    }

    override func Equals(obj object?) bool -> obj is TypeArgsKey other && this.Equals(other)

    override func GetHashCode() int32 {
        var hash = 17
        for var i = 0; i < this.args.Length; i++ {
            hash = unchecked((hash * 31) + RuntimeHelpers.GetHashCode(this.args[i]))
        }
        return hash
    }
}
