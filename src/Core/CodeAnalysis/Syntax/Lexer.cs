// <copyright file="Lexer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax
{
    using System.Text;
    using GSharp.Core.CodeAnalysis.Symbols;
    using GSharp.Core.CodeAnalysis.Text;

    /// <summary>
    /// The GSharp language lexer.
    /// </summary>
    public sealed class Lexer
    {
        private readonly SourceText text;

        private int position;

        private int start;
        private SyntaxKind kind;
        private object value;

        /// <summary>
        /// Initializes a new instance of the <see cref="Lexer"/> class.
        /// </summary>
        /// <param name="text">The source text document to lex from.</param>
        public Lexer(SourceText text)
        {
            this.text = text;
        }

        /// <summary>
        /// Gets the lexer diagnostics.
        /// </summary>
        public DiagnosticBag Diagnostics { get; } = new DiagnosticBag();

        private char Current => Peek(0);

        private char Lookahead => Peek(1);

        /// <summary>
        /// Returns the next syntax token from the source text document.
        /// </summary>
        /// <returns>A syntax token.</returns>
        public SyntaxToken Lex()
        {
            start = position;
            kind = SyntaxKind.BadToken;
            value = null;

            switch (Current)
            {
                case '\0':
                    kind = SyntaxKind.EndOfFileToken;
                    break;
                case '+':
                    position++;
                    if (Current == '=')
                    {
                        kind = SyntaxKind.PlusEqualsToken;
                        position++;
                    }
                    else if (Current == '+')
                    {
                        kind = SyntaxKind.PlusPlusToken;
                        position++;
                    }
                    else
                    {
                        kind = SyntaxKind.PlusToken;
                    }

                    break;
                case '-':
                    position++;
                    if (Current == '=')
                    {
                        kind = SyntaxKind.MinusEqualsToken;
                        position++;
                    }
                    else if (Current == '-')
                    {
                        kind = SyntaxKind.MinusMinusToken;
                        position++;
                    }
                    else
                    {
                        kind = SyntaxKind.MinusToken;
                    }

                    break;
                case '*':
                    position++;
                    if (Current == '=')
                    {
                        kind = SyntaxKind.StarEqualsToken;
                        position++;
                    }
                    else
                    {
                        kind = SyntaxKind.StarToken;
                    }

                    break;
                case '/':
                    position++;
                    if (Current == '=')
                    {
                        kind = SyntaxKind.SlashEqualsToken;
                        position++;
                    }
                    else
                    {
                        kind = SyntaxKind.SlashToken;
                    }

                    break;
                case '%':
                    position++;
                    if (Current == '=')
                    {
                        kind = SyntaxKind.PercentEqualsToken;
                        position++;
                    }
                    else
                    {
                        kind = SyntaxKind.PercentToken;
                    }

                    break;
                case '(':
                    kind = SyntaxKind.OpenParenthesisToken;
                    position++;
                    break;
                case ')':
                    kind = SyntaxKind.CloseParenthesisToken;
                    position++;
                    break;
                case '[':
                    kind = SyntaxKind.OpenSquareBracketToken;
                    position++;
                    break;
                case ']':
                    kind = SyntaxKind.CloseSquareBracketToken;
                    position++;
                    break;
                case '{':
                    kind = SyntaxKind.OpenBraceToken;
                    position++;
                    break;
                case '}':
                    kind = SyntaxKind.CloseBraceToken;
                    position++;
                    break;
                case ':':
                    position++;
                    if (Current == '=')
                    {
                        kind = SyntaxKind.ColonEqualsToken;
                        position++;
                    }
                    else
                    {
                        kind = SyntaxKind.ColonToken;
                    }

                    break;
                case ';':
                    kind = SyntaxKind.SemicolonToken;
                    position++;
                    break;
                case ',':
                    kind = SyntaxKind.CommaToken;
                    position++;
                    break;
                case '.':
                    position++;
                    if (Peek(1) == '.' && Peek(2) == '.')
                    {
                        kind = SyntaxKind.EllipsisToken;
                        position += 2;
                    }
                    else
                    {
                        kind = SyntaxKind.DotToken;
                    }

                    break;
                case '^':
                    position++;
                    if (Current == '=')
                    {
                        kind = SyntaxKind.HatEqualsToken;
                        position++;
                    }
                    else
                    {
                        kind = SyntaxKind.HatToken;
                    }

                    break;
                case '&':
                    position++;
                    if (Current == '&')
                    {
                        kind = SyntaxKind.AmpersandAmpersandToken;
                        position++;
                    }
                    else if (Current == '=')
                    {
                        kind = SyntaxKind.AmpersandEqualsToken;
                        position++;
                    }
                    else if (Current == '^')
                    {
                        position++;
                        if (Current == '=')
                        {
                            kind = SyntaxKind.AmpersandHatEqualsToken;
                            position++;
                        }
                        else
                        {
                            kind = SyntaxKind.AmpersandHatToken;
                        }
                    }
                    else
                    {
                        kind = SyntaxKind.AmpersandToken;
                    }

                    break;
                case '|':
                    position++;
                    if (Current == '|')
                    {
                        kind = SyntaxKind.PipePipeToken;
                        position++;
                    }
                    else if (Current == '=')
                    {
                        kind = SyntaxKind.PipeEqualsToken;
                        position++;
                    }
                    else
                    {
                        kind = SyntaxKind.PipeToken;
                    }

                    break;
                case '=':
                    position++;
                    if (Current == '=')
                    {
                        kind = SyntaxKind.EqualsEqualsToken;
                        position++;
                    }
                    else
                    {
                        kind = SyntaxKind.EqualsToken;
                    }

                    break;
                case '!':
                    position++;
                    if (Current == '=')
                    {
                        kind = SyntaxKind.BangEqualsToken;
                        position++;
                    }
                    else
                    {
                        kind = SyntaxKind.BangToken;
                    }

                    break;
                case '<':
                    position++;
                    if (Current == '=')
                    {
                        kind = SyntaxKind.LessOrEqualsToken;
                        position++;
                    }
                    else if (Current == '-')
                    {
                        kind = SyntaxKind.LeftArrowToken;
                        position++;
                    }
                    else if (Current == '<')
                    {
                        position++;
                        if (Current == '=')
                        {
                            kind = SyntaxKind.ShiftLeftEqualsToken;
                            position++;
                        }
                        else
                        {
                            kind = SyntaxKind.ShiftLeftToken;
                        }
                    }
                    else
                    {
                        kind = SyntaxKind.LessToken;
                    }

                    break;
                case '>':
                    position++;
                    if (Current == '=')
                    {
                        kind = SyntaxKind.GreaterOrEqualsToken;
                        position++;
                    }
                    else if (Current == '>')
                    {
                        position++;
                        if (Current == '=')
                        {
                            kind = SyntaxKind.ShiftRightEqualsToken;
                            position++;
                        }
                        else
                        {
                            kind = SyntaxKind.ShiftRightToken;
                        }
                    }
                    else
                    {
                        kind = SyntaxKind.GreaterToken;
                    }

                    break;
                case '"':
                    ReadString();
                    break;
                case '0':
                case '1':
                case '2':
                case '3':
                case '4':
                case '5':
                case '6':
                case '7':
                case '8':
                case '9':
                    ReadNumber();
                    break;
                case ' ':
                case '\t':
                case '\n':
                case '\r':
                    ReadWhiteSpace();
                    break;
                default:
                    if (char.IsLetter(Current))
                    {
                        ReadIdentifierOrKeyword();
                    }
                    else if (char.IsWhiteSpace(Current))
                    {
                        ReadWhiteSpace();
                    }
                    else
                    {
                        Diagnostics.ReportBadCharacter(position, Current);
                        position++;
                    }

                    break;
            }

            var length = position - start;
            var text = SyntaxFacts.GetText(kind);
            if (text == null)
            {
                text = this.text.ToString(start, length);
            }

            return new SyntaxToken(kind, start, text, value);
        }

        private char Peek(int offset)
        {
            var index = position + offset;

            if (index >= text.Length)
            {
                return '\0';
            }

            return text[index];
        }

        private void ReadString()
        {
            // Skip the current quote
            position++;

            var sb = new StringBuilder();
            var done = false;

            while (!done)
            {
                switch (Current)
                {
                    case '\0':
                    case '\r':
                    case '\n':
                        var span = new TextSpan(start, 1);
                        Diagnostics.ReportUnterminatedString(span);
                        done = true;
                        break;
                    case '"':
                        if (Lookahead == '"')
                        {
                            sb.Append(Current);
                            position += 2;
                        }
                        else
                        {
                            position++;
                            done = true;
                        }

                        break;
                    default:
                        sb.Append(Current);
                        position++;
                        break;
                }
            }

            kind = SyntaxKind.StringToken;
            value = sb.ToString();
        }

        private void ReadWhiteSpace()
        {
            while (char.IsWhiteSpace(Current))
            {
                position++;
            }

            kind = SyntaxKind.WhitespaceToken;
        }

        private void ReadNumber()
        {
            while (char.IsDigit(Current))
            {
                position++;
            }

            var length = position - start;
            var text = this.text.ToString(start, length);
            if (!int.TryParse(text, out var value))
            {
                Diagnostics.ReportInvalidNumber(new TextSpan(start, length), text, TypeSymbol.Int);
            }

            this.value = value;
            kind = SyntaxKind.NumberToken;
        }

        private void ReadIdentifierOrKeyword()
        {
            while (char.IsLetter(Current))
            {
                position++;
            }

            var length = position - start;
            var text = this.text.ToString(start, length);
            kind = SyntaxFacts.GetKeywordKind(text);
        }
    }
}
