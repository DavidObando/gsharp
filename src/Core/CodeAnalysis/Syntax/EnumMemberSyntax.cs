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
    // Backing fields for the properties the parser assigns after construction. Their setters
    // invalidate the node's cached span (issue #1675).
    private SyntaxToken payloadOpenParenthesis;
    private SeparatedSyntaxList<ParameterSyntax> payloadParameters;
    private SyntaxToken payloadCloseParenthesis;
    private SyntaxToken equalsToken;
    private ExpressionSyntax value;

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
    public SyntaxToken PayloadOpenParenthesis
    {
        get => payloadOpenParenthesis;
        internal set
        {
            payloadOpenParenthesis = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>
    /// Gets the optional primary-constructor parameter list for this enum
    /// case (ADR-0078 / issue #725). Empty when the case has no payload —
    /// inspect <see cref="HasPayload"/> to distinguish.
    /// </summary>
    public SeparatedSyntaxList<ParameterSyntax> PayloadParameters
    {
        get => payloadParameters;
        internal set
        {
            payloadParameters = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>
    /// Gets the closing parenthesis for the optional payload parameter list
    /// (ADR-0078 / issue #725). Null when the case has no payload.
    /// </summary>
    public SyntaxToken PayloadCloseParenthesis
    {
        get => payloadCloseParenthesis;
        internal set
        {
            payloadCloseParenthesis = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets a value indicating whether this case has a payload parameter list.</summary>
    public bool HasPayload => PayloadOpenParenthesis != null;

    /// <summary>
    /// Gets the <c>=</c> token for an explicit member value (issue #1912),
    /// e.g. <c>Banana = 2</c>. Null when the member has no explicit value.
    /// </summary>
    public SyntaxToken EqualsToken
    {
        get => equalsToken;
        internal set
        {
            equalsToken = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>
    /// Gets the explicit constant-value expression (issue #1912) following
    /// <see cref="EqualsToken"/>. Null when the member has no explicit value.
    /// </summary>
    public ExpressionSyntax Value
    {
        get => value;
        internal set
        {
            this.value = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets a value indicating whether this member has an explicit constant-value expression.</summary>
    public bool HasExplicitValue => EqualsToken != null;

    /// <summary>Attaches the given annotation list to this enum member and returns this same instance for fluent parser use.</summary>
    /// <param name="annotations">The annotation list to attach (may be empty).</param>
    /// <returns>This same <see cref="EnumMemberSyntax"/>, with <see cref="Annotations"/> updated.</returns>
    internal EnumMemberSyntax WithAnnotations(ImmutableArray<AnnotationSyntax> annotations)
    {
        Annotations = annotations.IsDefault ? ImmutableArray<AnnotationSyntax>.Empty : annotations;
        InvalidateCachedSpan();
        return this;
    }
}
