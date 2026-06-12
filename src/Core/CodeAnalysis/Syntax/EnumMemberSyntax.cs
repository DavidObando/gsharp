// <copyright file="EnumMemberSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a member in a <c>enum Name { ... }</c> declaration.
/// </summary>
public sealed class EnumMemberSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="EnumMemberSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="identifier">The enum member identifier.</param>
    public EnumMemberSyntax(SyntaxTree syntaxTree, SyntaxToken identifier)
        : base(syntaxTree)
    {
        Annotations = ImmutableArray<AnnotationSyntax>.Empty;
        Identifier = identifier;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.EnumMember;

    /// <summary>
    /// Gets the Kotlin-style annotations (ADR-0047) attached to this enum
    /// member. Empty when no <c>@</c> lead-ins are present. Populated by the
    /// parser via <see cref="WithAnnotations"/> so existing constructor
    /// overloads do not need to be touched. Declared before
    /// <see cref="Identifier"/> so that <see cref="SyntaxNode.GetChildren"/>
    /// visits annotations first — keeping spans and first/last-token lookups
    /// stable.
    /// </summary>
    public ImmutableArray<AnnotationSyntax> Annotations { get; private set; }

    /// <summary>Gets the enum member identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>
    /// Gets the opening parenthesis for the optional payload parameter list
    /// (ADR-0078 / issue #725). Null when the case has no payload.
    /// </summary>
    public SyntaxToken PayloadOpenParenthesis { get; internal set; }

    /// <summary>
    /// Gets the optional primary-constructor parameter list for this enum
    /// case (ADR-0078 / issue #725). Empty when the case has no payload —
    /// inspect <see cref="HasPayload"/> to distinguish.
    /// </summary>
    public SeparatedSyntaxList<ParameterSyntax> PayloadParameters { get; internal set; }

    /// <summary>
    /// Gets the closing parenthesis for the optional payload parameter list
    /// (ADR-0078 / issue #725). Null when the case has no payload.
    /// </summary>
    public SyntaxToken PayloadCloseParenthesis { get; internal set; }

    /// <summary>Gets a value indicating whether this case has a payload parameter list.</summary>
    public bool HasPayload => PayloadOpenParenthesis != null;

    /// <summary>Attaches the given annotation list to this enum member and returns this same instance for fluent parser use.</summary>
    /// <param name="annotations">The annotation list to attach (may be empty).</param>
    /// <returns>This same <see cref="EnumMemberSyntax"/>, with <see cref="Annotations"/> updated.</returns>
    internal EnumMemberSyntax WithAnnotations(ImmutableArray<AnnotationSyntax> annotations)
    {
        Annotations = annotations.IsDefault ? ImmutableArray<AnnotationSyntax>.Empty : annotations;
        return this;
    }
}
