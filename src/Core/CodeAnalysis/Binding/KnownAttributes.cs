// <copyright file="KnownAttributes.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Type-identity recogniser for the closed set of compiler-recognised
/// attributes (ADR-0047 §6). All checks key off the resolved CLR
/// <see cref="System.Type"/> on a <see cref="BoundAttribute"/> rather
/// than a string name, so renaming an attribute type or shadowing it in
/// user code never breaks compiler semantics.
/// </summary>
internal static class KnownAttributes
{
    private static readonly HashSet<Type> ReservedForCompilerSet = new()
    {
        typeof(System.Runtime.CompilerServices.ExtensionAttribute),
        typeof(System.Runtime.CompilerServices.AsyncStateMachineAttribute),
        typeof(System.Runtime.CompilerServices.CompilerGeneratedAttribute),
        typeof(System.Runtime.CompilerServices.NullableAttribute),
        typeof(System.Runtime.CompilerServices.NullableContextAttribute),
    };

    /// <summary>
    /// Returns <c>true</c> when <paramref name="clrType"/> is one of the
    /// attributes ADR-0047 §6 reserves for compiler synthesis. Users
    /// must not write these in source.
    /// </summary>
    /// <param name="clrType">The resolved attribute CLR type, or <c>null</c>.</param>
    /// <returns><c>true</c> if the attribute is reserved for the compiler.</returns>
    public static bool IsReservedForCompiler(Type clrType)
    {
        return clrType != null && ReservedForCompilerSet.Contains(clrType);
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="attribute"/> is
    /// <see cref="System.ObsoleteAttribute"/>.
    /// </summary>
    /// <param name="attribute">A bound attribute application.</param>
    /// <returns><c>true</c> when the attribute is <c>[Obsolete]</c>.</returns>
    public static bool IsObsolete(BoundAttribute attribute)
    {
        return attribute?.AttributeType?.ClrType == typeof(System.ObsoleteAttribute);
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="clrType"/> is
    /// <see cref="System.Runtime.CompilerServices.EnumeratorCancellationAttribute"/>.
    /// Recognition is type-identity based (ADR-0047 §6 / ADR-0040): the
    /// resolved CLR type — not the source name — selects the behaviour, so a
    /// renamed or shadowed alias cannot bypass the validation rules.
    /// </summary>
    /// <param name="clrType">The resolved attribute CLR type, or <c>null</c>.</param>
    /// <returns><c>true</c> when the attribute is <c>[EnumeratorCancellation]</c>.</returns>
    public static bool IsEnumeratorCancellation(Type clrType)
    {
        return clrType == typeof(System.Runtime.CompilerServices.EnumeratorCancellationAttribute);
    }

    /// <summary>
    /// Returns <c>true</c> when <paramref name="attribute"/> is
    /// <see cref="System.Runtime.CompilerServices.EnumeratorCancellationAttribute"/>.
    /// </summary>
    /// <param name="attribute">A bound attribute application.</param>
    /// <returns><c>true</c> when the attribute is <c>[EnumeratorCancellation]</c>.</returns>
    public static bool IsEnumeratorCancellation(BoundAttribute attribute)
    {
        return IsEnumeratorCancellation(attribute?.AttributeType?.ClrType);
    }

    /// <summary>
    /// Returns the first <c>[EnumeratorCancellation]</c> attribute in
    /// <paramref name="attributes"/>, or <c>null</c> if none is present.
    /// </summary>
    /// <param name="attributes">The attribute list on a parameter symbol.</param>
    /// <returns>The matching attribute, or <c>null</c>.</returns>
    public static BoundAttribute FindEnumeratorCancellation(ImmutableArray<BoundAttribute> attributes)
    {
        if (attributes.IsDefaultOrEmpty)
        {
            return null;
        }

        foreach (var attr in attributes)
        {
            if (IsEnumeratorCancellation(attr))
            {
                return attr;
            }
        }

        return null;
    }

    /// <summary>
    /// Looks for an <c>[Obsolete]</c> attribute in <paramref name="attributes"/>
    /// and extracts its <c>message</c> and <c>isError</c> arguments.
    /// </summary>
    /// <param name="attributes">The attribute list on the symbol.</param>
    /// <param name="message">The optional user-supplied message, or <c>null</c>.</param>
    /// <param name="isError">Whether the attribute's <c>error</c> flag is set.</param>
    /// <returns><c>true</c> if any attribute in the list is <c>[Obsolete]</c>.</returns>
    public static bool TryGetObsolete(ImmutableArray<BoundAttribute> attributes, out string message, out bool isError)
    {
        message = null;
        isError = false;
        if (attributes.IsDefaultOrEmpty)
        {
            return false;
        }

        foreach (var attr in attributes)
        {
            if (!IsObsolete(attr))
            {
                continue;
            }

            if (!attr.PositionalArguments.IsDefaultOrEmpty)
            {
                if (attr.PositionalArguments.Length >= 1 && attr.PositionalArguments[0].Value is string s)
                {
                    message = s;
                }

                if (attr.PositionalArguments.Length >= 2 && attr.PositionalArguments[1].Value is bool b)
                {
                    isError = b;
                }
            }

            return true;
        }

        return false;
    }
}
