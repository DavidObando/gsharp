// <copyright file="BoundMapDeleteExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound <c>delete(m, k)</c> built-in — removes key <c>k</c> from
/// map <c>m</c>. Returns void (Phase 3.A.4).
/// </summary>
public sealed class BoundMapDeleteExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundMapDeleteExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="map">The bound map expression.</param>
    /// <param name="key">The bound key expression.</param>
    public BoundMapDeleteExpression(SyntaxNode syntax, BoundExpression map, BoundExpression key)
        : base(syntax)
    {
        Map = map ?? throw new ArgumentNullException(nameof(map));
        Key = key ?? throw new ArgumentNullException(nameof(key));
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.MapDeleteExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => TypeSymbol.Void;

    /// <summary>Gets the bound map expression.</summary>
    public BoundExpression Map { get; }

    /// <summary>Gets the bound key expression.</summary>
    public BoundExpression Key { get; }
}
