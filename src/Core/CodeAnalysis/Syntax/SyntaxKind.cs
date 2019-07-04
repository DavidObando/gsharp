// <copyright file="SyntaxKind.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

// Disabling some warnings temporarily for fast iterations.
#pragma warning disable CS1591 // Missing XML comment for publicly visible type or member
#pragma warning disable SA1602 // Enumeration items should be documented

namespace GSharp.Core.CodeAnalysis.Syntax
{
    /// <summary>
    /// Represents a kind of syntax token in the language.
    /// </summary>
    public enum SyntaxKind
    {
        // Punctuation tokens
        BadToken,
        WhitespaceToken,
        EndOfFileToken,

        // Language tokens
        PlusToken,
        PlusEqualsToken,
        PlusPlusToken,
        MinusToken,
        MinusEqualsToken,
        MinusMinusToken,
        StarToken,
        StarEqualsToken,
        SlashToken,
        SlashEqualsToken,
        PercentToken,
        PercentEqualsToken,
        OpenParenthesisToken,
        CloseParenthesisToken,
        OpenSquareBracketToken,
        CloseSquareBracketToken,
        OpenBraceToken,
        CloseBraceToken,
        ColonToken,
        ColonEqualsToken,
        SemicolonToken,
        CommaToken,
        DotToken,
        EllipsisToken,
        HatToken,
        HatEqualsToken,
        AmpersandToken,
        AmpersandAmpersandToken,
        AmpersandEqualsToken,
        AmpersandHatToken,
        AmpersandHatEqualsToken,
        PipeToken,
        PipeEqualsToken,
        PipePipeToken,
        EqualsToken,
        EqualsEqualsToken,
        BangToken,
        BangEqualsToken,
        LessToken,
        LessOrEqualsToken,
        LeftArrowToken,
        ShiftLeftToken,
        ShiftLeftEqualsToken,
        GreaterToken,
        GreaterOrEqualsToken,
        ShiftRightToken,
        ShiftRightEqualsToken,

        // Built-in type tokens
        StringToken,
        NumberToken,

        // Identifier tokens
        IdentifierToken,

        // Reserved keywords
        BreakKeyword,
        CaseKeyword,
        ChanKeyword,
        ConstKeyword,
        ContinueKeyword,
        DefaultKeyword,
        DeferKeyword,
        ElseKeyword,
        FalseKeyword,
        FallthroughKeyword,
        ForKeyword,
        FuncKeyword,
        GoKeyword,
        GotoKeyword,
        IfKeyword,
        ImportKeyword,
        InterfaceKeyword,
        MapKeyword,
        PackageKeyword,
        RangeKeyword,
        ReturnKeyword,
        SelectKeyword,
        StructKeyword,
        SwitchKeyword,
        TrueKeyword,
        TypeKeyword,
        VarKeyword,

        // compilation
        CompilationUnit,
        GlobalStatement,
        ExpressionStatement,
        AssignmentExpression,
        UnaryExpression,
        BinaryExpression,
        ParenthesizedExpression,
        LiteralExpression,
        NameExpression,
        CallExpression,
        FunctionDeclaration,
        Parameter,
        TypeClause,
        BlockStatement,
        VariableDeclaration,
        IfStatement,
        ElseClause,
        ForInfiniteStatement,
        ForEllipsisStatement,
        BreakStatement,
        ContinueStatement,
        ReturnStatement,
    }
}

#pragma warning restore SA1602 // Enumeration items should be documented
#pragma warning restore CS1591 // Missing XML comment for publicly visible type or member
