// <copyright file="TypeInfo.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// The result of a <see cref="SemanticModel.GetTypeInfo"/> query: the type of
/// an expression node, if it has one. Mirrors Roslyn's <c>TypeInfo</c> shape
/// (ADR-0169).
/// </summary>
/// <param name="Type">The expression's type, or <see langword="null"/> when the node is not a typed expression.</param>
public readonly record struct TypeInfo(TypeSymbol? Type)
{
    /// <summary>
    /// Gets an empty result.
    /// </summary>
    public static TypeInfo None => default;
}
