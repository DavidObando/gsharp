// <copyright file="SyntaxFacts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Utility functions related to the language syntax.
/// </summary>
public static class SyntaxFacts
{
    /// <summary>
    /// Gets the presendence for unary operators. A higher number indicates higher presendence.
    /// </summary>
    /// <param name="kind">The syntax kind to evaluate.</param>
    /// <returns>A number indicating the presendence.</returns>
    public static int GetUnaryOperatorPrecedence(this SyntaxKind kind)
    {
#pragma warning disable SA1025 // Code should not contain multiple whitespace in a row
        switch (kind)
        {
            case SyntaxKind.PlusToken:         // identity
            case SyntaxKind.MinusToken:        // negation
            case SyntaxKind.BangToken:         // logical negation
            case SyntaxKind.HatToken:          // one's complement
            case SyntaxKind.StarToken:         // dereference
            case SyntaxKind.AmpersandToken:    // reference of
            case SyntaxKind.LeftArrowToken:    // channel
                return 6;

            default:
                return 0;
        }
#pragma warning restore SA1025 // Code should not contain multiple whitespace in a row
    }

    /// <summary>
    /// Gets the presendence for binary operators. A higher number indicates higher presendence.
    /// </summary>
    /// <param name="kind">The syntax kind to evaluate.</param>
    /// <returns>A number indicating the presendence.</returns>
    public static int GetBinaryOperatorPrecedence(this SyntaxKind kind)
    {
#pragma warning disable SA1025 // Code should not contain multiple whitespace in a row
        switch (kind)
        {
            case SyntaxKind.StarToken:                   // product
            case SyntaxKind.SlashToken:                  // quotient
            case SyntaxKind.PercentToken:                // remainder
            case SyntaxKind.ShiftLeftToken:              // shift left
            case SyntaxKind.ShiftRightToken:             // shift right
            case SyntaxKind.UnsignedShiftRightToken:     // unsigned (logical) shift right
            case SyntaxKind.AmpersandToken:              // bitwise and
            case SyntaxKind.AmpersandHatToken:           // bit clear (and not)
                return 5;

            case SyntaxKind.PlusToken:                   // sum
            case SyntaxKind.MinusToken:                  // difference
            case SyntaxKind.PipeToken:                   // bitwise or
            case SyntaxKind.HatToken:                    // bitwise xor
                return 4;

            case SyntaxKind.EqualsEqualsToken:           // equals
            case SyntaxKind.BangEqualsToken:             // not equals
            case SyntaxKind.LessToken:                   // less than
            case SyntaxKind.LessOrEqualsToken:           // less or equals to
            case SyntaxKind.GreaterToken:                // greater than
            case SyntaxKind.GreaterOrEqualsToken:        // greater or equals to
                return 3;

            case SyntaxKind.AmpersandAmpersandToken:     // logical and
                return 2;

            case SyntaxKind.PipePipeToken:               // logical or
                return 1;

            default:

                // Issue #941: `??` null-coalescing is NOT handled by the
                // left-associative binary loop. It is parsed separately by
                // Parser.ParseNullCoalescingExpression so it can be
                // right-associative and sit at a precedence strictly below `||`.
                // Returning 0 here keeps the binary loop from consuming it.
                return 0;
        }
#pragma warning restore SA1025 // Code should not contain multiple whitespace in a row
    }

    /// <summary>
    /// If the given token is a compound assignment operator (e.g. <c>+=</c>),
    /// returns the underlying binary operator kind (e.g. <c>+</c>).
    /// </summary>
    /// <param name="kind">The candidate compound assignment token kind.</param>
    /// <param name="baseOperatorKind">The base binary operator kind, if any.</param>
    /// <returns><c>true</c> if the token is a compound assignment operator.</returns>
    public static bool TryGetCompoundAssignmentBaseOperator(SyntaxKind kind, out SyntaxKind baseOperatorKind)
    {
#pragma warning disable SA1025 // Code should not contain multiple whitespace in a row
        switch (kind)
        {
            case SyntaxKind.PlusEqualsToken:           baseOperatorKind = SyntaxKind.PlusToken; return true;
            case SyntaxKind.MinusEqualsToken:          baseOperatorKind = SyntaxKind.MinusToken; return true;
            case SyntaxKind.StarEqualsToken:           baseOperatorKind = SyntaxKind.StarToken; return true;
            case SyntaxKind.SlashEqualsToken:          baseOperatorKind = SyntaxKind.SlashToken; return true;
            case SyntaxKind.PercentEqualsToken:        baseOperatorKind = SyntaxKind.PercentToken; return true;
            case SyntaxKind.HatEqualsToken:            baseOperatorKind = SyntaxKind.HatToken; return true;
            case SyntaxKind.AmpersandEqualsToken:      baseOperatorKind = SyntaxKind.AmpersandToken; return true;
            case SyntaxKind.PipeEqualsToken:           baseOperatorKind = SyntaxKind.PipeToken; return true;
            case SyntaxKind.AmpersandHatEqualsToken:   baseOperatorKind = SyntaxKind.AmpersandHatToken; return true;
            case SyntaxKind.ShiftLeftEqualsToken:      baseOperatorKind = SyntaxKind.ShiftLeftToken; return true;
            case SyntaxKind.ShiftRightEqualsToken:     baseOperatorKind = SyntaxKind.ShiftRightToken; return true;
            case SyntaxKind.UnsignedShiftRightEqualsToken: baseOperatorKind = SyntaxKind.UnsignedShiftRightToken; return true;
            default:                                   baseOperatorKind = SyntaxKind.BadToken; return false;
        }
#pragma warning restore SA1025 // Code should not contain multiple whitespace in a row
    }

    /// <summary>
    /// Given a string, if it's a language keyword, this method will return
    /// the syntax kind for that keyword.
    /// </summary>
    /// <param name="text">The text to verify.</param>
    /// <returns>The syntax kind associated to the text.</returns>
    public static SyntaxKind GetKeywordKind(string text)
    {
        switch (text)
        {
            case "as":
                return SyntaxKind.AsKeyword;
            case "async":
                return SyntaxKind.AsyncKeyword;
            case "await":
                return SyntaxKind.AwaitKeyword;
            case "break":
                return SyntaxKind.BreakKeyword;
            case "case":
                return SyntaxKind.CaseKeyword;
            case "catch":
                return SyntaxKind.CatchKeyword;
            case "chan":
                return SyntaxKind.ChanKeyword;
            case "class":
                return SyntaxKind.ClassKeyword;
            case "const":
                return SyntaxKind.ConstKeyword;
            case "continue":
                return SyntaxKind.ContinueKeyword;
            case "default":
                return SyntaxKind.DefaultKeyword;
            case "defer":
                return SyntaxKind.DeferKeyword;
            case "do":
                return SyntaxKind.DoKeyword;
            case "else":
                return SyntaxKind.ElseKeyword;
            case "enum":
                return SyntaxKind.EnumKeyword;
            case "false":
                return SyntaxKind.FalseKeyword;
            case "fallthrough":
                return SyntaxKind.FallthroughKeyword;
            case "finally":
                return SyntaxKind.FinallyKeyword;
            case "for":
                return SyntaxKind.ForKeyword;
            case "func":
                return SyntaxKind.FuncKeyword;
            case "go":
                return SyntaxKind.GoKeyword;
            case "goto":
                return SyntaxKind.GotoKeyword;
            case "guard":
                return SyntaxKind.GuardKeyword;
            case "if":
                return SyntaxKind.IfKeyword;
            case "import":
                return SyntaxKind.ImportKeyword;
            case "interface":
                return SyntaxKind.InterfaceKeyword;
            case "internal":
                return SyntaxKind.InternalKeyword;
            case "is":
                return SyntaxKind.IsKeyword;
            case "let":
                return SyntaxKind.LetKeyword;
            case "map":
                return SyntaxKind.MapKeyword;
            case "nil":
                return SyntaxKind.NilKeyword;
            case "open":
                return SyntaxKind.OpenKeyword;
            case "operator":
                return SyntaxKind.OperatorKeyword;
            case "override":
                return SyntaxKind.OverrideKeyword;
            case "package":
                return SyntaxKind.PackageKeyword;
            case "private":
                return SyntaxKind.PrivateKeyword;
            case "protected":
                return SyntaxKind.ProtectedKeyword;
            case "public":
                return SyntaxKind.PublicKeyword;
            case "range":
                return SyntaxKind.RangeKeyword;
            case "return":
                return SyntaxKind.ReturnKeyword;
            case "scope":
                return SyntaxKind.ScopeKeyword;
            case "sealed":
                return SyntaxKind.SealedKeyword;
            case "select":
                return SyntaxKind.SelectKeyword;
            case "sequence":
                return SyntaxKind.SequenceKeyword;
            case "struct":
                return SyntaxKind.StructKeyword;
            case "switch":
                return SyntaxKind.SwitchKeyword;
            case "throw":
                return SyntaxKind.ThrowKeyword;
            case "true":
                return SyntaxKind.TrueKeyword;
            case "try":
                return SyntaxKind.TryKeyword;

            // Issue #3510: `type` is no longer a reserved keyword. The erased
            // type-alias declaration (`type Name = Target`) parses the
            // spelling contextually at member position, and `type` is usable
            // as an ordinary identifier everywhere else (so cs2gs no longer
            // sanitizes C# identifiers named `type`). Named delegates moved
            // to the standalone `delegate Name(params) R;` declaration.
            case "using":
                return SyntaxKind.UsingKeyword;
            case "var":
                return SyntaxKind.VarKeyword;
            case "while":
                return SyntaxKind.WhileKeyword;
            case "lock":
                return SyntaxKind.LockKeyword;
            default:
                return SyntaxKind.IdentifierToken;
        }
    }

    /// <summary>
    /// Determines whether a spelling is a hard G# keyword.
    /// </summary>
    /// <param name="text">The identifier spelling to inspect.</param>
    /// <returns><c>true</c> for hard keywords.</returns>
    public static bool IsReservedIdentifier(string text) =>
        IsReservedIdentifier(text, IdentifierNameContext.General);

    /// <summary>
    /// Determines whether a spelling is consumed by the grammar in a specific
    /// identifier context.
    /// </summary>
    /// <param name="text">The identifier spelling to inspect.</param>
    /// <param name="context">The emitted grammar contexts where the name is used.</param>
    /// <returns><c>true</c> when the spelling must be changed.</returns>
    public static bool IsReservedIdentifier(string text, IdentifierNameContext context)
    {
        if (GetKeywordKind(text) != SyntaxKind.IdentifierToken)
        {
            return true;
        }

        if ((context & IdentifierNameContext.Parameter) != 0
            && text is "params" or "scoped" or "ref" or "out" or "in")
        {
            return true;
        }

        if ((context & IdentifierNameContext.Local) != 0
            && text is "scoped" or "ref")
        {
            return true;
        }

        if ((context & IdentifierNameContext.TypeParameter) != 0
            && text is "in" or "out")
        {
            return true;
        }

        if ((context & IdentifierNameContext.Invocation) != 0
            && text is "typeof" or "sizeof" or "checked" or "unchecked" or "nameof" or "init")
        {
            return true;
        }

        if ((context & IdentifierNameContext.Pattern) != 0
            && text is "and" or "or" or "when" or "not")
        {
            return true;
        }

        if ((context & IdentifierNameContext.Index) != 0
            && text is "stackalloc" or "base")
        {
            return true;
        }

        return (context & IdentifierNameContext.Type) != 0
            && text is "event" or "prop" or "init" or "convenience" or "shared" or "delegate" or "unmanaged";
    }

    /// <summary>
    /// Produces a grammar-safe emitted spelling while preserving every legal
    /// source name in the same scope.
    /// </summary>
    /// <param name="name">The source identifier value.</param>
    /// <param name="context">The emitted grammar contexts where the name is used.</param>
    /// <param name="scopeNames">Source names occupying the same emitted scope.</param>
    /// <returns>The unchanged legal name, or a collision-free suffixed spelling.</returns>
    public static string GetEmittedIdentifier(
        string name,
        IdentifierNameContext context,
        IEnumerable<string>? scopeNames = null)
    {
        if (string.IsNullOrEmpty(name) || !IsReservedIdentifier(name, context))
        {
            return name;
        }

        HashSet<string>? occupied = scopeNames is null
            ? null
            : new HashSet<string>(scopeNames, StringComparer.Ordinal);
        string candidate = name + "_";
        while (occupied?.Contains(candidate) == true)
        {
            candidate += "_";
        }

        return candidate;
    }

    /// <summary>
    /// Determines whether a spelling is the unsupported C# variadic modifier.
    /// </summary>
    /// <param name="text">The token spelling to inspect.</param>
    /// <returns><c>true</c> for <c>params</c>.</returns>
    public static bool IsParamsKeyword(string text) => text == "params";

    /// <summary>
    /// Provides a list o all supported unary operators.
    /// </summary>
    /// <returns>An enumeration of sytax kinds that represent unary operators.</returns>
    public static IEnumerable<SyntaxKind> GetUnaryOperatorKinds()
    {
        var kinds = (SyntaxKind[])Enum.GetValues(typeof(SyntaxKind));
        foreach (var kind in kinds)
        {
            if (GetUnaryOperatorPrecedence(kind) > 0)
            {
                yield return kind;
            }
        }
    }

    /// <summary>
    /// Provides a list o all supported binary operators.
    /// </summary>
    /// <returns>An enumeration of sytax kinds that represent binary operators.</returns>
    public static IEnumerable<SyntaxKind> GetBinaryOperatorKinds()
    {
        var kinds = (SyntaxKind[])Enum.GetValues(typeof(SyntaxKind));
        foreach (var kind in kinds)
        {
            if (GetBinaryOperatorPrecedence(kind) > 0)
            {
                yield return kind;
            }
        }
    }

    /// <summary>
    /// Given a syntax kind token, provides the associated text representation.
    /// </summary>
    /// <param name="kind">The token syntax kind.</param>
    /// <returns>A string representing the token as defined by the language.</returns>
    public static string? GetText(SyntaxKind kind)
    {
        switch (kind)
        {
            case SyntaxKind.PlusToken:
                return "+";
            case SyntaxKind.PlusEqualsToken:
                return "+=";
            case SyntaxKind.PlusPlusToken:
                return "++";
            case SyntaxKind.MinusToken:
                return "-";
            case SyntaxKind.MinusEqualsToken:
                return "-=";
            case SyntaxKind.MinusMinusToken:
                return "--";
            case SyntaxKind.StarToken:
                return "*";
            case SyntaxKind.StarEqualsToken:
                return "*=";
            case SyntaxKind.SlashToken:
                return "/";
            case SyntaxKind.SlashEqualsToken:
                return "/=";
            case SyntaxKind.PercentToken:
                return "%";
            case SyntaxKind.PercentEqualsToken:
                return "%=";
            case SyntaxKind.OpenParenthesisToken:
                return "(";
            case SyntaxKind.CloseParenthesisToken:
                return ")";
            case SyntaxKind.OpenSquareBracketToken:
                return "[";
            case SyntaxKind.CloseSquareBracketToken:
                return "]";
            case SyntaxKind.OpenBraceToken:
                return "{";
            case SyntaxKind.CloseBraceToken:
                return "}";
            case SyntaxKind.ColonToken:
                return ":";
            case SyntaxKind.ColonEqualsToken:
                return ":=";
            case SyntaxKind.SemicolonToken:
                return ";";
            case SyntaxKind.CommaToken:
                return ",";
            case SyntaxKind.DotToken:
                return ".";
            case SyntaxKind.DotDotToken:
                return "..";
            case SyntaxKind.EllipsisToken:
                return "...";
            case SyntaxKind.HatToken:
                return "^";
            case SyntaxKind.HatEqualsToken:
                return "^=";
            case SyntaxKind.AmpersandToken:
                return "&";
            case SyntaxKind.AmpersandAmpersandToken:
                return "&&";
            case SyntaxKind.AmpersandEqualsToken:
                return "&=";
            case SyntaxKind.AmpersandHatToken:
                return "&^";
            case SyntaxKind.AmpersandHatEqualsToken:
                return "&^=";
            case SyntaxKind.PipeToken:
                return "|";
            case SyntaxKind.PipeEqualsToken:
                return "|=";
            case SyntaxKind.PipePipeToken:
                return "||";
            case SyntaxKind.EqualsToken:
                return "=";
            case SyntaxKind.EqualsEqualsToken:
                return "==";
            case SyntaxKind.BangToken:
                return "!";
            case SyntaxKind.BangEqualsToken:
                return "!=";
            case SyntaxKind.BangBangToken:
                return "!!";
            case SyntaxKind.QuestionToken:
                return "?";
            case SyntaxKind.QuestionDotToken:
                return "?.";
            case SyntaxKind.QuestionQuestionToken:
                return "??";
            case SyntaxKind.QuestionQuestionEqualsToken:
                return "??=";
            case SyntaxKind.QuestionOpenBracketToken:
                return "?[";
            case SyntaxKind.LessToken:
                return "<";
            case SyntaxKind.LessOrEqualsToken:
                return "<=";
            case SyntaxKind.LeftArrowToken:
                return "<-";
            case SyntaxKind.RightArrowToken:
                return "->";
            case SyntaxKind.ShiftLeftToken:
                return "<<";
            case SyntaxKind.ShiftLeftEqualsToken:
                return "<<=";
            case SyntaxKind.GreaterToken:
                return ">";
            case SyntaxKind.GreaterOrEqualsToken:
                return ">=";
            case SyntaxKind.ShiftRightToken:
                return ">>";
            case SyntaxKind.ShiftRightEqualsToken:
                return ">>=";
            case SyntaxKind.UnsignedShiftRightToken:
                return ">>>";
            case SyntaxKind.UnsignedShiftRightEqualsToken:
                return ">>>=";
            case SyntaxKind.AtToken:
                return "@";

            // keywords
            case SyntaxKind.AsKeyword:
                return "as";
            case SyntaxKind.AsyncKeyword:
                return "async";
            case SyntaxKind.AwaitKeyword:
                return "await";
            case SyntaxKind.BreakKeyword:
                return "break";
            case SyntaxKind.CaseKeyword:
                return "case";
            case SyntaxKind.CatchKeyword:
                return "catch";
            case SyntaxKind.ChanKeyword:
                return "chan";
            case SyntaxKind.ClassKeyword:
                return "class";
            case SyntaxKind.ConstKeyword:
                return "const";
            case SyntaxKind.ContinueKeyword:
                return "continue";
            case SyntaxKind.DefaultKeyword:
                return "default";
            case SyntaxKind.DeferKeyword:
                return "defer";
            case SyntaxKind.DoKeyword:
                return "do";
            case SyntaxKind.ElseKeyword:
                return "else";
            case SyntaxKind.EnumKeyword:
                return "enum";
            case SyntaxKind.FalseKeyword:
                return "false";
            case SyntaxKind.FallthroughKeyword:
                return "fallthrough";
            case SyntaxKind.FinallyKeyword:
                return "finally";
            case SyntaxKind.ForKeyword:
                return "for";
            case SyntaxKind.FuncKeyword:
                return "func";
            case SyntaxKind.GoKeyword:
                return "go";
            case SyntaxKind.GotoKeyword:
                return "goto";
            case SyntaxKind.GuardKeyword:
                return "guard";
            case SyntaxKind.IfKeyword:
                return "if";
            case SyntaxKind.ImportKeyword:
                return "import";
            case SyntaxKind.InterfaceKeyword:
                return "interface";
            case SyntaxKind.InternalKeyword:
                return "internal";
            case SyntaxKind.IsKeyword:
                return "is";
            case SyntaxKind.LetKeyword:
                return "let";
            case SyntaxKind.MapKeyword:
                return "map";
            case SyntaxKind.OpenKeyword:
                return "open";
            case SyntaxKind.NilKeyword:
                return "nil";
            case SyntaxKind.OverrideKeyword:
                return "override";
            case SyntaxKind.OperatorKeyword:
                return "operator";
            case SyntaxKind.PackageKeyword:
                return "package";
            case SyntaxKind.PrivateKeyword:
                return "private";
            case SyntaxKind.ProtectedKeyword:
                return "protected";
            case SyntaxKind.PublicKeyword:
                return "public";
            case SyntaxKind.RangeKeyword:
                return "range";
            case SyntaxKind.ReturnKeyword:
                return "return";
            case SyntaxKind.SealedKeyword:
                return "sealed";
            case SyntaxKind.ScopeKeyword:
                return "scope";
            case SyntaxKind.SelectKeyword:
                return "select";
            case SyntaxKind.SequenceKeyword:
                return "sequence";
            case SyntaxKind.StructKeyword:
                return "struct";
            case SyntaxKind.SwitchKeyword:
                return "switch";
            case SyntaxKind.ThrowKeyword:
                return "throw";
            case SyntaxKind.TrueKeyword:
                return "true";
            case SyntaxKind.TryKeyword:
                return "try";
            case SyntaxKind.TypeKeyword:
                return "type";
            case SyntaxKind.UsingKeyword:
                return "using";
            case SyntaxKind.VarKeyword:
                return "var";
            case SyntaxKind.WhileKeyword:
                return "while";
            case SyntaxKind.LockKeyword:
                return "lock";
            default:
                return null;
        }
    }

    /// <summary>
    /// Gets the fixed source text for <paramref name="kind"/>, or
    /// <see cref="string.Empty"/> when the kind has none.
    /// </summary>
    /// <remarks>
    /// For callers that pass a fixed operator or keyword kind, where
    /// <see cref="GetText"/> cannot return <see langword="null"/>. Keeps the
    /// null-returning overload honest without scattering `!` across the
    /// parser's synthetic-token construction.
    /// </remarks>
    /// <param name="kind">The kind of syntax.</param>
    /// <returns>The text, or an empty string.</returns>
    public static string GetTextOrEmpty(SyntaxKind kind) => GetText(kind) ?? string.Empty;
}
