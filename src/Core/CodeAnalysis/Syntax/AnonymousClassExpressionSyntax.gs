// <copyright file="AnonymousClassExpressionSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System.Collections.Immutable

/// Represents an anonymous-object literal expression (ADR-0146, issue #2243).
/// The redesigned, Kotlin-flavoured shape supports four forms:
/// - `object { let Name = "David" }` — field members (types optional/inferred);
/// - `object : IFace { func f() { ... } }` — implementing an interface;
/// - `object : Base(args) { override func f() ... }` — extending an open base class;
/// - `data object { let Name = "David" }` — a value-semantics data object
/// (Equals/GetHashCode/ToString/Deconstruct/with).
/// Members are separated by newlines or semicolons (like the rest of the
/// language), never commas. Field, method, and event members are supported;
/// `init`/`deinit` are rejected.
class AnonymousClassExpressionSyntax : ExpressionSyntax {
    /// Initializes a new instance of the (cref:AnonymousClassExpressionSyntax) class.
    /// @param syntaxTree The parent syntax tree.
    /// @param dataKeyword The optional `data` contextual keyword.
    /// @param objectKeyword The `object` keyword.
    /// @param baseColonToken The optional `:` introducing a base/interface clause.
    /// @param baseTypeClause The optional first base/interface type clause.
    /// @param baseConstructorOpenParenthesisToken The optional base-constructor argument list open paren.
    /// @param baseConstructorArguments The optional base-constructor arguments.
    /// @param baseConstructorCloseParenthesisToken The optional base-constructor argument list close paren.
    /// @param additionalBaseTypeClauses The additional comma-separated interface clauses.
    /// @param openBraceToken The opening brace.
    /// @param members The ordered field / method / event members.
    /// @param closeBraceToken The closing brace.
    init(
        syntaxTree SyntaxTree,
        dataKeyword SyntaxToken?,
        objectKeyword SyntaxToken,
        baseColonToken SyntaxToken?,
        baseTypeClause TypeClauseSyntax?,
        baseConstructorOpenParenthesisToken SyntaxToken?,
        baseConstructorArguments SeparatedSyntaxList[ExpressionSyntax],
        baseConstructorCloseParenthesisToken SyntaxToken?,
        additionalBaseTypeClauses SeparatedSyntaxList[TypeClauseSyntax],
        openBraceToken SyntaxToken,
        members ImmutableArray[SyntaxNode],
        closeBraceToken SyntaxToken
    ) : base(syntaxTree) {
        syntaxTree.RecordAnonymousClassExpression()
        DataKeyword = dataKeyword
        ObjectKeyword = objectKeyword
        BaseColonToken = baseColonToken
        BaseTypeClause = baseTypeClause
        BaseConstructorOpenParenthesisToken = baseConstructorOpenParenthesisToken
        BaseConstructorArguments = baseConstructorArguments
        BaseConstructorCloseParenthesisToken = baseConstructorCloseParenthesisToken
        AdditionalBaseTypeClauses = additionalBaseTypeClauses
        OpenBraceToken = openBraceToken
        Members = members
        CloseBraceToken = closeBraceToken
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SyntaxKind -> SyntaxKind.AnonymousClassExpression

    /// Gets the optional `data` contextual keyword. Non-null for a `data object`.
    prop DataKeyword SyntaxToken? {
        get;
    }

    /// Gets the `object` keyword.
    prop ObjectKeyword SyntaxToken {
        get;
    }

    /// Gets the optional `:` token introducing the base/interface clause.
    prop BaseColonToken SyntaxToken? {
        get;
    }

    /// Gets the optional first base/interface type clause.
    prop BaseTypeClause TypeClauseSyntax? {
        get;
    }

    /// Gets the optional base-constructor argument list open paren.
    prop BaseConstructorOpenParenthesisToken SyntaxToken? {
        get;
    }

    /// Gets the optional base-constructor arguments.
    prop BaseConstructorArguments SeparatedSyntaxList[ExpressionSyntax] {
        get;
    }

    /// Gets the optional base-constructor argument list close paren.
    prop BaseConstructorCloseParenthesisToken SyntaxToken? {
        get;
    }

    /// Gets the additional comma-separated interface clauses.
    prop AdditionalBaseTypeClauses SeparatedSyntaxList[TypeClauseSyntax] {
        get;
    }

    /// Gets the opening brace.
    prop OpenBraceToken SyntaxToken {
        get;
    }

    /// Gets the ordered members. Each element is one of
    /// (cref:AnonymousClassMemberInitializerSyntax) (a field),
    /// (cref:FunctionDeclarationSyntax) (a method), or
    /// (cref:EventDeclarationSyntax) (an event). Source order is
    /// preserved so member spans stay stable.
    prop Members ImmutableArray[SyntaxNode] {
        get;
    }

    /// Gets a value indicating whether this is a `data object`.
    prop IsData bool -> DataKeyword != nil

    /// Gets a value indicating whether this literal carries a base-class or interface clause.
    prop HasBaseType bool -> BaseColonToken != nil

    /// Gets the closing brace.
    prop CloseBraceToken SyntaxToken {
        get;
    }
}
