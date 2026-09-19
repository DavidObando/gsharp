// <copyright file="TupleDeconstructionPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// ADR-0185: a flat tuple-destructuring pattern occupying a single
/// arrow-lambda parameter slot — <c>(name1 T1, name2 T2, ...)</c>, e.g.
/// <c>((x string, y int)) -&gt; g(x, y)</c>. Extends the existing
/// statement-position mechanism (<c>let (a, b) = e</c> /
/// <c>var (a, b) = e</c>, ADR-0032/ADR-0168, <see cref="TupleDeconstructionStatementSyntax"/>)
/// into parameter position.
/// </summary>
/// <remarks>
/// <para>
/// Each <see cref="Elements"/> entry is an ordinary <see cref="ParameterSyntax"/>
/// carrying only an <see cref="ParameterSyntax.Identifier"/> and a required
/// <see cref="ParameterSyntax.Type"/> — no modifiers, default value, or
/// ellipsis. This deliberately keeps the grammar FLAT: an element can never
/// itself be a nested <see cref="TupleDeconstructionPatternSyntax"/> (ADR-0185
/// open question 3 — retiring <c>__q{N}</c>, issue #4304, never needs a
/// nested pattern, and nesting is left for a future decision if ever needed).
/// The parser enforces this simply by never constructing one: an element's
/// type clause is parsed as an ordinary type, so a stray <c>(</c> in element
/// position fails as "expected identifier" rather than opening a nested
/// pattern.
/// </para>
/// <para>
/// A pattern with fewer than two elements parses cleanly (this node makes no
/// syntactic distinction) but is rejected at BIND time: G# has no 1-tuples
/// (mirroring the <c>(T)</c> grouping / stray tuple-element-name diagnostic
/// <see cref="Parser"/>.ParseTupleTypeClause already applies to the tuple
/// TYPE grammar), so a single-element destructuring pattern can never
/// correspond to a real tuple-typed argument.
/// </para>
/// </remarks>
public sealed class TupleDeconstructionPatternSyntax : SyntaxNode
{
    /// <summary>Initializes a new instance of the <see cref="TupleDeconstructionPatternSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="openParenToken">The opening <c>(</c>.</param>
    /// <param name="elements">The comma-separated <c>name Type</c> elements.</param>
    /// <param name="closeParenToken">The closing <c>)</c>.</param>
    public TupleDeconstructionPatternSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken openParenToken,
        SeparatedSyntaxList<ParameterSyntax> elements,
        SyntaxToken closeParenToken)
        : base(syntaxTree)
    {
        OpenParenToken = openParenToken;
        Elements = elements;
        CloseParenToken = closeParenToken;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.TupleDeconstructionPattern;

    /// <summary>Gets the opening parenthesis token.</summary>
    public SyntaxToken OpenParenToken { get; }

    /// <summary>Gets the flat <c>name Type</c> elements.</summary>
    public SeparatedSyntaxList<ParameterSyntax> Elements { get; }

    /// <summary>Gets the closing parenthesis token.</summary>
    public SyntaxToken CloseParenToken { get; }
}
