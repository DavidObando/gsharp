// <copyright file="BoundAttribute.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// A bound attribute application — the result of resolving an
/// <see cref="AnnotationSyntax"/> against the declaring scope per
/// ADR-0047 §3.
/// </summary>
public sealed class BoundAttribute : BoundNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BoundAttribute"/> class.
    /// </summary>
    /// <param name="syntax">The originating syntax node.</param>
    /// <param name="attributeType">The resolved <see cref="System.Attribute"/>-derived type.</param>
    /// <param name="target">The use-site target (defaulted from declaration position when omitted).</param>
    /// <param name="positionalArguments">Positional constructor arguments in source order.</param>
    /// <param name="namedArguments">Named property/field arguments in source order.</param>
    public BoundAttribute(
        AnnotationSyntax syntax,
        TypeSymbol attributeType,
        AttributeTargetKind target,
        ImmutableArray<BoundAttributeArgument> positionalArguments,
        ImmutableArray<BoundAttributeArgument> namedArguments)
    {
        Syntax = syntax;
        AttributeType = attributeType;
        Target = target;
        PositionalArguments = positionalArguments;
        NamedArguments = namedArguments;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.Attribute;

    /// <summary>
    /// Gets the originating annotation syntax.
    /// </summary>
    public AnnotationSyntax Syntax { get; }

    /// <summary>
    /// Gets the resolved attribute type.
    /// </summary>
    public TypeSymbol AttributeType { get; }

    /// <summary>
    /// Gets the effective use-site target.
    /// </summary>
    public AttributeTargetKind Target { get; }

    /// <summary>
    /// Gets the bound positional arguments in source order.
    /// </summary>
    public ImmutableArray<BoundAttributeArgument> PositionalArguments { get; }

    /// <summary>
    /// Gets the bound named arguments in source order.
    /// </summary>
    public ImmutableArray<BoundAttributeArgument> NamedArguments { get; }
}
