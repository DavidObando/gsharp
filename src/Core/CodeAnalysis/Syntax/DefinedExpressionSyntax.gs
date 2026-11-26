package GSharp.Core.CodeAnalysis.Syntax

/// Represents the compiler-only `@defined("NAME")` expression.
partial class DefinedExpressionSyntax : ExpressionSyntax {
    /// Creates a symbol query without ordinary function or attribute lookup.
    /// @param syntaxTree The owning tree.
    /// @param atToken The intrinsic prefix.
    /// @param identifier The intrinsic name.
    /// @param openParenthesis The opening delimiter.
    /// @param arguments The supplied arguments.
    /// @param closeParenthesis The closing delimiter.
    init(
        syntaxTree SyntaxTree,
        atToken SyntaxToken,
        identifier SyntaxToken,
        openParenthesis SyntaxToken,
        arguments SeparatedSyntaxList[ExpressionSyntax],
        closeParenthesis SyntaxToken
    ) : base(syntaxTree) {
        AtToken = atToken
        Identifier = identifier
        OpenParenthesis = openParenthesis
        Arguments = arguments
        CloseParenthesis = closeParenthesis
    }

    override prop Kind SyntaxKind -> SyntaxKind.DefinedExpression

    /// Gets the intrinsic prefix.
    prop AtToken SyntaxToken {
        get;
    }
    /// Gets the intrinsic name.
    prop Identifier SyntaxToken {
        get;
    }
    /// Gets the opening delimiter.
    prop OpenParenthesis SyntaxToken {
        get;
    }
    /// Gets the supplied arguments.
    prop Arguments SeparatedSyntaxList[ExpressionSyntax] {
        get;
    }
    /// Gets the closing delimiter.
    prop CloseParenthesis SyntaxToken {
        get;
    }
}
