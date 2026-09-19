// <copyright file="ParameterSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a parameter in the language.
/// </summary>
public sealed class ParameterSyntax : SyntaxNode
{
    // Backing fields for the properties the parser assigns after construction. Their setters
    // invalidate the node's cached span (issue #1675).
    private SyntaxToken? scopedModifier;
    private SyntaxToken? refKindModifier;
    private SyntaxToken? equalsToken;
    private ExpressionSyntax? defaultValue;

    /// <summary>
    /// Initializes a new instance of the <see cref="ParameterSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="identifier">The parameter identifier.</param>
    /// <param name="ellipsisToken">Optional <c>...</c> token preceding the type clause for variadic parameters (Phase 4.8).</param>
    /// <param name="type">The parameter type.</param>
    public ParameterSyntax(SyntaxTree syntaxTree, SyntaxToken identifier, SyntaxToken? ellipsisToken, TypeClauseSyntax? type)
        : base(syntaxTree)
    {
        Identifier = identifier;
        EllipsisToken = ellipsisToken;
        Type = type;
        Annotations = ImmutableArray<AnnotationSyntax>.Empty;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="ParameterSyntax"/> class for a non-variadic parameter.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="identifier">The parameter identifier.</param>
    /// <param name="type">The parameter type.</param>
    public ParameterSyntax(SyntaxTree syntaxTree, SyntaxToken identifier, TypeClauseSyntax? type)
        : this(syntaxTree, identifier, ellipsisToken: null, type)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="ParameterSyntax"/> class
    /// for a DESTRUCTURED arrow-lambda parameter (ADR-0185) — <c>Identifier</c>
    /// and <c>Type</c> are both <see langword="null"/> and
    /// <see cref="DeconstructionPattern"/> carries the
    /// <c>(name1 T1, name2 T2, ...)</c> pattern instead. Only
    /// <see cref="Parser.ParseLambdaParameter"/> ever constructs this shape
    /// (ADR-0185 Decision point 2: every OTHER surface that shares
    /// <c>Parser.Members.cs</c>'s <c>ParseParameter</c> — named functions,
    /// primary constructors, indexers, receiver clauses, <c>init</c>
    /// declarations, event payloads — never sees a null <see cref="Identifier"/>).
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="deconstructionPattern">The destructuring pattern this parameter binds.</param>
    public ParameterSyntax(SyntaxTree syntaxTree, TupleDeconstructionPatternSyntax deconstructionPattern)
        : base(syntaxTree)
    {
        Identifier = null;
        EllipsisToken = null;
        Type = null;
        DeconstructionPattern = deconstructionPattern;
        Annotations = ImmutableArray<AnnotationSyntax>.Empty;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.Parameter;

    /// <summary>
    /// Gets the Kotlin-style annotations (ADR-0047) attached to this parameter.
    /// Empty when the parameter has no <c>@</c> lead-ins. Populated by the
    /// parser via <see cref="WithAnnotations"/>.
    /// </summary>
    public ImmutableArray<AnnotationSyntax> Annotations { get; private set; }

    /// <summary>
    /// Gets the parameter identifier, or <see langword="null"/> for a
    /// destructured parameter (ADR-0185) — see <see cref="DeconstructionPattern"/>.
    /// Every non-lambda parameter production (<c>Parser.Members.cs</c>'s
    /// <c>ParseParameter</c>) always sets this; only a destructured
    /// arrow-lambda parameter leaves it null.
    /// </summary>
    public SyntaxToken? Identifier { get; }

    /// <summary>
    /// Gets the <c>(name1 T1, name2 T2, ...)</c> tuple-destructuring pattern
    /// (ADR-0185) this parameter binds, or <see langword="null"/> for an
    /// ordinary single-identifier parameter. Exactly one of
    /// <see cref="Identifier"/>/<see cref="DeconstructionPattern"/> is
    /// non-null. Only <see cref="Parser.ParseLambdaParameter"/> ever
    /// produces a non-null value here (ADR-0185 Decision point 2).
    /// </summary>
    public TupleDeconstructionPatternSyntax? DeconstructionPattern { get; }

    /// <summary>Gets a value indicating whether this is a destructured parameter (ADR-0185).</summary>
    public bool IsDestructured => DeconstructionPattern != null;

    /// <summary>Gets the optional <c>...</c> token marking the parameter as variadic (Phase 4.8).</summary>
    public SyntaxToken? EllipsisToken { get; }

    /// <summary>
    /// Gets the parameter type. Always <see langword="null"/> for a
    /// destructured parameter (ADR-0185) — see <see cref="DeconstructionPattern"/>.
    /// </summary>
    public TypeClauseSyntax? Type { get; }

    /// <summary>Gets a value indicating whether this is a variadic parameter (Phase 4.8).</summary>
    public bool IsVariadic => EllipsisToken != null;

    /// <summary>
    /// Gets or sets the optional <c>scoped</c> contextual modifier token (ADR-0058 / issue #376).
    /// When non-null, the parameter is <c>scoped</c> — its safe-to-escape scope is restricted to
    /// the current function body and the value may not be returned.
    /// Assigned by the parser; <c>null</c> otherwise.
    /// </summary>
    public SyntaxToken? ScopedModifier
    {
        get => scopedModifier;
        set
        {
            scopedModifier = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets a value indicating whether this parameter carries the <c>scoped</c> modifier (ADR-0058).</summary>
    public bool IsScoped => ScopedModifier != null;

    /// <summary>
    /// Gets or sets the ADR-0060 optional <c>ref</c>, <c>out</c>, or <c>in</c> contextual modifier preceding the parameter
    /// identifier. The modifier carries the CLR ref-kind contract for this parameter; it composes with
    /// <see cref="ScopedModifier"/> (which precedes it). Assigned by the parser; <c>null</c> otherwise.
    /// </summary>
    public SyntaxToken? RefKindModifier
    {
        get => refKindModifier;
        set
        {
            refKindModifier = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets a value indicating whether this parameter carries a <c>ref</c>/<c>out</c>/<c>in</c> modifier (ADR-0060).</summary>
    public bool HasRefKindModifier => RefKindModifier != null;

    /// <summary>
    /// Gets or sets the ADR-0063 <c>=</c> token preceding the default-value expression.
    /// When non-null the parameter declares a default value, making it optional at call sites.
    /// </summary>
    public SyntaxToken? EqualsToken
    {
        get => equalsToken;
        set
        {
            equalsToken = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>
    /// Gets or sets the ADR-0063 default-value expression for an optional parameter.
    /// Restricted by the binder to a compile-time constant representable in CLR
    /// parameter metadata (numeric/bool/char/string/enum constant, or <c>nil</c>
    /// for a nullable/reference? type).
    /// </summary>
    public ExpressionSyntax? DefaultValue
    {
        get => defaultValue;
        set
        {
            defaultValue = value;
            InvalidateCachedSpan();
        }
    }

    /// <summary>Gets a value indicating whether this parameter declares a default value (ADR-0063).</summary>
    public bool HasDefaultValue => EqualsToken != null && DefaultValue != null;

    /// <summary>Attaches the given annotation list to this parameter and returns this same instance for fluent parser use.</summary>
    /// <param name="annotations">The annotation list to attach (may be empty).</param>
    /// <returns>This same <see cref="ParameterSyntax"/>, with <see cref="Annotations"/> updated.</returns>
    internal ParameterSyntax WithAnnotations(ImmutableArray<AnnotationSyntax> annotations)
    {
        Annotations = annotations.IsDefault ? ImmutableArray<AnnotationSyntax>.Empty : annotations;
        InvalidateCachedSpan();
        return this;
    }
}
