// <copyright file="ClrTypeUtilities.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Helpers for comparing <see cref="Type"/> instances that may originate from
/// different reflection contexts (e.g. the gsc host's live runtime vs. a
/// <see cref="System.Reflection.MetadataLoadContext"/> over target-framework
/// reference assemblies). Reference-equality (<c>==</c>) and
/// <see cref="Type.IsAssignableFrom"/> only work within a single context, so
/// cross-context comparisons must fall back to name-based matching.
/// </summary>
internal static class ClrTypeUtilities
{
    /// <summary>
    /// Returns whether two <see cref="Type"/>s refer to the same logical CLR
    /// type, regardless of which reflection context produced them. Two types
    /// are considered the same when their <see cref="Type.FullName"/>s match.
    /// </summary>
    /// <param name="a">First type.</param>
    /// <param name="b">Second type.</param>
    /// <returns><c>true</c> when both types are non-null and share a FullName.</returns>
    public static bool AreSame(Type a, Type b)
    {
        if (a is null || b is null)
        {
            return false;
        }

        if (ReferenceEquals(a, b))
        {
            return true;
        }

        return string.Equals(a.FullName, b.FullName, StringComparison.Ordinal);
    }

    /// <summary>
    /// Returns whether <paramref name="source"/> is assignable to
    /// <paramref name="target"/> when the two types may live in different
    /// reflection contexts. Falls back to identity-by-name and special-cases
    /// <c>System.Object</c> as universally assignable.
    /// </summary>
    /// <param name="target">Target parameter type.</param>
    /// <param name="source">Source argument type.</param>
    /// <returns><c>true</c> when an assignment is permissible.</returns>
    public static bool IsAssignableByName(Type target, Type source)
    {
        if (target is null || source is null)
        {
            return false;
        }

        if (AreSame(target, source))
        {
            return true;
        }

        if (string.Equals(target.FullName, "System.Object", StringComparison.Ordinal))
        {
            return true;
        }

        // Same-context fast path covers inheritance / interfaces.
        if (ReferenceEquals(target.Assembly, source.Assembly) || target.GetType() == source.GetType())
        {
            try
            {
                return target.IsAssignableFrom(source);
            }
            catch (InvalidOperationException)
            {
                // MLC types throw for some cross-context paths; fall through.
            }
        }

        return false;
    }

    /// <summary>
    /// Returns whether <paramref name="type"/> is a CLR delegate type, i.e. it
    /// (transitively) derives from <c>System.MulticastDelegate</c> /
    /// <c>System.Delegate</c>. Walks the base-type chain by name so it is safe
    /// for types loaded through a <see cref="System.Reflection.MetadataLoadContext"/>,
    /// where <c>typeof(Delegate).IsAssignableFrom</c> would throw.
    /// </summary>
    /// <param name="type">The candidate type.</param>
    /// <returns><c>true</c> when the type is a delegate type.</returns>
    public static bool IsDelegateType(Type type)
    {
        for (var t = type; t != null; t = t.BaseType)
        {
            var fullName = t.FullName;
            if (string.Equals(fullName, "System.MulticastDelegate", StringComparison.Ordinal)
                || string.Equals(fullName, "System.Delegate", StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }
}
