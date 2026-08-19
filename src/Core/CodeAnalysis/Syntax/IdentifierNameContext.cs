// <copyright file="IdentifierNameContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Identifies grammar positions where contextual G# spellings can consume an
/// otherwise ordinary identifier.
/// </summary>
[Flags]
public enum IdentifierNameContext
{
    /// <summary>Ordinary identifier position.</summary>
    General = 0,

    /// <summary>Function, constructor, receiver, or lambda parameter.</summary>
    Parameter = 1 << 0,

    /// <summary>Local declaration following <c>let</c>, <c>var</c>, or <c>const</c>.</summary>
    Local = 1 << 1,

    /// <summary>Generic type-parameter declaration.</summary>
    TypeParameter = 1 << 2,

    /// <summary>Bare invocation target.</summary>
    Invocation = 1 << 3,

    /// <summary>Pattern designation.</summary>
    Pattern = 1 << 4,

    /// <summary>Type-clause position.</summary>
    Type = 1 << 5,

    /// <summary>Bare index-expression receiver.</summary>
    Index = 1 << 6,
}
