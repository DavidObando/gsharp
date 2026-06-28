// <copyright file="Parser.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// The GSharp language parser.
/// </summary>

public partial class Parser
{

    private readonly SyntaxTree syntaxTree;
    private readonly ImmutableArray<SyntaxToken> tokens;

    /// <summary>
    /// Initializes a new instance of the <see cref="Parser"/> class.
    /// </summary>
    /// <param name="syntaxTree">The source syntax tree object.</param>
    public Parser(SyntaxTree syntaxTree)
    {
        var tokens = new List<SyntaxToken>();
        var docTokens = ImmutableArray.CreateBuilder<SyntaxToken>();

        var lexer = new Lexer(syntaxTree);
        SyntaxToken token;
        do
        {
            token = lexer.Lex();

            if (token.Kind == SyntaxKind.DocumentationCommentToken)
            {
                docTokens.Add(token);
            }
            else if (token.Kind != SyntaxKind.WhitespaceToken &&
                token.Kind != SyntaxKind.CommentToken &&
                token.Kind != SyntaxKind.BadToken)
            {
                tokens.Add(token);
            }
        }
        while (token.Kind != SyntaxKind.EndOfFileToken);

        this.syntaxTree = syntaxTree;
        this.tokens = tokens.ToImmutableArray();
        DocumentationTokens = docTokens.ToImmutable();
        Diagnostics.AddRange(lexer.Diagnostics);
    }

    private SyntaxToken Current => Peek(0);

    private MemberSyntax ParseFunctionDeclaration(SyntaxToken accessibilityModifier)
        => ParseFunctionDeclaration(accessibilityModifier, openModifier: null, overrideModifier: null, asyncModifier: null);

    private MemberSyntax ParseFunctionDeclaration(SyntaxToken accessibilityModifier, SyntaxToken openModifier, SyntaxToken overrideModifier)
        => ParseFunctionDeclaration(accessibilityModifier, openModifier, overrideModifier, asyncModifier: null);

    // Extracts the literal `LengthToken` for the constant-count literal form when
    // a parsed length expression turns out to be a lone numeric literal (so the
    // existing GS0115 count check and `[N]T{…}` path keep working even when the
    // length was parsed via the general expression path). Non-literal lengths
    // combined with a non-empty initializer are not a valid shape; the binder
    // reports the mismatch.
    private static SyntaxToken ToLengthLiteralToken(ExpressionSyntax lengthExpression)
        => lengthExpression is LiteralExpressionSyntax { LiteralToken: { Kind: SyntaxKind.NumberToken } token } ? token : null;

    private bool TryScanTypeClause(ref int pos) => TryScanTypeClause(ref pos, out _);
}
