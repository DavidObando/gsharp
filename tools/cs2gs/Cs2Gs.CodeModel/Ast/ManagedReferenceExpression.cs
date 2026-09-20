// <copyright file="ManagedReferenceExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace Cs2Gs.CodeModel.Ast;

/// <summary>An address intrinsic, not a readonly operator on arbitrary values.</summary>
public sealed class ManagedReferenceExpression : GExpression
{
    /// <summary>Initializes a new instance of the <see cref="ManagedReferenceExpression"/> class.</summary>
    /// <param name="location">The addressable location to retain.</param>
    /// <param name="isReadOnly">Whether the retained location is readonly.</param>
    public ManagedReferenceExpression(GExpression location, bool isReadOnly = false)
    {
        Location = location;
        IsReadOnly = isReadOnly;
    }

    /// <summary>Gets the addressable location expression.</summary>
    public GExpression Location { get; }

    /// <summary>Gets a value indicating whether the retained location is readonly.</summary>
    public bool IsReadOnly { get; }
}
