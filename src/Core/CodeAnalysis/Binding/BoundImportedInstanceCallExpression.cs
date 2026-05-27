// <copyright file="BoundImportedInstanceCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound call expression for an instance method invoked on a value whose type
/// originates from a CLR <see cref="System.Type"/>.
/// </summary>
public sealed class BoundImportedInstanceCallExpression : BoundExpression
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundImportedInstanceCallExpression"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="receiver">The expression that produces the instance.</param>
    /// <param name="method">The <see cref="MethodInfo"/> to invoke.</param>
    /// <param name="returnType">The bound return type.</param>
    /// <param name="arguments">The provided arguments.</param>
    /// <param name="argumentRefKinds">Per-argument ref-kind annotations (default all-None).</param>
    public BoundImportedInstanceCallExpression(
        SyntaxNode syntax,
        BoundExpression receiver,
        MethodInfo method,
        TypeSymbol returnType,
        ImmutableArray<BoundExpression> arguments,
        ImmutableArray<RefKind> argumentRefKinds = default)
        : base(syntax)
    {
        Receiver = receiver;
        Method = method;
        Type = returnType;
        Arguments = arguments;
        ArgumentRefKinds = argumentRefKinds.IsDefault ? default : argumentRefKinds;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.ImportedInstanceCallExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type { get; }

    /// <summary>
    /// Gets the receiver expression.
    /// </summary>
    public BoundExpression Receiver { get; }

    /// <summary>
    /// Gets the method to invoke.
    /// </summary>
    public MethodInfo Method { get; }

    /// <summary>
    /// Gets the bound arguments.
    /// </summary>
    public ImmutableArray<BoundExpression> Arguments { get; }

    /// <summary>
    /// Gets the per-argument ref-kind annotations. May be default (all-None).
    /// </summary>
    public ImmutableArray<RefKind> ArgumentRefKinds { get; }
}
