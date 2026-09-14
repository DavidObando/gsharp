// <copyright file="StructLiteralExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Represents a struct composite literal: <c>Point{X: 1, Y: 2}</c> (Phase 3.B.1).
/// ADR-0180: <see cref="Elements"/> may also interleave bare content elements
/// and non-leading <c>...source</c> content spreads with the
/// <c>Field: value</c> members, e.g.
/// <c>Container{ Width: 320.0, Text("Account"), ...rows }</c>.
/// </summary>
public sealed class StructLiteralExpressionSyntax : ExpressionSyntax
{
    // Backing field for the property the parser assigns after construction. Its setter
    // invalidates the node's cached span (issue #1675).
    private TypeArgumentListSyntax? typeArgumentList;

    // ADR-0180: lazily computed, filtered view of Elements exposing only the
    // FieldInitializerSyntax members, for the many pre-existing binder paths
    // (ADR-0148 structural projection, imported-CLR-type/type-parameter
    // construction, generic type-argument inference) that only ever cared
    // about members and never need to see a content element or spread.
    private SeparatedSyntaxList<FieldInitializerSyntax>? cachedInitializers;

    /// <summary>
    /// Initializes a new instance of the <see cref="StructLiteralExpressionSyntax"/> class.
    /// </summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="typeIdentifier">The struct type identifier.</param>
    /// <param name="openParenToken">
    /// The optional explicit empty-parens marker's <c>(</c> (ADR-0180 §B): present only for the
    /// <c>Type(){ ...source, Member: value }</c> composite-with-leading-spread spelling, which
    /// disambiguates a leading content spread from ADR-0148's no-parens structural-projection spread.
    /// </param>
    /// <param name="closeParenToken">The matching <c>)</c>, present exactly when <paramref name="openParenToken"/> is.</param>
    /// <param name="openBraceToken">The opening brace.</param>
    /// <param name="spreadToken">The optional leading ellipsis (ADR-0148 structural spread; never set together with <paramref name="openParenToken"/>).</param>
    /// <param name="spreadExpression">The optional spread source.</param>
    /// <param name="spreadSeparatorToken">The optional separator after the spread source.</param>
    /// <param name="elements">The ordered field-initializer / content-element / content-spread elements (ADR-0180).</param>
    /// <param name="closeBraceToken">The closing brace.</param>
    public StructLiteralExpressionSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken typeIdentifier,
        SyntaxToken? openParenToken,
        SyntaxToken? closeParenToken,
        SyntaxToken openBraceToken,
        SyntaxToken? spreadToken,
        ExpressionSyntax? spreadExpression,
        SyntaxToken? spreadSeparatorToken,
        SeparatedSyntaxList<StructLiteralElementSyntax> elements,
        SyntaxToken closeBraceToken)
        : base(syntaxTree)
    {
        TypeIdentifier = typeIdentifier;
        OpenParenToken = openParenToken;
        CloseParenToken = closeParenToken;
        OpenBraceToken = openBraceToken;
        SpreadToken = spreadToken;
        SpreadExpression = spreadExpression;
        SpreadSeparatorToken = spreadSeparatorToken;
        Elements = elements;
        CloseBraceToken = closeBraceToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.StructLiteralExpression;

    /// <summary>Gets the struct type identifier.</summary>
    public SyntaxToken TypeIdentifier { get; }

    /// <summary>Gets the optional explicit empty-parens marker's <c>(</c> (ADR-0180 §B). See the constructor's remarks.</summary>
    public SyntaxToken? OpenParenToken { get; }

    /// <summary>Gets the optional explicit empty-parens marker's <c>)</c> (ADR-0180 §B).</summary>
    public SyntaxToken? CloseParenToken { get; }

    /// <summary>Gets the opening brace.</summary>
    public SyntaxToken OpenBraceToken { get; }

    /// <summary>Gets the optional leading <c>...</c> token.</summary>
    public SyntaxToken? SpreadToken { get; }

    /// <summary>Gets the optional source expression whose public shape is projected.</summary>
    public ExpressionSyntax? SpreadExpression { get; }

    /// <summary>Gets the comma separating the spread from explicit overrides, when present.</summary>
    public SyntaxToken? SpreadSeparatorToken { get; }

    /// <summary>Gets the ordered field-initializer / content-element / content-spread elements (ADR-0180).</summary>
    public SeparatedSyntaxList<StructLiteralElementSyntax> Elements { get; }

    /// <summary>
    /// Gets the field initializers only, in source order, filtered out of
    /// <see cref="Elements"/> (ADR-0180). Ignored by <see cref="SyntaxNode.GetChildren"/>
    /// — <see cref="Elements"/> is the authoritative child list — so consumers that
    /// only care about members (ADR-0148 structural projection, imported-CLR-type
    /// and type-parameter construction, generic type-argument inference) can keep
    /// reading this exactly as before.
    /// </summary>
    [SyntaxChildIgnore]
    public SeparatedSyntaxList<FieldInitializerSyntax> Initializers
    {
        get
        {
            if (cachedInitializers != null)
            {
                return cachedInitializers;
            }

            // Reuse the REAL separator token that preceded each kept member in
            // Elements' own nodes-and-separators array, rather than
            // synthesizing a fresh comma — this keeps every token in the
            // filtered view an authentic token from the source (correct span
            // and text), even though the view is necessarily lossy about
            // which content elements sat between two kept members.
            var raw = Elements.GetWithSeparators();
            var builder = ImmutableArray.CreateBuilder<SyntaxNode>();
            for (var i = 0; i < raw.Length; i += 2)
            {
                if (raw[i] is not FieldInitializerSyntax memberInitializer)
                {
                    continue;
                }

                if (builder.Count > 0)
                {
                    builder.Add(raw[i - 1]);
                }

                builder.Add(memberInitializer);
            }

            var result = new SeparatedSyntaxList<FieldInitializerSyntax>(builder.ToImmutable());
            cachedInitializers = result;
            return result;
        }
    }

    /// <summary>Gets the closing brace.</summary>
    public SyntaxToken CloseBraceToken { get; }

    /// <summary>Gets or sets the optional type-argument list (Phase 4.3 / ADR-0020), e.g. <c>Result[int, string]{...}</c>. <c>null</c> for non-generic literals or for literals whose type arguments are to be inferred.</summary>
    public TypeArgumentListSyntax? TypeArgumentList
    {
        get => typeArgumentList;
        set
        {
            typeArgumentList = value;
            InvalidateCachedSpan();
        }
    }
}
