// <copyright file="Issue2822LegalEnumerable.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Legal CLR shape with generic and non-generic zero-argument overloads.</summary>
public sealed class Issue2822LegalEnumerable
{
    /// <summary>Gets the pattern enumerator.</summary>
    public List<int>.Enumerator GetEnumerator() => new List<int>().GetEnumerator();

    /// <summary>Generic overload that must not participate in the enumeration pattern.</summary>
    public List<int>.Enumerator GetEnumerator<T>() => GetEnumerator();
}
