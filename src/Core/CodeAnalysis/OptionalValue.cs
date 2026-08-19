// <copyright file="OptionalValue.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// An optional constant value — the Roslyn <c>Optional&lt;object&gt;</c>
/// analogue used by <c>BoundExpression.ConstantValue</c> (ADR-0169), so
/// migrated analyzers' <c>HasValue</c>/<c>Value</c> idioms (including the
/// constant-null-literal check <c>HasValue &amp;&amp; Value == null</c>) carry
/// over verbatim.
/// </summary>
/// <param name="HasValue">Whether a compile-time constant exists.</param>
/// <param name="Value">The constant value; may be null for a constant null literal.</param>
public readonly record struct OptionalValue(bool HasValue, object? Value);
