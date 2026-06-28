#nullable disable

// <copyright file="BoundClrStaticCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Represents a call to a CLR static method resolved at compile time via <see cref="MethodInfo"/>.
/// Used by synthesized code (state-machine bodies) where no user-facing symbol exists.
/// </summary>
#pragma warning disable CS1591
public sealed class BoundClrStaticCallExpression : BoundExpression
{
    public BoundClrStaticCallExpression(
        SyntaxNode syntax,
        MethodInfo method,
        TypeSymbol returnType,
        ImmutableArray<BoundExpression> arguments,
        ImmutableArray<RefKind> argumentRefKinds = default)
        : base(syntax)
    {
        Method = method;
        Type = returnType;
        Arguments = arguments;
        ArgumentRefKinds = argumentRefKinds.IsDefault ? default : argumentRefKinds;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ClrStaticCallExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>
    /// Gets the static CLR method to call.
    /// </summary>
    public MethodInfo Method { get; }

    /// <summary>
    /// Gets the provided arguments.
    /// </summary>
    public ImmutableArray<BoundExpression> Arguments { get; }

    /// <summary>
    /// Gets the per-argument ref-kind annotations. May be default (all-None).
    /// </summary>
    public ImmutableArray<RefKind> ArgumentRefKinds { get; }
}
