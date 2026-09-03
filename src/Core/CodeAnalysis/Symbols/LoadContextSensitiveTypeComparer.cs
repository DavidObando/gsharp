// <copyright file="LoadContextSensitiveTypeComparer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Emit;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Issue #3826 (the #3705 load-context family): compares <see cref="Type"/>
/// instances the way <see cref="TypeIdentityComparer"/> does — by structural
/// identity — but ADDITIONALLY requires that every assembly the type is built
/// from is the same <see cref="System.Reflection.Assembly"/> INSTANCE.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="TypeIdentityComparer"/> keys on
/// <see cref="Type.AssemblyQualifiedName"/>. Two copies of the same file loaded
/// into two different <see cref="System.Runtime.Loader.AssemblyLoadContext"/>s
/// have the SAME assembly-qualified name, so that comparer treats them as one
/// type. That is exactly what #420 wanted for the emitter (collapsing duplicate
/// <c>TypeRef</c> rows for one logical type reached by several paths inside ONE
/// context), and exactly what a process-wide symbol cache must NOT do: it makes
/// a <see cref="Type"/> from one compilation answer a later compilation's
/// lookup.
/// </para>
/// <para>
/// The dangerous case is a constructed generic whose DEFINITION lives in a
/// shared assembly but whose ARGUMENTS come from a private reference context —
/// <c>ImmutableArray&lt;SyntaxNode&gt;</c>, say. <c>ImportedTypeSymbol</c>'s
/// outer cache bucket is keyed by <c>type.Assembly</c>, which for both
/// constructions is the one host <c>System.Collections.Immutable</c>; only the
/// inner comparer separates them, and a name-only comparer does not. The
/// resulting cross-context symbol is silently wrong: closing a generic method
/// over an operand from each side makes
/// <see cref="System.Reflection.MethodInfo.MakeGenericMethod"/> throw, overload
/// resolution drops the candidate per C# §7.5.2, and the call reports "Cannot
/// find function &lt;name&gt;" about a method that plainly exists (#3818).
/// </para>
/// <para>
/// Equality therefore keeps the structural check and adds a walk over the
/// type's constituents (element type, generic arguments) requiring
/// reference-equal assemblies at every position — the same "hash is a bucketing
/// hint, equality is the real test" shape as <see cref="TypeArgsKey"/>. Two
/// instances of one logical type reached by different paths inside a single
/// context still collapse, because a load context returns one
/// <see cref="System.Reflection.Assembly"/> instance per identity.
/// </para>
/// </remarks>
internal sealed class LoadContextSensitiveTypeComparer : IEqualityComparer<Type>
{
    /// <summary>The singleton instance.</summary>
    public static readonly LoadContextSensitiveTypeComparer Instance = new();

    private LoadContextSensitiveTypeComparer()
    {
    }

    /// <inheritdoc/>
    public bool Equals(Type? x, Type? y)
    {
        if (ReferenceEquals(x, y))
        {
            return true;
        }

        if (x is null || y is null)
        {
            return false;
        }

        return TypeIdentityComparer.Instance.Equals(x, y) && SameAssemblyInstances(x, y);
    }

    /// <inheritdoc/>
    public int GetHashCode(Type obj) => TypeIdentityComparer.Instance.GetHashCode(obj);

    /// <summary>
    /// Walks two structurally identical types in parallel, requiring the same
    /// <see cref="System.Reflection.Assembly"/> instance at every position.
    /// </summary>
    /// <param name="x">The first type.</param>
    /// <param name="y">The second type, structurally equal to <paramref name="x"/>.</param>
    /// <returns><see langword="true"/> when both are built from the same assembly instances.</returns>
    private static bool SameAssemblyInstances(Type x, Type y)
    {
        if (ReferenceEquals(x, y))
        {
            return true;
        }

        if (!ReferenceEquals(x.Assembly, y.Assembly))
        {
            return false;
        }

        if (x.HasElementType && y.HasElementType)
        {
            Type? xElement = x.GetElementType();
            Type? yElement = y.GetElementType();
            if (xElement is not null && yElement is not null && !SameAssemblyInstances(xElement, yElement))
            {
                return false;
            }
        }

        // Structural equality already guarantees matching arity; the length
        // guard keeps this total for the pathological reflection shapes
        // (generic parameters, function pointers) that report otherwise.
        Type[] xArguments = x.GenericTypeArguments;
        Type[] yArguments = y.GenericTypeArguments;
        if (xArguments.Length != yArguments.Length)
        {
            return false;
        }

        for (int i = 0; i < xArguments.Length; i++)
        {
            if (!SameAssemblyInstances(xArguments[i], yArguments[i]))
            {
                return false;
            }
        }

        return true;
    }
}
