#nullable disable

// <copyright file="TypeParameterSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// A single type parameter in a generic declaration, e.g. <c>T any</c> in
/// <c>func Map[T any, U any](…)</c> (Phase 4.1 / ADR-0020).
/// </summary>
public sealed class TypeParameterSyntax : SyntaxNode
{
    /// <summary>Initializes a new instance of the <see cref="TypeParameterSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="varianceModifier">Optional <c>in</c>/<c>out</c> variance contextual keyword (ADR-0021); only valid on interface type parameters.</param>
    /// <param name="identifier">The type-parameter identifier token (e.g. <c>T</c>).</param>
    /// <param name="constraint">Optional constraint identifier (e.g. <c>any</c>); when <c>null</c>, the parameter is unconstrained (treated as <c>any</c>).</param>
    public TypeParameterSyntax(SyntaxTree syntaxTree, SyntaxToken varianceModifier, SyntaxToken identifier, SyntaxToken constraint)
        : this(syntaxTree, varianceModifier, identifier, constraint, constraintTypeArgumentOpenBracketToken: null, constraintTypeArguments: default, constraintTypeArgumentCloseBracketToken: null)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="TypeParameterSyntax"/> class with an optional generic type-argument list on the interface constraint (ADR-0089 / issue #755).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="varianceModifier">Optional <c>in</c>/<c>out</c> variance contextual keyword.</param>
    /// <param name="identifier">The type-parameter identifier token.</param>
    /// <param name="constraint">Optional constraint identifier (e.g. <c>IAdd</c>).</param>
    /// <param name="constraintTypeArgumentOpenBracketToken">Optional opening <c>[</c> of the constraint's type-argument list.</param>
    /// <param name="constraintTypeArguments">Optional comma-separated list of type-argument clauses for the constraint (e.g. <c>[T]</c> in <c>IAdd[T]</c>).</param>
    /// <param name="constraintTypeArgumentCloseBracketToken">Optional closing <c>]</c> of the constraint's type-argument list.</param>
    public TypeParameterSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken varianceModifier,
        SyntaxToken identifier,
        SyntaxToken constraint,
        SyntaxToken constraintTypeArgumentOpenBracketToken,
        SeparatedSyntaxList<TypeClauseSyntax> constraintTypeArguments,
        SyntaxToken constraintTypeArgumentCloseBracketToken)
        : this(
            syntaxTree,
            varianceModifier,
            identifier,
            constraint,
            constraintTypeArgumentOpenBracketToken,
            constraintTypeArguments,
            constraintTypeArgumentCloseBracketToken,
            classConstraintKeyword: null,
            structConstraintKeyword: null,
            initConstraintKeyword: null,
            initConstraintOpenParenToken: null,
            initConstraintCloseParenToken: null)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="TypeParameterSyntax"/> class with optional <c>class</c> / <c>struct</c> / <c>init()</c> constraints (ADR-0097 / issue #775; constraint keyword renamed from <c>new()</c> to <c>init()</c> by issue #997).</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="varianceModifier">Optional variance contextual keyword.</param>
    /// <param name="identifier">The type-parameter identifier token.</param>
    /// <param name="constraint">Optional legacy constraint identifier (<c>any</c>, <c>comparable</c>, or a sealed-interface name).</param>
    /// <param name="constraintTypeArgumentOpenBracketToken">Optional opening <c>[</c> of the constraint's type-argument list.</param>
    /// <param name="constraintTypeArguments">Optional comma-separated list of type-argument clauses for the constraint.</param>
    /// <param name="constraintTypeArgumentCloseBracketToken">Optional closing <c>]</c> of the constraint's type-argument list.</param>
    /// <param name="classConstraintKeyword">Optional <c>class</c> keyword token (ADR-0097).</param>
    /// <param name="structConstraintKeyword">Optional <c>struct</c> keyword token (ADR-0097).</param>
    /// <param name="initConstraintKeyword">Optional <c>init</c> contextual keyword token (ADR-0097 / issue #997); when set, the parens MUST also be set.</param>
    /// <param name="initConstraintOpenParenToken">Optional <c>(</c> token of the <c>init()</c> constraint (issue #997).</param>
    /// <param name="initConstraintCloseParenToken">Optional <c>)</c> token of the <c>init()</c> constraint (issue #997).</param>
    public TypeParameterSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken varianceModifier,
        SyntaxToken identifier,
        SyntaxToken constraint,
        SyntaxToken constraintTypeArgumentOpenBracketToken,
        SeparatedSyntaxList<TypeClauseSyntax> constraintTypeArguments,
        SyntaxToken constraintTypeArgumentCloseBracketToken,
        SyntaxToken classConstraintKeyword,
        SyntaxToken structConstraintKeyword,
        SyntaxToken initConstraintKeyword,
        SyntaxToken initConstraintOpenParenToken,
        SyntaxToken initConstraintCloseParenToken)
        : base(syntaxTree)
    {
        VarianceModifier = varianceModifier;
        Identifier = identifier;
        Constraint = constraint;
        ConstraintTypeArgumentOpenBracketToken = constraintTypeArgumentOpenBracketToken;
        ConstraintTypeArguments = constraintTypeArguments;
        ConstraintTypeArgumentCloseBracketToken = constraintTypeArgumentCloseBracketToken;
        ClassConstraintKeyword = classConstraintKeyword;
        StructConstraintKeyword = structConstraintKeyword;
        InitConstraintKeyword = initConstraintKeyword;
        InitConstraintOpenParenToken = initConstraintOpenParenToken;
        InitConstraintCloseParenToken = initConstraintCloseParenToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.TypeParameter;

    /// <summary>Gets the optional variance modifier token (<c>in</c> / <c>out</c>); Phase 4.3 / ADR-0021.</summary>
    public SyntaxToken VarianceModifier { get; }

    /// <summary>Gets the type-parameter identifier token.</summary>
    public SyntaxToken Identifier { get; }

    /// <summary>Gets the optional constraint identifier token (e.g. <c>any</c>, <c>comparable</c>, or a sealed-interface name).</summary>
    public SyntaxToken Constraint { get; }

    /// <summary>Gets the optional opening <c>[</c> of the constraint's generic type-argument list (ADR-0089).</summary>
    public SyntaxToken ConstraintTypeArgumentOpenBracketToken { get; }

    /// <summary>Gets the optional generic type-argument list applied to the constraint (e.g. <c>[T]</c> in <c>IAdd[T]</c>). Empty/default when the constraint is a bare identifier (ADR-0089).</summary>
    public SeparatedSyntaxList<TypeClauseSyntax> ConstraintTypeArguments { get; }

    /// <summary>Gets the optional closing <c>]</c> of the constraint's generic type-argument list (ADR-0089).</summary>
    public SyntaxToken ConstraintTypeArgumentCloseBracketToken { get; }

    /// <summary>Gets the optional <c>class</c> keyword token introducing a reference-type constraint (ADR-0097 / issue #775).</summary>
    public SyntaxToken ClassConstraintKeyword { get; }

    /// <summary>Gets the optional <c>struct</c> keyword token introducing a non-nullable value-type constraint (ADR-0097 / issue #775).</summary>
    public SyntaxToken StructConstraintKeyword { get; }

    /// <summary>Gets the optional <c>init</c> contextual keyword token of an <c>init()</c> default-constructor constraint (ADR-0097 / issue #775; renamed from <c>new()</c> by issue #997).</summary>
    public SyntaxToken InitConstraintKeyword { get; }

    /// <summary>Gets the optional opening <c>(</c> of the <c>init()</c> constraint (issue #997).</summary>
    public SyntaxToken InitConstraintOpenParenToken { get; }

    /// <summary>Gets the optional closing <c>)</c> of the <c>init()</c> constraint (issue #997).</summary>
    public SyntaxToken InitConstraintCloseParenToken { get; }

    /// <summary>Gets a value indicating whether this type parameter carries a generic-instance constraint (ADR-0089).</summary>
    public bool HasConstraintTypeArguments => ConstraintTypeArgumentOpenBracketToken != null;

    /// <summary>Gets a value indicating whether this type parameter carries a <c>class</c> constraint (ADR-0097).</summary>
    public bool HasClassConstraint => ClassConstraintKeyword != null;

    /// <summary>Gets a value indicating whether this type parameter carries a <c>struct</c> constraint (ADR-0097).</summary>
    public bool HasStructConstraint => StructConstraintKeyword != null;

    /// <summary>Gets a value indicating whether this type parameter carries an <c>init()</c> constraint (ADR-0097 / issue #997).</summary>
    public bool HasInitConstraint => InitConstraintKeyword != null;
}
