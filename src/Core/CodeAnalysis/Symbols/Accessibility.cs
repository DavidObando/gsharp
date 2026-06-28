#nullable disable

// <copyright file="Accessibility.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// CLR-visibility level recorded on top-level declarations
/// (functions, types, global variables). Default for top-level
/// declarations is <see cref="Public"/> per ADR-0014.
/// </summary>
public enum Accessibility
{
    /// <summary>Visible to any assembly.</summary>
    Public,

    /// <summary>Visible only to code in the same CLR assembly.</summary>
    Internal,

    /// <summary>Visible only within the declaring container (CLR type).</summary>
    Private,

    /// <summary>
    /// Issue #950: visible within the declaring type and within types that
    /// derive from it (their own bodies). Maps to CLR <c>family</c>
    /// accessibility. Only valid on members of inheritable (<c>open</c>)
    /// classes — a non-<c>open</c>/<c>struct</c>/sealed type cannot be derived
    /// from, so <c>protected</c> there is reported as a clean diagnostic.
    /// </summary>
    Protected,
}
