// <copyright file="TupleDeconstructionPatternSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// ADR-0185: a flat tuple-destructuring pattern occupying a single
/// arrow-lambda parameter slot — `(name1 T1, name2 T2, ...)`, e.g.
/// `((x string, y int)) -> g(x, y)`. Extends the existing
/// statement-position mechanism (`let (a, b) = e` /
/// `var (a, b) = e`, ADR-0032/ADR-0168, (cref:TupleDeconstructionStatementSyntax))
/// into parameter position.
/// @remarks Each (cref:Elements) entry is an ordinary (cref:ParameterSyntax)
/// carrying only an (cref:ParameterSyntax.Identifier) and a required
/// (cref:ParameterSyntax.Type) — no modifiers, default value, or
/// ellipsis. This deliberately keeps the grammar FLAT: an element can never
/// itself be a nested (cref:TupleDeconstructionPatternSyntax) (ADR-0185
/// open question 3 — retiring `__q{N}`, issue #4304, never needs a
/// nested pattern, and nesting is left for a future decision if ever needed).
/// The parser enforces this simply by never constructing one: an element's
/// type clause is parsed as an ordinary type, so a stray `(` in element
/// position fails as "expected identifier" rather than opening a nested
/// pattern.
///
/// A pattern with fewer than two elements parses cleanly (this node makes no
/// syntactic distinction) but is rejected at BIND time: G# has no 1-tuples
/// (mirroring the `(T)` grouping / stray tuple-element-name diagnostic
/// (cref:Parser).ParseTupleTypeClause already applies to the tuple
/// TYPE grammar), so a single-element destructuring pattern can never
/// correspond to a real tuple-typed argument.
partial class TupleDeconstructionPatternSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:TupleDeconstructionPatternSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param openParenToken The opening `(`.
    /// @param elements The comma-separated `name Type` elements.
    /// @param closeParenToken The closing `)`.
    init(
        syntaxTree SyntaxTree,
        openParenToken SyntaxToken,
        elements SeparatedSyntaxList[ParameterSyntax],
        closeParenToken SyntaxToken
    ) : base(syntaxTree) {
        OpenParenToken = openParenToken
        Elements = elements
        CloseParenToken = closeParenToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.TupleDeconstructionPattern

    /// Gets the opening parenthesis token.
    prop OpenParenToken SyntaxToken {
        get;
    }

    /// Gets the flat `name Type` elements.
    prop Elements SeparatedSyntaxList[ParameterSyntax] {
        get;
    }

    /// Gets the closing parenthesis token.
    prop CloseParenToken SyntaxToken {
        get;
    }
}
