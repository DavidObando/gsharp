// <copyright file="SyntaxFacts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    using System;
    using System.Collections.Generic;

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
                    return 0;
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
                case "break":
                    return SyntaxKind.BreakKeyword;
                case "case":
                    return SyntaxKind.CaseKeyword;
                case "chan":
                    return SyntaxKind.ChanKeyword;
                case "const":
                    return SyntaxKind.ConstKeyword;
                case "continue":
                    return SyntaxKind.ContinueKeyword;
                case "default":
                    return SyntaxKind.DefaultKeyword;
                case "defer":
                    return SyntaxKind.DeferKeyword;
                case "else":
                    return SyntaxKind.ElseKeyword;
                case "false":
                    return SyntaxKind.FalseKeyword;
                case "fallthrough":
                    return SyntaxKind.FallthroughKeyword;
                case "for":
                    return SyntaxKind.ForKeyword;
                case "func":
                    return SyntaxKind.FuncKeyword;
                case "go":
                    return SyntaxKind.GoKeyword;
                case "goto":
                    return SyntaxKind.GotoKeyword;
                case "if":
                    return SyntaxKind.IfKeyword;
                case "import":
                    return SyntaxKind.ImportKeyword;
                case "interface":
                    return SyntaxKind.InterfaceKeyword;
                case "map":
                    return SyntaxKind.MapKeyword;
                case "package":
                    return SyntaxKind.PackageKeyword;
                case "range":
                    return SyntaxKind.RangeKeyword;
                case "return":
                    return SyntaxKind.ReturnKeyword;
                case "select":
                    return SyntaxKind.SelectKeyword;
                case "struct":
                    return SyntaxKind.StructKeyword;
                case "switch":
                    return SyntaxKind.SwitchKeyword;
                case "true":
                    return SyntaxKind.TrueKeyword;
                case "type":
                    return SyntaxKind.TypeKeyword;
                case "var":
                    return SyntaxKind.VarKeyword;
                default:
                    return SyntaxKind.IdentifierToken;
            }
        }

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
        public static string GetText(SyntaxKind kind)
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
                case SyntaxKind.LessToken:
                    return "<";
                case SyntaxKind.LessOrEqualsToken:
                    return "<=";
                case SyntaxKind.LeftArrowToken:
                    return "<-";
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

                // keywords
                case SyntaxKind.BreakKeyword:
                    return "break";
                case SyntaxKind.CaseKeyword:
                    return "case";
                case SyntaxKind.ChanKeyword:
                    return "chan";
                case SyntaxKind.ConstKeyword:
                    return "const";
                case SyntaxKind.ContinueKeyword:
                    return "continue";
                case SyntaxKind.DefaultKeyword:
                    return "default";
                case SyntaxKind.DeferKeyword:
                    return "defer";
                case SyntaxKind.ElseKeyword:
                    return "else";
                case SyntaxKind.FalseKeyword:
                    return "false";
                case SyntaxKind.FallthroughKeyword:
                    return "fallthrough";
                case SyntaxKind.ForKeyword:
                    return "for";
                case SyntaxKind.FuncKeyword:
                    return "func";
                case SyntaxKind.GoKeyword:
                    return "go";
                case SyntaxKind.GotoKeyword:
                    return "goto";
                case SyntaxKind.IfKeyword:
                    return "if";
                case SyntaxKind.ImportKeyword:
                    return "import";
                case SyntaxKind.InterfaceKeyword:
                    return "interface";
                case SyntaxKind.MapKeyword:
                    return "map";
                case SyntaxKind.PackageKeyword:
                    return "package";
                case SyntaxKind.RangeKeyword:
                    return "range";
                case SyntaxKind.ReturnKeyword:
                    return "return";
                case SyntaxKind.SelectKeyword:
                    return "select";
                case SyntaxKind.StructKeyword:
                    return "struct";
                case SyntaxKind.SwitchKeyword:
                    return "switch";
                case SyntaxKind.TrueKeyword:
                    return "true";
                case SyntaxKind.TypeKeyword:
                    return "type";
                case SyntaxKind.VarKeyword:
                    return "var";
                default:
                    return null;
            }
        }
    }
}
