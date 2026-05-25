// <copyright file="RefKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Describes the by-reference passing mode of a parameter or argument at a CLR call site.
/// </summary>
public enum RefKind
{
    /// <summary>No by-reference passing; the argument is passed by value.</summary>
    None,

    /// <summary>The parameter is <c>ref</c> — the argument must be an lvalue passed with <c>&amp;</c>.</summary>
    Ref,

    /// <summary>The parameter is <c>out</c> — the argument must be an lvalue passed with <c>&amp;</c>; need not be definitely assigned before the call.</summary>
    Out,

    /// <summary>The parameter is <c>in</c> (readonly ref) — the argument may be passed with <c>&amp;</c> or by value (emitter spills to temp).</summary>
    In,
}
