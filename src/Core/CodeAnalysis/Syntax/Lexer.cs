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
                else if (Current == '>')
                {
                    kind = SyntaxKind.RightArrowToken;
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
                else if (IsDecimalDigit(Peek(1)))
                {
                    // ADR-0044 leading-dot float literal (`.5`). ReadNumber
                    // detects the leading dot via `Current == '.'` and parses
                    // the digit body as the fractional part.
                    ReadNumber();
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
                else if (Current == '!')
                {
                    kind = SyntaxKind.BangBangToken;
                    position++;
                }
                else
                {
                    kind = SyntaxKind.BangToken;
                }

                break;
            case '?':
                position++;
                if (Current == '.')
                {
                    kind = SyntaxKind.QuestionDotToken;
                    position++;
                }
                else if (Current == ':')
                {
                    kind = SyntaxKind.QuestionColonToken;
                    position++;
                }
                else
                {
                    kind = SyntaxKind.QuestionToken;
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
            case '`':
                ReadRawString();
                break;
            case '\'':
                ReadCharLiteral();
                break;
            case '@':
                kind = SyntaxKind.AtToken;
                position++;
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
                case '\r':
                case '\n':
                    // ADR-0055: a raw newline in the literal portion of an
                    // interpolated string is its own diagnostic; in a plain
                    // string it is an unterminated literal. (Multiline holes
                    // are handled inside the `${ … }` scanner and never reach
                    // here.)
                    var newlineLoc = new TextLocation(this.text, new TextSpan(start, 1));
                    if (fragments != null)
                    {
                        Diagnostics.ReportNewlineInInterpolatedStringLiteral(newlineLoc);
                    }
                    else
                    {
                        Diagnostics.ReportUnterminatedString(newlineLoc);
                    }

                    done = true;
                    break;
                case '\0':
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

                        // ADR-0055: scan the hole with a delimiter-aware
                        // sub-scanner that tracks ()[]{} nesting, skips nested
                        // string/char literals (recursively, so a nested
                        // interpolation is handled) and //, /* */ comments, and
                        // permits newlines. The hole ends at the matching
                        // top-level `}`.
                        if (!ScanInterpolationHole(exprStart))
                        {
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

    /// <summary>
    /// ADR-0055 delimiter-aware interpolation-hole scanner. Assumes the opening
    /// <c>${</c> has already been consumed and <see cref="position"/> sits at
    /// the first character of the hole body. Advances to the matching top-level
    /// <c>}</c> (left un-consumed for the caller), tracking <c>()[]{}</c>
    /// nesting and skipping nested string/char literals (recursively, so an
    /// inner interpolation is handled) and <c>//</c> / <c>/* */</c> comments.
    /// Newlines are permitted, so multiline holes are legal. Returns
    /// <see langword="false"/> (after reporting) if the hole is unterminated.
    /// </summary>
    /// <param name="holeStart">Source offset of the hole body (for diagnostics).</param>
    /// <returns><see langword="true"/> if the hole closed normally.</returns>
    private bool ScanInterpolationHole(int holeStart)
    {
        var depth = 1; // the opening '{' of '${'
        while (true)
        {
            var c = Current;
            if (c == '\0')
            {
                var loc = new TextLocation(this.text, new TextSpan(holeStart, 1));
                Diagnostics.ReportUnterminatedInterpolationHole(loc);
                return false;
            }

            if (c == '"' || c == '\'')
            {
                SkipInterpolationNestedLiteral(c);
                continue;
            }

            if (c == '/' && Lookahead == '/')
            {
                while (Current != '\0' && Current != '\r' && Current != '\n')
                {
                    position++;
                }

                continue;
            }

            if (c == '/' && Lookahead == '*')
            {
                position += 2;
                while (Current != '\0' && !(Current == '*' && Lookahead == '/'))
                {
                    position++;
                }

                if (Current != '\0')
                {
                    position += 2; // consume '*/'
                }

                continue;
            }

            if (c == '(' || c == '[' || c == '{')
            {
                depth++;
            }
            else if (c == ')' || c == ']')
            {
                depth--;
            }
            else if (c == '}')
            {
                if (depth == 1)
                {
                    return true; // matching close; leave it for the caller
                }

                depth--;
            }

            position++;
        }
    }

    /// <summary>
    /// Skips a nested string or character literal inside an interpolation hole.
    /// Mirrors the real literal lexers: a double-quoted string escapes a quote
    /// via <c>""</c> (no backslash escapes) and may itself contain a nested
    /// <c>${ … }</c> interpolation; a single-quoted char literal uses backslash
    /// escapes. <see cref="position"/> starts on the opening delimiter.
    /// </summary>
    /// <param name="quote">The opening delimiter (<c>"</c> or <c>'</c>).</param>
    private void SkipInterpolationNestedLiteral(char quote)
    {
        position++; // consume opening delimiter
        if (quote == '"')
        {
            while (Current != '\0' && Current != '\r' && Current != '\n')
            {
                if (Current == '"')
                {
                    if (Lookahead == '"')
                    {
                        position += 2; // escaped quote ""
                        continue;
                    }

                    position++; // closing quote
                    return;
                }

                if (Current == '$' && Lookahead == '{')
                {
                    position += 2; // consume nested '${'
                    if (!ScanInterpolationHole(position))
                    {
                        return;
                    }

                    position++; // consume nested '}'
                    continue;
                }

                position++;
            }

            return; // unterminated; the outer scanner reports at EOF/newline
        }

        // Single-quoted character literal: backslash escapes a single char.
        while (Current != '\0' && Current != '\r' && Current != '\n')
        {
            if (Current == '\\' && Lookahead != '\0')
            {
                position += 2;
                continue;
            }

            if (Current == '\'')
            {
                position++;
                return;
            }

            position++;
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

    private void ReadCharLiteral()
    {
        // ADR-0046 single-quote character literal. Exactly one Unicode code
        // unit (or one escape sequence) between the delimiters; line
        // terminators inside the literal are diagnostics; unknown escapes
        // are diagnostics.
        var literalStart = position;
        position++; // consume opening '

        char produced = '\0';
        bool sawChar = false;
        bool errored = false;

        if (Current == '\0' || Current == '\r' || Current == '\n')
        {
            var loc = new TextLocation(this.text, new TextSpan(literalStart, position - literalStart));
            Diagnostics.ReportUnterminatedCharLiteral(loc);
            value = '\0';
            kind = SyntaxKind.CharacterToken;
            return;
        }

        if (Current == '\'')
        {
            // Empty literal: ''.
            position++;
            var loc = new TextLocation(this.text, new TextSpan(literalStart, position - literalStart));
            Diagnostics.ReportEmptyCharLiteral(loc);
            value = '\0';
            kind = SyntaxKind.CharacterToken;
            return;
        }

        if (Current == '\\')
        {
            // Escape sequence.
            position++; // consume '\'
            switch (Current)
            {
                case '\'': produced = '\''; position++; break;
                case '"': produced = '"'; position++; break;
                case '\\': produced = '\\'; position++; break;
                case '0': produced = '\0'; position++; break;
                case 'a': produced = '\a'; position++; break;
                case 'b': produced = '\b'; position++; break;
                case 'f': produced = '\f'; position++; break;
                case 'n': produced = '\n'; position++; break;
                case 'r': produced = '\r'; position++; break;
                case 't': produced = '\t'; position++; break;
                case 'v': produced = '\v'; position++; break;
                case 'x':
                    position++;
                    produced = ReadHexEscape(literalStart, minDigits: 1, maxDigits: 4, ref errored);
                    break;
                case 'u':
                    position++;
                    produced = ReadHexEscape(literalStart, minDigits: 4, maxDigits: 4, ref errored);
                    break;
                case 'U':
                    position++;
                    produced = ReadLongUnicodeEscape(literalStart, ref errored);
                    break;
                default:
                    {
                        var loc = new TextLocation(this.text, new TextSpan(literalStart, position - literalStart + 1));
                        Diagnostics.ReportInvalidCharEscape(loc, Current);
                        produced = Current;
                        if (Current != '\0' && Current != '\r' && Current != '\n' && Current != '\'')
                        {
                            position++;
                        }

                        errored = true;
                        break;
                    }
            }

            sawChar = true;
        }
        else
        {
            produced = Current;
            position++;
            sawChar = true;
        }

        // After the body, require the closing quote and exactly one character.
        if (Current == '\'')
        {
            position++;
        }
        else
        {
            // Multi-codepoint literal (e.g. 'ab') or missing closing quote.
            // Consume up to the matching quote / line terminator so the parser
            // recovers cleanly.
            var bodyStart = position;
            while (Current != '\'' && Current != '\0' && Current != '\r' && Current != '\n')
            {
                position++;
            }

            var loc = new TextLocation(this.text, new TextSpan(literalStart, position - literalStart));
            if (Current == '\'')
            {
                if (!errored)
                {
                    Diagnostics.ReportMultiCharCharLiteral(loc);
                }

                position++;
            }
            else
            {
                Diagnostics.ReportUnterminatedCharLiteral(loc);
            }

            _ = bodyStart;
        }

        _ = sawChar;
        kind = SyntaxKind.CharacterToken;
        value = produced;
    }

    private char ReadHexEscape(int literalStart, int minDigits, int maxDigits, ref bool errored)
    {
        var digitsStart = position;
        var consumed = 0;
        int accumulator = 0;
        while (consumed < maxDigits && IsHexDigit(Current))
        {
            accumulator = (accumulator << 4) | HexValue(Current);
            position++;
            consumed++;
        }

        if (consumed < minDigits)
        {
            var loc = new TextLocation(this.text, new TextSpan(literalStart, position - literalStart));
            Diagnostics.ReportInvalidUnicodeEscape(loc);
            errored = true;
        }

        _ = digitsStart;
        return (char)accumulator;
    }

    private char ReadLongUnicodeEscape(int literalStart, ref bool errored)
    {
        // \U requires exactly 8 hex digits. Values > 0xFFFF cannot fit in a
        // single UTF-16 code unit and so cannot be represented in a `char`
        // literal (per ADR-0046).
        var consumed = 0;
        long accumulator = 0;
        while (consumed < 8 && IsHexDigit(Current))
        {
            accumulator = (accumulator << 4) | (long)HexValue(Current);
            position++;
            consumed++;
        }

        if (consumed < 8 || accumulator > 0xFFFF)
        {
            var loc = new TextLocation(this.text, new TextSpan(literalStart, position - literalStart));
            Diagnostics.ReportInvalidUnicodeEscape(loc);
            errored = true;
        }

        return (char)(accumulator & 0xFFFF);
    }

    private static bool IsHexDigit(char c)
        => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');

    private static int HexValue(char c)
    {
        if (c >= '0' && c <= '9')
        {
            return c - '0';
        }

        if (c >= 'a' && c <= 'f')
        {
            return c - 'a' + 10;
        }

        return c - 'A' + 10;
    }

    private void ReadNumber()
    {
        // Recognized forms (Go-inspired, with C#-style _ separators):
        //   decimal int  42, 1_000_000
        //   hex          0x1F, 0X_FF, 0xDEAD_BEEF
        //   octal        0o17, 0O_77  (Go also allows leading-zero octal; we
        //                              require the prefix to keep the grammar
        //                              unambiguous next to float literals.)
        //   binary       0b1010, 0B_1010_1010
        //   float        1.5, 1.5e-3, 1e10, .5 (the leading-dot form is
        //                routed in by the '.' dispatcher; see Lex())
        // Optional trailing type-pin suffix (ADR-0044, case-insensitive):
        //   L / l       long
        //   U / u       uint           (UL/LU/Ul/lU/etc.  -> ulong)
        //   F / f       float32        (decimal-radix or float body only)
        //   D / d       float64        (decimal-radix or float body only)
        //   M / m       decimal        (decimal-radix or float body only)
        // A trailing underscore, a leading underscore in the digit body, or a
        // prefix with no digits is rejected as an invalid number.
        var numberStart = position;
        var radix = 10;
        var digitsStart = position;
        var startedWithDot = Current == '.';

        if (!startedWithDot && Current == '0' && (Lookahead == 'x' || Lookahead == 'X'))
        {
            radix = 16;
            position += 2;
            digitsStart = position;
        }
        else if (!startedWithDot && Current == '0' && (Lookahead == 'o' || Lookahead == 'O'))
        {
            radix = 8;
            position += 2;
            digitsStart = position;
        }
        else if (!startedWithDot && Current == '0' && (Lookahead == 'b' || Lookahead == 'B'))
        {
            radix = 2;
            position += 2;
            digitsStart = position;
        }

        // Disallow leading underscore in a decimal literal (which is impossible
        // here because the dispatcher only routes digits → ReadNumber, but kept
        // explicit for clarity). Underscore IS allowed immediately after a
        // base prefix per Go's spec (e.g., `0x_FF`).
        bool sawIntDigit = false;
        char last = '\0';
        if (startedWithDot)
        {
            // Consume the leading '.' and parse the fractional digit body.
            // We deliberately leave digitsStart at numberStart so the dot
            // is included in the substring passed to ParseFloatLiteral.
            last = Current;
            position++;
            while (true)
            {
                var c = Current;
                if (c == '_')
                {
                    last = c;
                    position++;
                    continue;
                }

                if (!IsDecimalDigit(c))
                {
                    break;
                }

                sawIntDigit = true;
                last = c;
                position++;
            }
        }
        else
        {
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

                sawIntDigit = true;
                last = c;
                position++;
            }
        }

        // After the integer body, decide whether this is a float. Only base-10
        // literals can become floats.
        bool isFloat = startedWithDot;
        if (radix == 10)
        {
            // Fractional part: a '.' followed by at least one digit. A bare
            // trailing dot (`1.`) is intentionally not consumed here so that
            // member access like `(1).ToString()` stays unambiguous — float
            // literals must have a digit on at least one side of the dot.
            if (!startedWithDot && Current == '.' && IsDecimalDigit(Lookahead))
            {
                isFloat = true;
                last = Current;
                position++; // consume '.'
                while (true)
                {
                    var c = Current;
                    if (c == '_')
                    {
                        last = c;
                        position++;
                        continue;
                    }

                    if (!IsDecimalDigit(c))
                    {
                        break;
                    }

                    last = c;
                    position++;
                }
            }

            // Exponent: e/E [+/-] digits
            if ((Current == 'e' || Current == 'E')
                && (IsDecimalDigit(Lookahead)
                    || ((Lookahead == '+' || Lookahead == '-') && IsDecimalDigit(Peek(2)))))
            {
                isFloat = true;
                last = Current;
                position++; // consume 'e'
                if (Current == '+' || Current == '-')
                {
                    last = Current;
                    position++;
                }

                while (true)
                {
                    var c = Current;
                    if (c == '_')
                    {
                        last = c;
                        position++;
                        continue;
                    }

                    if (!IsDecimalDigit(c))
                    {
                        break;
                    }

                    last = c;
                    position++;
                }
            }
        }

        // Optional type-pin suffix. In hex/oct/bin mode `F` and `D` are
        // valid hex digits, so only L / U / UL combinations are accepted
        // after non-decimal-radix integer bodies. In decimal-radix or
        // float bodies, every ADR-0044 suffix is accepted.
        SyntaxKind suffixKind;
        var (suffixType, suffixLen) = TryReadNumericSuffix(radix == 10 || isFloat, isFloat);
        position += suffixLen;
        suffixKind = SyntaxKind.NumberToken;

        var bodyEnd = position - suffixLen;
        var length = position - numberStart;
        var fullText = this.text.ToString(numberStart, length);

        var sawAnyDigit = sawIntDigit || isFloat;
        if (!sawAnyDigit || last == '_')
        {
            var loc = new TextLocation(this.text, new TextSpan(numberStart, length));
            Diagnostics.ReportInvalidNumber(loc, fullText, suffixType ?? TypeSymbol.Int32);
            this.value = 0;
            kind = suffixKind;
            return;
        }

        var digitBody = this.text.ToString(digitsStart, bodyEnd - digitsStart).Replace("_", string.Empty);

        if (isFloat || (suffixType != null && IsFloatLikeType(suffixType)))
        {
            this.value = ParseFloatLiteral(digitBody, suffixType, fullText, numberStart, length);
        }
        else
        {
            this.value = ParseIntegerLiteral(digitBody, radix, suffixType, fullText, numberStart, length);
        }

        kind = suffixKind;
    }

    private (TypeSymbol Type, int Length) TryReadNumericSuffix(bool allowFloatSuffixes, bool isFloatBody)
    {
        // ADR-0044 numeric suffix grammar. Case-insensitive. UL and LU
        // combinations both denote ulong. F/D/M are not legal on hex,
        // octal, or binary integer bodies because F is a hex digit.
        var c0 = Current;
        var c1 = Lookahead;

        if (c0 == 'L' || c0 == 'l')
        {
            if (c1 == 'U' || c1 == 'u')
            {
                return (TypeSymbol.UInt64, 2);
            }

            return (TypeSymbol.Int64, 1);
        }

        if (c0 == 'U' || c0 == 'u')
        {
            if (c1 == 'L' || c1 == 'l')
            {
                return (TypeSymbol.UInt64, 2);
            }

            return (TypeSymbol.UInt32, 1);
        }

        if (allowFloatSuffixes)
        {
            if (c0 == 'F' || c0 == 'f')
            {
                return (TypeSymbol.Float32, 1);
            }

            if (c0 == 'D' || c0 == 'd')
            {
                return (TypeSymbol.Float64, 1);
            }

            if (c0 == 'M' || c0 == 'm')
            {
                return (TypeSymbol.Decimal, 1);
            }
        }

        _ = isFloatBody;
        return (null, 0);
    }

    private static bool IsFloatLikeType(TypeSymbol type)
    {
        return type == TypeSymbol.Float32
            || type == TypeSymbol.Float64
            || type == TypeSymbol.Decimal;
    }

    private object ParseIntegerLiteral(string digitBody, int radix, TypeSymbol suffixType, string fullText, int spanStart, int spanLength)
    {
        // Big enough to hold any 64-bit literal; we narrow into a smaller
        // CLR type based on the suffix or default to int when none is given.
        ulong parsed;
        try
        {
            parsed = radix == 10
                ? ulong.Parse(digitBody, System.Globalization.CultureInfo.InvariantCulture)
                : System.Convert.ToUInt64(digitBody, radix);
        }
        catch (System.Exception)
        {
            var loc = new TextLocation(this.text, new TextSpan(spanStart, spanLength));
            Diagnostics.ReportInvalidNumber(loc, fullText, suffixType ?? TypeSymbol.Int32);
            return suffixType == TypeSymbol.Int64 ? (object)0L
                : suffixType == TypeSymbol.UInt64 ? (object)0UL
                : suffixType == TypeSymbol.UInt32 ? (object)0U
                : (object)0;
        }

        if (suffixType == TypeSymbol.Int64)
        {
            if (parsed > long.MaxValue)
            {
                ReportOverflow(fullText, spanStart, spanLength, TypeSymbol.Int64);
                return 0L;
            }

            return (long)parsed;
        }

        if (suffixType == TypeSymbol.UInt64)
        {
            return parsed;
        }

        if (suffixType == TypeSymbol.UInt32)
        {
            if (parsed > uint.MaxValue)
            {
                ReportOverflow(fullText, spanStart, spanLength, TypeSymbol.UInt32);
                return 0U;
            }

            return (uint)parsed;
        }

        // No suffix → default to int per ADR-0044. Narrow when it fits.
        if (parsed <= int.MaxValue)
        {
            return (int)parsed;
        }

        // Backwards compatibility: hex/octal/binary literals whose bit
        // pattern fits in 32 bits are bit-cast to int (so `0xDEAD_BEEF`
        // yields -559038737 rather than overflowing). Decimal literals
        // still overflow per the obvious arithmetic reading.
        if (radix != 10 && parsed <= uint.MaxValue)
        {
            return (int)(uint)parsed;
        }

        ReportOverflow(fullText, spanStart, spanLength, TypeSymbol.Int32);
        return 0;
    }

    private object ParseFloatLiteral(string digitBody, TypeSymbol suffixType, string fullText, int spanStart, int spanLength)
    {
        var targetType = suffixType ?? TypeSymbol.Float64;

        try
        {
            if (targetType == TypeSymbol.Float32)
            {
                return float.Parse(digitBody, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture);
            }

            if (targetType == TypeSymbol.Decimal)
            {
                return decimal.Parse(digitBody, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture);
            }

            // Float64 default.
            return double.Parse(digitBody, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture);
        }
        catch (System.Exception)
        {
            ReportOverflow(fullText, spanStart, spanLength, targetType);
            if (targetType == TypeSymbol.Float32)
            {
                return 0f;
            }

            if (targetType == TypeSymbol.Decimal)
            {
                return 0m;
            }

            return 0d;
        }
    }

    private void ReportOverflow(string fullText, int spanStart, int spanLength, TypeSymbol type)
    {
        var loc = new TextLocation(this.text, new TextSpan(spanStart, spanLength));
        Diagnostics.ReportInvalidNumber(loc, fullText, type);
    }

    private static bool IsDecimalDigit(char c) => c >= '0' && c <= '9';

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
