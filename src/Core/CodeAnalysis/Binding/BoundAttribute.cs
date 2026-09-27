// <copyright file="BoundAttribute.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Emit;
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
    /// <param name="positionalArguments">Positional and colon-named constructor arguments in source order.</param>
    /// <param name="namedArguments">Named property/field arguments in source order.</param>
    public BoundAttribute(
        AnnotationSyntax syntax,
        TypeSymbol attributeType,
        AttributeTargetKind target,
        ImmutableArray<BoundAttributeArgument> positionalArguments,
        ImmutableArray<BoundAttributeArgument> namedArguments)
        : base(syntax)
    {
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
    // `base.Syntax` is nullable because a lowering pass can synthesise a bound
    // node with no source counterpart, but a BoundAttribute is only ever built
    // by the binder from a real annotation: the constructor's `syntax`
    // parameter is a non-nullable AnnotationSyntax.
    public new AnnotationSyntax Syntax => (AnnotationSyntax)base.Syntax!;

    /// <summary>
    /// Gets the resolved attribute type.
    /// </summary>
    public TypeSymbol AttributeType { get; }

    /// <summary>
    /// Gets the attribute's type — the Roslyn <c>AttributeData.AttributeClass</c>
    /// analogue (ADR-0169, issue #4436); the same symbol as
    /// <see cref="AttributeType"/>.
    /// </summary>
    public TypeSymbol? AttributeClass => AttributeType;

    /// <summary>
    /// Gets the effective use-site target.
    /// </summary>
    public AttributeTargetKind Target { get; }

    /// <summary>
    /// Gets the bound constructor arguments in source order.
    /// </summary>
    public ImmutableArray<BoundAttributeArgument> PositionalArguments { get; }

    /// <summary>
    /// Gets the bound named arguments in source order.
    /// </summary>
    public ImmutableArray<BoundAttributeArgument> NamedArguments { get; }

    /// <summary>
    /// Gets a constructor argument by its resolved parameter position/name.
    /// </summary>
    /// <param name="position">The zero-based constructor parameter position.</param>
    /// <param name="parameterName">The CLR constructor parameter name.</param>
    /// <returns>The supplied argument, or <see langword="null"/> when omitted.</returns>
    public BoundAttributeArgument? GetConstructorArgument(int position, string parameterName)
    {
        foreach (var argument in PositionalArguments)
        {
            if (string.Equals(argument.Name, parameterName, System.StringComparison.Ordinal)
                || string.Equals(
                    GetConstructorParameterMetadataName(argument),
                    parameterName,
                    System.StringComparison.Ordinal))
            {
                return argument;
            }
        }

        for (var sourceIndex = 0; sourceIndex < PositionalArguments.Length; sourceIndex++)
        {
            var argument = PositionalArguments[sourceIndex];
            if (argument.Name == null && sourceIndex == position)
            {
                return argument;
            }
        }

        return null;
    }

    /// <summary>
    /// Gets the CLR metadata name of the constructor parameter selected by a
    /// colon-named argument.
    /// </summary>
    /// <param name="argument">A constructor argument.</param>
    /// <returns>The CLR parameter name, or the bound name when no imported constructor matches.</returns>
    public string? GetConstructorParameterMetadataName(BoundAttributeArgument argument)
    {
        if (argument.Name is not { } argumentName || AttributeType.ClrType is not { } clrType)
        {
            return argument.Name;
        }

        var constructor = CustomAttributeEncoder.TryResolveImportedAttributeConstructor(
            clrType,
            this,
            out _,
            out _,
            out _);
        if (constructor == null)
        {
            return argumentName;
        }

        var parameters = constructor.GetParameters();
        foreach (var parameter in parameters)
        {
            if (string.Equals(argumentName, parameter.Name, System.StringComparison.Ordinal))
            {
                return parameter.Name;
            }
        }

        var parameterNames = parameters
            .Select(parameter => parameter.Name ?? string.Empty)
            .ToArray();
        foreach (var parameter in parameters)
        {
            var metadataName = parameter.Name ?? string.Empty;
            if (string.Equals(
                    argumentName,
                    SyntaxFacts.GetEmittedIdentifier(
                        metadataName,
                        IdentifierNameContext.Parameter,
                        parameterNames),
                    System.StringComparison.Ordinal))
            {
                return metadataName;
            }
        }

        return argumentName;
    }
}
