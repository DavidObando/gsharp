// <copyright file="TypeIdentityComparer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Issue #420 (P3-9): compares <see cref="Type"/> instances by structural
/// identity (assembly-qualified name) rather than reference equality.
///
/// The emitter resolves CLR <see cref="Type"/> objects through
/// <see cref="System.Reflection.MetadataLoadContext"/>. The same logical type
/// can be returned as two distinct <see cref="Type"/> instances when it is
/// reached through different reference paths (e.g. via different
/// MetadataLoadContext lookups for the same assembly identity, or when the
/// same type is observed both from a directly loaded assembly and from a
/// transitively loaded one). Reference-equality-keyed caches then mint a
/// duplicate <c>TypeRef</c> row for each occurrence, producing valid but
/// bloated metadata that tools like ILSpy render as separate rows.
///
/// Using assembly-qualified name as the identity key collapses these
/// duplicates into a single cache entry — and therefore a single <c>TypeRef</c>
/// row — without affecting types that genuinely differ.
/// </summary>
internal sealed class TypeIdentityComparer : IEqualityComparer<Type>
{
    public static readonly TypeIdentityComparer Instance = new();

    private TypeIdentityComparer()
    {
    }

    public bool Equals(Type x, Type y)
    {
        if (ReferenceEquals(x, y))
        {
            return true;
        }

        if (x is null || y is null)
        {
            return false;
        }

        var keyX = GetKey(x);
        var keyY = GetKey(y);
        return string.Equals(keyX, keyY, StringComparison.Ordinal);
    }

    public int GetHashCode(Type obj)
    {
        if (obj is null)
        {
            throw new ArgumentNullException(nameof(obj));
        }

        return StringComparer.Ordinal.GetHashCode(GetKey(obj));
    }

    private static string GetKey(Type type)
    {
        // AssemblyQualifiedName encodes namespace, name (including nesting via
        // '+'), generic arity, generic arguments, array/pointer/byref suffixes,
        // and the full assembly identity. That makes it a faithful structural
        // key: two Type instances that describe the same logical type from
        // different MetadataLoadContext paths share the same string here.
        // Fall back to FullName/Name when AssemblyQualifiedName is unavailable
        // (e.g. generic type parameters), preferring the most specific
        // identifier we can build.
        return type.AssemblyQualifiedName
            ?? type.FullName
            ?? type.Name;
    }
}
