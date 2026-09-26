// <copyright file="TypeSymbol.NullabilityFree.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <content>
/// ADR-0193 §3 (GSA0007): the audited, nullability-free conversion door.
/// </content>
public partial class TypeSymbol
{
    /// <summary>
    /// ADR-0193 §3: the named door for an audited, nullability-free
    /// conversion. It maps exactly as <see cref="FromClrType"/> does; the
    /// required <paramref name="reason"/> states why the type has no
    /// declaration nullability to lose. GSA0007 allows it anywhere, except
    /// when its argument is, within the same method, a signature accessor
    /// (<c>ReturnType</c>, <c>ParameterType</c>, <c>PropertyType</c>, …):
    /// those positions go through the funnel readers.
    /// </summary>
    /// <param name="clrType">The CLR type to map.</param>
    /// <param name="reason">Why no declaration nullability applies.</param>
    /// <returns>The corresponding <see cref="TypeSymbol"/>.</returns>
    [NullabilityFunnel]
    internal static TypeSymbol FromClrTypeWithoutNullability(Type? clrType, NullabilityFreeReason reason)
    {
        _ = reason;
        return FromClrType(clrType);
    }
}
