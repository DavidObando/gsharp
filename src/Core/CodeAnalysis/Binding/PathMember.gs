// <copyright file="PathMember.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Reflection
import System.Runtime.CompilerServices

/// Identifies one source or imported CLR member in an (cref:AccessPath).
class PathMember : IEquatable[PathMember] {
    /// Initializes a new instance of the (cref:PathMember) class for a source symbol.
    /// @param sourceSymbol The source member symbol.
    init(sourceSymbol Symbol) {
        SourceSymbol = sourceSymbol ?? throw ArgumentNullException("sourceSymbol")
        ClrMember = nil
    }

    /// Initializes a new instance of the (cref:PathMember) class for an imported CLR member.
    /// @param clrMember The reflected CLR member.
    init(clrMember MemberInfo) {
        ClrMember = clrMember ?? throw ArgumentNullException("clrMember")
        SourceSymbol = nil
    }

    /// Gets the source member symbol, or `null` for a CLR member.
    prop SourceSymbol Symbol? {
        get;
    }

    /// Gets the reflected CLR member, or `null` for a source member.
    prop ClrMember MemberInfo? {
        get;
    }

    /// Gets the member name.
    prop Name string? -> SourceSymbol?.Name ?? ClrMember?.Name

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Equals(other PathMember?) bool {
        if other == nil {
            return false
        }
        if SourceSymbol != nil || other.SourceSymbol != nil {
            return object.ReferenceEquals(SourceSymbol, other.SourceSymbol)
        }
        if ClrMember == nil || other.ClrMember == nil {
            return ClrMember == nil && other.ClrMember == nil
        }
        let clrMember = ClrMember!!
        return clrMember.MetadataToken == other.ClrMember.MetadataToken && object.ReferenceEquals(
            clrMember.Module,
            other.ClrMember.Module
        )
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func Equals(obj object?) bool -> obj is PathMember other && Equals(other)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func GetHashCode() int32 {
        if SourceSymbol != nil {
            return RuntimeHelpers.GetHashCode(SourceSymbol)
        }
        return if ClrMember == nil {
            0
        } else {
            HashCode.Combine(RuntimeHelpers.GetHashCode(ClrMember!!.Module), ClrMember!!.MetadataToken)
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func ToString() string -> Name ?? string.Empty
}
