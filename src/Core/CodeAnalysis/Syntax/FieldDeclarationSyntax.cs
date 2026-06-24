// <copyright file="FieldDeclarationSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a field declaration inside a struct (Phase 3.B.1).
/// </summary>
public sealed class FieldDeclarationSyntax : SyntaxNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="FieldDeclarationSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="accessibilityModifier">The optional accessibility modifier.</param>
    /// <param name="varOrLetKeyword">The required <c>var</c> or <c>let</c> binding keyword (ADR-0067). May be <c>null</c> only for parser error-recovery sites where the keyword was omitted; the parser also emits a diagnostic in that case.</param>
    /// <param name="identifier">The field identifier.</param>
    /// <param name="type">The field type clause.</param>
    /// <param name="equalsToken">The optional <c>=</c> token preceding the initializer.</param>
    /// <param name="initializer">The optional initializer expression.</param>
    public FieldDeclarationSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken accessibilityModifier,
        SyntaxToken varOrLetKeyword,
        SyntaxToken identifier,
        TypeClauseSyntax type,
        SyntaxToken equalsToken = null,
        ExpressionSyntax initializer = null)
        : base(syntaxTree)
    {
        Annotations = ImmutableArray<AnnotationSyntax>.Empty;
        AccessibilityModifier = accessibilityModifier;
        VarOrLetKeyword = varOrLetKeyword;
        Identifier = identifier;
        Type = type;
        EqualsToken = equalsToken;
        Initializer = initializer;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.FieldDeclaration;

    /// <summary>
    /// Gets the Kotlin-style annotations (ADR-0047) attached to this field
    /// declaration. Empty when no <c>@</c> lead-ins are present. Populated by
    /// the parser via <see cref="WithAnnotations"/> so existing constructor
    /// overloads do not need to be touched. Declared before
    /// <see cref="AccessibilityModifier"/> so that
    /// <see cref="SyntaxNode.GetChildren"/> visits annotations first —
    /// keeping spans and first/last-token lookups stable.
    /// </summary>
    public ImmutableArray<AnnotationSyntax> Annotations { get; private set; }

    /// <summary>Gets the optional accessibility modifier token.</summary>
    public SyntaxToken AccessibilityModifier { get; }

    /// <summary>
    /// Gets the required <c>var</c> or <c>let</c> binding keyword (ADR-0067).
    /// A <c>let</c> keyword marks the field as read-only (CLR <c>initonly</c>); a
    /// <c>var</c> keyword marks it as mutable. May be <c>null</c> only when the
    /// parser is recovering from a missing keyword and has already reported a
    /// diagnostic at the field's position.
    /// </summary>
    public SyntaxToken VarOrLetKeyword { get; }

    /// <summary>
    /// Gets a value indicating whether this field was declared with the
    /// <c>let</c> keyword and is therefore read-only (ADR-0067). A
    /// <c>const</c> field (Issue #948) is also read-only; see
    /// <see cref="IsConst"/>.
    /// </summary>
    public bool IsReadOnly => VarOrLetKeyword != null
        && (VarOrLetKeyword.Kind == SyntaxKind.LetKeyword || VarOrLetKeyword.Kind == SyntaxKind.ConstKeyword);

    /// <summary>
    /// Gets a value indicating whether this field was declared with the
    /// <c>const</c> keyword (Issue #948) and is therefore a compile-time
    /// constant: implicitly static, read-only, and emitted as a literal
    /// field whose initializer must be a constant expression.
    /// </summary>
    public bool IsConst => VarOrLetKeyword != null && VarOrLetKeyword.Kind == SyntaxKind.ConstKeyword;

    /// <summary>Gets the field identifier.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the field type clause.</summary>
    public TypeClauseSyntax Type { get; }

    /// <summary>Gets the optional <c>=</c> token preceding the initializer (Issue #262).</summary>
    public SyntaxToken EqualsToken { get; }

    /// <summary>Gets the optional initializer expression (Issue #262).</summary>
    public ExpressionSyntax Initializer { get; }

    /// <summary>
    /// Gets the <c>fixed</c> contextual keyword token for a fixed-size buffer
    /// field <c>fixed name [N]T</c> (ADR-0122 §10 / issue #1035), or
    /// <c>null</c> for an ordinary field.
    /// </summary>
    public SyntaxToken FixedKeyword { get; private set; }

    /// <summary>Gets a value indicating whether this declaration is a fixed-size buffer field (ADR-0122 §10 / issue #1035).</summary>
    public bool IsFixedBuffer => FixedKeyword != null;

    /// <summary>Marks this field declaration as a fixed-size buffer and records its <c>fixed</c> keyword token.</summary>
    /// <param name="fixedKeyword">The <c>fixed</c> contextual keyword token.</param>
    /// <returns>This same <see cref="FieldDeclarationSyntax"/> for fluent parser use.</returns>
    internal FieldDeclarationSyntax WithFixedBuffer(SyntaxToken fixedKeyword)
    {
        FixedKeyword = fixedKeyword;
        return this;
    }

    /// <summary>Attaches the given annotation list to this field declaration and returns this same instance for fluent parser use.</summary>
    /// <param name="annotations">The annotation list to attach (may be empty).</param>
    /// <returns>This same <see cref="FieldDeclarationSyntax"/>, with <see cref="Annotations"/> updated.</returns>
    internal FieldDeclarationSyntax WithAnnotations(ImmutableArray<AnnotationSyntax> annotations)
    {
        Annotations = annotations.IsDefault ? ImmutableArray<AnnotationSyntax>.Empty : annotations;
        return this;
    }
}
