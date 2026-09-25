// <copyright file="MethodKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// What kind of function a <see cref="FunctionSymbol"/> is — the Roslyn
/// <c>MethodKind</c> analogue for the analyzer surface (ADR-0169, issue
/// #4436). The member names match Roslyn's so a migrated analyzer's
/// comparisons translate by name. G# constructors are
/// <see cref="ConstructorSymbol"/>s, not functions, so there is no
/// <c>Constructor</c> member.
/// </summary>
public enum MethodKind
{
    /// <summary>An ordinary declared function or method.</summary>
    Ordinary,

    /// <summary>A function literal (lambda).</summary>
    AnonymousFunction,

    /// <summary>A local function.</summary>
    LocalFunction,

    /// <summary>A property's getter.</summary>
    PropertyGet,

    /// <summary>A property's setter.</summary>
    PropertySet,

    /// <summary>A type's static-initialization context.</summary>
    StaticConstructor,
}
