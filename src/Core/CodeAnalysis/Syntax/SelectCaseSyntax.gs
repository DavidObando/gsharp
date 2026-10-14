// <copyright file="SelectCaseSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

/// Discriminates the four arm shapes a `select` case can take
/// (Phase 5.6 / ADR-0022).
enum SelectCaseKind {
    ReceiveDiscard,
    ReceiveBind,
    Send,
    Default,
    AwaitBind,
    AwaitDiscard,
    Cancelled
}

/// A single arm of a `select` statement.
class SelectCaseSyntax : SyntaxNode {
    /// Initializes a new instance of the (cref:SelectCaseSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param keyword The `case` or `default` keyword.
    /// @param caseKind Which arm shape this is.
    /// @param identifier For (cref:SelectCaseKind.ReceiveBind): the identifier being declared. Null
    /// otherwise.
    /// @param channel Channel expression for send/receive arms. Null for default.
    /// @param value Value expression for send arms. Null otherwise.
    /// @param body The case body block.
    convenience init(
        syntaxTree SyntaxTree,
        keyword SyntaxToken,
        caseKind SelectCaseKind,
        identifier SyntaxToken?,
        channel ExpressionSyntax?,
        value ExpressionSyntax?,
        body BlockStatementSyntax
    ) {
        init(syntaxTree, keyword, caseKind, identifier, channel, value, nil, nil, body)
    }

    /// Initializes a new instance of the (cref:SelectCaseSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param keyword The `case` or `default` keyword.
    /// @param caseKind Which arm shape this is.
    /// @param identifier For a binding arm: the identifier being declared. Null otherwise.
    /// @param channel The channel, selectable or task operand. Null for default and cancelled arms.
    /// @param value Value expression for send arms. Null otherwise.
    /// @param whenKeyword The `when` keyword of an arm guard (ADR-0174 D8), or null.
    /// @param guard The arm guard's condition, or null.
    /// @param body The case body block.
    init(
        syntaxTree SyntaxTree,
        keyword SyntaxToken,
        caseKind SelectCaseKind,
        identifier SyntaxToken?,
        channel ExpressionSyntax?,
        value ExpressionSyntax?,
        whenKeyword SyntaxToken?,
        $guard ExpressionSyntax?,
        body BlockStatementSyntax
    ) : base(syntaxTree) {
        Keyword = keyword
        CaseKind = caseKind
        Identifier = identifier
        Channel = channel
        Value = value
        WhenKeyword = whenKeyword
        Guard = $guard
        Body = body
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.SelectCase

    /// Gets the `case` or `default` keyword.
    prop Keyword SyntaxToken {
        get;
    }

    /// Gets the kind of arm.
    prop CaseKind SelectCaseKind {
        get;
    }

    /// Gets the identifier declared by `case v := <-ch`; null otherwise.
    prop Identifier SyntaxToken? {
        get;
    }

    /// Gets the channel expression for send/receive arms; null for `default`.
    prop Channel ExpressionSyntax? {
        get;
    }

    /// Gets the value expression for send arms; null otherwise.
    prop Value ExpressionSyntax? {
        get;
    }

    /// Gets the `when` keyword of the arm's guard (ADR-0174 D8); null when
    /// the arm has no guard.
    prop WhenKeyword SyntaxToken? {
        get;
    }

    /// Gets the arm's `when` guard (ADR-0174 D8); null when the arm has
    /// none. A false guard keeps the arm out of the select entirely, which is
    /// how G# spells Go's nil-channel trick.
    prop Guard ExpressionSyntax? {
        get;
    }

    /// Gets the case body block.
    prop Body BlockStatementSyntax {
        get;
    }

    /// Gets a value indicating whether this is the `default` arm.
    prop IsDefault bool -> CaseKind == SelectCaseKind.Default
}
