// <copyright file="Lexer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Text;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// The GSharp language lexer.
/// </summary>
public sealed class Lexer
{
    private readonly SyntaxTree syntaxTree;
    private readonly SourceText text;

    private int position;

    private int start;
    private SyntaxKind kind;
    private object value;

    /// <summary>
    /// Initializes a new instance of the <see cref="Lexer"/> class.
    /// </summary>
    /// <param name="syntaxTree">The source syntax tree that contains the text document to lex from.</param>
    public Lexer(SyntaxTree syntaxTree)
    {
        this.syntaxTree = syntaxTree;
        this.text = syntaxTree.Text;
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
                if (Current == '/')
                {
                    ReadSingleLineComment();
                }
                else if (Current == '*')
                {
                    ReadMultiLineComment();
                }
                else if (Current == '=')
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
                if (Peek(1) == '.' && Peek(2) == '.')
                {
                    kind = SyntaxKind.EllipsisToken;
                    position += 3;
                }
                else
                {
                    kind = SyntaxKind.DotToken;
                    position++;
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
            case '?':
                kind = SyntaxKind.QuestionToken;
                position++;
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
            case '`':
                ReadRawString();
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
                if (char.IsLetter(Current) || Current == '_')
                {
                    ReadIdentifierOrKeyword();
                }
                else if (char.IsWhiteSpace(Current))
                {
                    ReadWhiteSpace();
                }
                else
                {
                    var location = new TextLocation(this.text, new TextSpan(position, 1));
                    Diagnostics.ReportBadCharacter(location, Current);
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

        return new SyntaxToken(syntaxTree, kind, start, text, value);
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

    private void ReadSingleLineComment()
    {
        // Skip the current slash character
        position++;

        var sb = new StringBuilder();
        var done = false;

        while (!done)
        {
            switch (Current)
            {
                case '\0':
                    done = true;
                    break;
                case '\r':
                case '\n':
                    position++;
                    done = true;
                    break;
                default:
                    sb.Append(Current);
                    position++;
                    break;
            }
        }

        kind = SyntaxKind.CommentToken;
        value = sb.ToString();
    }

    private void ReadMultiLineComment()
    {
        // Skip the current star character
        position++;

        var sb = new StringBuilder();
        var done = false;

        while (!done)
        {
            switch (Current)
            {
                case '\0':
                    var location = new TextLocation(this.text, new TextSpan(start, position - start));
                    Diagnostics.ReportUnterminatedComment(location);
                    done = true;
                    break;
                case '*':
                    if (Lookahead == '/')
                    {
                        position += 2;
                        done = true;
                    }
                    else
                    {
                        sb.Append(Current);
                        position++;
                    }

                    break;
                default:
                    sb.Append(Current);
                    position++;
                    break;
            }
        }

        kind = SyntaxKind.CommentToken;
        value = sb.ToString();
    }

    private void ReadRawString()
    {
        // Backtick-delimited raw strings (Go-style). No escape processing,
        // multi-line allowed, no interpolation. Embedded backticks are not
        // representable; concatenate adjacent raw + interpreted literals to
        // include one (matches Go's choice).
        position++; // consume opening backtick

        var sb = new StringBuilder();
        var done = false;

        while (!done)
        {
            switch (Current)
            {
                case '\0':
                    var loc = new TextLocation(this.text, new TextSpan(start, position - start));
                    Diagnostics.ReportUnterminatedString(loc);
                    done = true;
                    break;
                case '`':
                    position++;
                    done = true;
                    break;
                case '\r':
                    // Normalize CRLF and bare CR to LF inside raw strings, matching Go's spec.
                    if (Lookahead == '\n')
                    {
                        position++;
                    }

                    sb.Append('\n');
                    position++;
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

    private void ReadString()
    {
        // Skip the current quote
        position++;

        var sb = new StringBuilder();
        List<InterpolationFragment> fragments = null;
        var done = false;

        while (!done)
        {
            switch (Current)
            {
                case '\0':
                case '\r':
                case '\n':
                    var location = new TextLocation(this.text, new TextSpan(start, 1));
                    Diagnostics.ReportUnterminatedString(location);
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
                case '$':
                    // `$$` escapes to a literal `$`. `$ident` and `${expr}`
                    // open an interpolation segment; bare `$` followed by any
                    // other character is treated as a literal `$` (forward-
                    // compatible: future grammar may attach meaning to it).
                    if (Lookahead == '$')
                    {
                        sb.Append('$');
                        position += 2;
                        break;
                    }

                    if (Lookahead == '{')
                    {
                        fragments ??= new List<InterpolationFragment>();
                        if (sb.Length > 0)
                        {
                            fragments.Add(InterpolationFragment.FromText(sb.ToString()));
                            sb.Clear();
                        }

                        position += 2; // consume '${'
                        var exprStart = position;
                        var depth = 1;
                        while (depth > 0 && Current != '\0' && Current != '\r' && Current != '\n' && Current != '"')
                        {
                            if (Current == '{')
                            {
                                depth++;
                            }
                            else if (Current == '}')
                            {
                                depth--;
                                if (depth == 0)
                                {
                                    break;
                                }
                            }

                            position++;
                        }

                        if (depth != 0)
                        {
                            var loc = new TextLocation(this.text, new TextSpan(start, 1));
                            Diagnostics.ReportUnterminatedString(loc);
                            done = true;
                            break;
                        }

                        var exprText = this.text.ToString(exprStart, position - exprStart);
                        fragments.Add(InterpolationFragment.FromExpression(exprText, exprStart));
                        position++; // consume '}'
                        break;
                    }

                    if (char.IsLetter(Lookahead) || Lookahead == '_')
                    {
                        fragments ??= new List<InterpolationFragment>();
                        if (sb.Length > 0)
                        {
                            fragments.Add(InterpolationFragment.FromText(sb.ToString()));
                            sb.Clear();
                        }

                        position++; // consume '$'
                        var idStart = position;
                        while (char.IsLetterOrDigit(Current) || Current == '_')
                        {
                            position++;
                        }

                        var idText = this.text.ToString(idStart, position - idStart);
                        fragments.Add(InterpolationFragment.FromExpression(idText, idStart));
                        break;
                    }

                    sb.Append('$');
                    position++;
                    break;
                default:
                    sb.Append(Current);
                    position++;
                    break;
            }
        }

        if (fragments == null)
        {
            kind = SyntaxKind.StringToken;
            value = sb.ToString();
        }
        else
        {
            if (sb.Length > 0)
            {
                fragments.Add(InterpolationFragment.FromText(sb.ToString()));
            }

            kind = SyntaxKind.InterpolatedStringToken;
            value = fragments.ToImmutableArray();
        }
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
        // Recognized forms (Go-inspired, with C#-style _ separators):
        //   decimal   42, 1_000_000
        //   hex       0x1F, 0X_FF, 0xDEAD_BEEF
        //   octal     0o17, 0O_77  (Go also allows leading-zero octal; we require the prefix
        //                            to avoid ambiguity with future float literals.)
        //   binary    0b1010, 0B_1010_1010
        // A trailing underscore, a leading underscore in the digit body, or a
        // prefix with no digits is rejected as an invalid number.
        var numberStart = position;
        var radix = 10;
        var digitsStart = position;

        if (Current == '0' && (Lookahead == 'x' || Lookahead == 'X'))
        {
            radix = 16;
            position += 2;
            digitsStart = position;
        }
        else if (Current == '0' && (Lookahead == 'o' || Lookahead == 'O'))
        {
            radix = 8;
            position += 2;
            digitsStart = position;
        }
        else if (Current == '0' && (Lookahead == 'b' || Lookahead == 'B'))
        {
            radix = 2;
            position += 2;
            digitsStart = position;
        }

        // Disallow leading underscore in a decimal literal (which is impossible
        // here because the dispatcher only routes digits → ReadNumber, but kept
        // explicit for clarity). Underscore IS allowed immediately after a
        // base prefix per Go's spec (e.g., `0x_FF`).
        bool sawDigit = false;
        char last = '\0';
        while (true)
        {
            var c = Current;
            if (c == '_')
            {
                last = c;
                position++;
                continue;
            }

            if (!IsDigitForRadix(c, radix))
            {
                break;
            }

            sawDigit = true;
            last = c;
            position++;
        }

        var length = position - numberStart;
        var fullText = this.text.ToString(numberStart, length);

        if (!sawDigit || last == '_')
        {
            var loc = new TextLocation(this.text, new TextSpan(numberStart, length));
            Diagnostics.ReportInvalidNumber(loc, fullText, TypeSymbol.Int);
            this.value = 0;
            kind = SyntaxKind.NumberToken;
            return;
        }

        var digitText = this.text.ToString(digitsStart, position - digitsStart).Replace("_", string.Empty);

        int parsed;
        try
        {
            parsed = radix == 10
                ? int.Parse(digitText, System.Globalization.CultureInfo.InvariantCulture)
                : System.Convert.ToInt32(digitText, radix);
        }
        catch (System.Exception)
        {
            var loc = new TextLocation(this.text, new TextSpan(numberStart, length));
            Diagnostics.ReportInvalidNumber(loc, fullText, TypeSymbol.Int);
            parsed = 0;
        }

        this.value = parsed;
        kind = SyntaxKind.NumberToken;
    }

    private static bool IsDigitForRadix(char c, int radix)
    {
        return radix switch
        {
            2 => c >= '0' && c <= '1',
            8 => c >= '0' && c <= '7',
            10 => c >= '0' && c <= '9',
            16 => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'),
            _ => false,
        };
    }

    private void ReadIdentifierOrKeyword()
    {
        // Identifiers start with a letter or underscore (the caller has verified
        // the first character) and continue with letters, digits, or underscores.
        while (char.IsLetterOrDigit(Current) || Current == '_')
        {
            position++;
        }

        var length = position - start;
        var text = this.text.ToString(start, length);
        kind = SyntaxFacts.GetKeywordKind(text);
    }
}
