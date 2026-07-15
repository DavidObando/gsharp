// <copyright file="EventDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents an <c>event Name Type</c> declaration inside a type body (ADR-0052).
/// </summary>
public sealed class EventDeclarationSyntax : SyntaxNode
{
    // Backing fields for the properties the parser assigns after construction. Their setters
    // invalidate the node's cached span (issue #1675).
    private SyntaxToken explicitInterfaceOpenParenToken;
    private TypeClauseSyntax explicitInterfaceType;
    private SyntaxToken explicitInterfaceCloseParenToken;

    /// <summary>
    /// Initializes a new instance of the <see cref="EventDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="openModifier">The optional <c>open</c> contextual keyword.</param>
    /// <param name="overrideModifier">The optional <c>override</c> contextual keyword.</param>
    /// <param name="eventKeyword">The identifier token whose text is <c>event</c>.</param>
    /// <param name="identifier">The event name.</param>
    /// <param name="type">The event handler type clause.</param>
    /// <param name="openBraceToken">The optional opening brace.</param>
    /// <param name="accessors">The add/remove accessor list.</param>
    /// <param name="closeBraceToken">The optional closing brace.</param>
    public EventDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken openModifier,
        SyntaxToken overrideModifier,
        SyntaxToken eventKeyword,
        SyntaxToken identifier,
        TypeClauseSyntax type,
        SyntaxToken openBraceToken,
        ImmutableArray<EventAccessorSyntax> accessors,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        Annotations = ImmutableArray<AnnotationSyntax>.Empty;
        AccessibilityModifier = accessibilityModifier;
        OpenModifier = openModifier;
        OverrideModifier = overrideModifier;
        EventKeyword = eventKeyword;
        Identifier = identifier;
        Type = type;
        OpenBraceToken = openBraceToken;
        Accessors = accessors;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.EventDeclaration;

    /// <summary>
    /// Gets the Kotlin-style annotations (ADR-0047) attached to this event declaration.
    /// Empty when no <c>@</c> lead-ins are present.
    /// </summary>
    public ImmutableArray<AnnotationSyntax> Annotations { get; private set; }

    /// <summary>Gets the optional accessibility modifier token.</summary>
    public SyntaxToken AccessibilityModifier { get; }

    /// <summary>Gets the optional <c>open</c> contextual keyword.</summary>
    public SyntaxToken OpenModifier { get; }

    /// <summary>Gets the optional <c>override</c> contextual keyword.</summary>
    public SyntaxToken OverrideModifier { get; }

    /// <summary>Gets the identifier token whose text is <c>event</c>.</summary>
    public SyntaxToken EventKeyword { get; }

    /// <summary>Gets the event name identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the event handler type clause.</summary>
    public TypeClauseSyntax Type { get; }

    /// <summary>Gets the optional opening brace token.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the add/remove accessor list. Empty for field-like events.</summary>
    public ImmutableArray<EventAccessorSyntax> Accessors { get; }

    /// <summary>Gets the optional closing brace token.</summary>
    public SyntaxToken CloseBraceToken { get; }

    /// <summary>
    /// Gets or sets the optional open parenthesis introducing a dedicated
    /// explicit-interface-implementation qualifier clause, e.g. <c>event (IFoo) Changed T</c>
    /// (ADR-0149). Assigned by the parser; <see langword="null"/> for an ordinary event.
    /// </summary>
    public SyntaxToken ExplicitInterfaceOpenParenthesisToken
    {
        get => explicitInterfaceOpenParenToken;
        set
        {
            explicitInterfaceOpenParenToken = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>
    /// Gets or sets the interface type referenced by the explicit-interface qualifier
    /// clause (ADR-0149). Assigned by the parser; <see langword="null"/> when no clause is present.
    /// </summary>
    public TypeClauseSyntax ExplicitInterfaceType
    {
        get => explicitInterfaceType;
        set
        {
            explicitInterfaceType = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets or sets the optional close parenthesis terminating the explicit-interface qualifier clause (ADR-0149).</summary>
    public SyntaxToken ExplicitInterfaceCloseParenthesisToken
    {
        get => explicitInterfaceCloseParenToken;
        set
        {
            explicitInterfaceCloseParenToken = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets a value indicating whether this declaration carries an explicit-interface qualifier clause (ADR-0149).</summary>
    public bool HasExplicitInterfaceClause => ExplicitInterfaceType != null;

    /// <summary>Attaches the given annotation list to this event declaration and returns this same instance for fluent parser use.</summary>
    /// <param name="annotations">The annotation list to attach (may be empty).</param>
    /// <returns>This same <see cref="EventDeclarationSyntax"/>, with <see cref="Annotations"/> updated.</returns>
    internal EventDeclarationSyntax WithAnnotations(ImmutableArray<AnnotationSyntax> annotations)
    {
        Annotations = annotations.IsDefault ? ImmutableArray<AnnotationSyntax>.Empty : annotations;
        InvalidateCachedSpan();
        return this;
    }

    /// <summary>
    /// ADR-0149: attaches a parsed explicit-interface qualifier clause (or no-ops when
    /// <paramref name="type"/> is <see langword="null"/>). Returns this same instance for
    /// fluent parser use.
    /// </summary>
    /// <param name="openParen">The open parenthesis token, or <see langword="null"/> when no clause is present.</param>
    /// <param name="type">The interface type clause, or <see langword="null"/> when no clause is present.</param>
    /// <param name="closeParen">The close parenthesis token, or <see langword="null"/> when no clause is present.</param>
    /// <returns>This same <see cref="EventDeclarationSyntax"/>.</returns>
    internal EventDeclarationSyntax WithExplicitInterfaceClause(SyntaxToken openParen, TypeClauseSyntax type, SyntaxToken closeParen)
    {
        if (type == null)
        {
            return this;
        }

        ExplicitInterfaceOpenParenthesisToken = openParen;
        ExplicitInterfaceType = type;
        ExplicitInterfaceCloseParenthesisToken = closeParen;
        return this;
    }
}
