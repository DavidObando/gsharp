// <copyright file="Lexer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.Text
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import System.Globalization

/// The GSharp language lexer.
class Lexer {
    private let syntaxTree SyntaxTree
    private let text SourceText
    private let end int32

    // Issue #1677: lexer-local identifier intern table so repeated identifiers (e.g. `foo`
    // used 1000 times in a file) share one string instance for their .Text instead of each
    // occurrence allocating its own substring. Scoped per-Lexer (per-parse), so it never
    // leaks across compilations.
    private let internedIdentifiers Dictionary[string, string] = Dictionary[string, string](StringComparer.Ordinal)

    private var position int32
    private var start int32
    private var kind SyntaxKind
    private var value object?

    // Issue #1677: set by ReadIdentifierOrKeyword when it determines the token is a plain
    // identifier (not a keyword). Lex() reuses this interned string instead of substringing
    // the same range a second time.
    private var internedIdentifierText string?

    // Issue #1602: current interpolation-hole nesting depth. See
    // MaxInterpolationNestingDepth above.
    private var interpolationHoleDepth int32

    // Issue #1602: whether GS0417 has already been reported for this lex, so
    // the failure unwinds with a single diagnostic.
    private var reportedInterpolationNestingTooDeep bool

    /// Initializes a new instance of the (cref:Lexer) class.
    /// @param syntaxTree The source syntax tree that contains the text document to lex from.
    convenience init(syntaxTree SyntaxTree) {
        init(syntaxTree, 0, syntaxTree.Text.Length)
    }

    /// Initializes a new instance of the (cref:Lexer) class that lexes only the
    /// [`start`](paramref)-[`end`](paramref) window of [`syntaxTree`](paramref)'s
    /// text, treating [`end`](paramref) as a virtual end-of-file. Used to re-lex an
    /// interpolated-string hole's expression text directly out of the outer source so the
    /// resulting tokens carry true absolute positions without copying/padding the file
    /// prefix (issue #1605).
    /// @param syntaxTree The source syntax tree that contains the text document to lex from.
    /// @param start The absolute position to start lexing from.
    /// @param end The absolute position, exclusive, at which the lexer reports end-of-file.
    init(syntaxTree SyntaxTree, start int32, end int32) {
        Diagnostics = DiagnosticBag()
        this.syntaxTree = syntaxTree
        this.text = syntaxTree.Text
        this.end = end
        this.position = start
    }

    /// Gets the lexer diagnostics.
    prop Diagnostics DiagnosticBag {
        get;
    }

    private prop Current char -> Peek(0)
    private prop Lookahead char -> Peek(1)

    /// Returns the next syntax token from the source text document.
    /// @returns A syntax token.
    func Lex() SyntaxToken {
        start = position
        kind = SyntaxKind.BadToken
        value = nil
        internedIdentifierText = nil
        switch Current {
            case '\u0000' {
                if position >= end {
                    kind = SyntaxKind.EndOfFileToken
                } else {
                    // Embedded NUL mid-file: distinct from true end-of-file (position >= end).
                    // Report and skip so the rest of the file still lexes (issue #1608).
                    let location = TextLocation(this.text, TextSpan(position, 1))
                    Diagnostics.ReportBadCharacter(location, Current)
                    position++
                }
            }
            case '+' {
                position++
                if Current == '=' {
                    kind = SyntaxKind.PlusEqualsToken
                    position++
                } else if Current == '+' {
                    kind = SyntaxKind.PlusPlusToken
                    position++
                } else {
                    kind = SyntaxKind.PlusToken
                }
            }
            case '-' {
                position++
                if Current == '=' {
                    kind = SyntaxKind.MinusEqualsToken
                    position++
                } else if Current == '-' {
                    kind = SyntaxKind.MinusMinusToken
                    position++
                } else if Current == '>' {
                    kind = SyntaxKind.RightArrowToken
                    position++
                } else {
                    kind = SyntaxKind.MinusToken
                }
            }
            case '*' {
                position++
                if Current == '=' {
                    kind = SyntaxKind.StarEqualsToken
                    position++
                } else {
                    kind = SyntaxKind.StarToken
                }
            }
            case '/' {
                position++
                if Current == '/' && Peek(1) == '/' {
                    ReadDocumentationComment()
                } else if Current == '/' {
                    ReadSingleLineComment()
                } else if Current == '*' {
                    ReadMultiLineComment()
                } else if Current == '=' {
                    kind = SyntaxKind.SlashEqualsToken
                    position++
                } else {
                    kind = SyntaxKind.SlashToken
                }
            }
            case '%' {
                position++
                if Current == '=' {
                    kind = SyntaxKind.PercentEqualsToken
                    position++
                } else {
                    kind = SyntaxKind.PercentToken
                }
            }
            case '(' {
                kind = SyntaxKind.OpenParenthesisToken
                position++
            }
            case ')' {
                kind = SyntaxKind.CloseParenthesisToken
                position++
            }
            case '[' {
                kind = SyntaxKind.OpenSquareBracketToken
                position++
            }
            case ']' {
                kind = SyntaxKind.CloseSquareBracketToken
                position++
            }
            case '{' {
                kind = SyntaxKind.OpenBraceToken
                position++
            }
            case '}' {
                kind = SyntaxKind.CloseBraceToken
                position++
            }
            case ':' {
                position++
                if Current == '=' {
                    kind = SyntaxKind.ColonEqualsToken
                    position++
                } else {
                    kind = SyntaxKind.ColonToken
                }
            }
            case ';' {
                kind = SyntaxKind.SemicolonToken
                position++
            }
            case ',' {
                kind = SyntaxKind.CommaToken
                position++
            }
            case '.' {
                if Peek(1) == '.' && Peek(2) == '.' {
                    kind = SyntaxKind.EllipsisToken
                    position += 3
                } else if Peek(1) == '.' {
                    // Issue #1016: the `..` range/slice operator. Recognised
                    // before the leading-dot float case so `a[..5]` lexes as
                    // `..` `5` rather than `.` `.5`.
                    kind = SyntaxKind.DotDotToken
                    position += 2
                } else if IsDecimalDigit(Peek(1)) {
                    // ADR-0044 leading-dot float literal (`.5`). ReadNumber
                    // detects the leading dot via `Current == '.'` and parses
                    // the digit body as the fractional part.
                    ReadNumber()
                } else {
                    kind = SyntaxKind.DotToken
                    position++
                }
            }
            case '^' {
                position++
                if Current == '=' {
                    kind = SyntaxKind.HatEqualsToken
                    position++
                } else {
                    kind = SyntaxKind.HatToken
                }
            }
            case '~' {
                // ADR-0187: unary one's-complement uses C#'s `~` spelling.
                kind = SyntaxKind.TildeToken
                position++
            }
            case '&' {
                position++
                if Current == '&' {
                    kind = SyntaxKind.AmpersandAmpersandToken
                    position++
                } else if Current == '=' {
                    kind = SyntaxKind.AmpersandEqualsToken
                    position++
                } else if Current == '^' {
                    position++
                    if Current == '=' {
                        kind = SyntaxKind.AmpersandHatEqualsToken
                        position++
                    } else {
                        kind = SyntaxKind.AmpersandHatToken
                    }
                } else {
                    kind = SyntaxKind.AmpersandToken
                }
            }
            case '|' {
                position++
                if Current == '|' {
                    kind = SyntaxKind.PipePipeToken
                    position++
                } else if Current == '=' {
                    kind = SyntaxKind.PipeEqualsToken
                    position++
                } else {
                    kind = SyntaxKind.PipeToken
                }
            }
            case '=' {
                position++
                if Current == '=' {
                    kind = SyntaxKind.EqualsEqualsToken
                    position++
                } else {
                    kind = SyntaxKind.EqualsToken
                }
            }
            case '!' {
                position++
                if Current == '=' {
                    kind = SyntaxKind.BangEqualsToken
                    position++
                } else if Current == '!' {
                    kind = SyntaxKind.BangBangToken
                    position++
                } else {
                    kind = SyntaxKind.BangToken
                }
            }
            case '?' {
                position++
                if Current == '.' {
                    kind = SyntaxKind.QuestionDotToken
                    position++
                } else if Current == '[' {
                    // ADR-0073 / issue #710: `?[` null-conditional indexing
                    // prefix. Recognized only when `[` follows `?` with no
                    // intervening trivia, so a ternary `cond ? [arr] : [arr]`
                    // (where whitespace separates `?` and `[`) keeps lexing
                    // as `QuestionToken` + `OpenSquareBracketToken`.
                    kind = SyntaxKind.QuestionOpenBracketToken
                    position++
                } else if Current == '?' && Peek(1) == '=' {
                    // ADR-0072 / issue #709: `??=` null-coalescing compound
                    // assignment. The doubled-`?` followed by `=` is the
                    // compound-assignment form.
                    kind = SyntaxKind.QuestionQuestionEqualsToken
                    position += 2
                } else if Current == '?' {
                    // Issue #941: `??` binary null-coalescing operator. The
                    // bare doubled-`?` (not followed by `=`) yields the
                    // null-coalescing read `a ?? b`. (The former `?:` Elvis
                    // spelling was removed in favor of `??`.)
                    kind = SyntaxKind.QuestionQuestionToken
                    position++
                } else {
                    kind = SyntaxKind.QuestionToken
                }
            }
            case '<' {
                position++
                if Current == '=' {
                    kind = SyntaxKind.LessOrEqualsToken
                    position++
                } else if Current == '-' {
                    kind = SyntaxKind.LeftArrowToken
                    position++
                } else if Current == '<' {
                    position++
                    if Current == '=' {
                        kind = SyntaxKind.ShiftLeftEqualsToken
                        position++
                    } else {
                        kind = SyntaxKind.ShiftLeftToken
                    }
                } else {
                    kind = SyntaxKind.LessToken
                }
            }
            case '>' {
                position++
                if Current == '=' {
                    kind = SyntaxKind.GreaterOrEqualsToken
                    position++
                } else if Current == '>' {
                    position++
                    if Current == '=' {
                        kind = SyntaxKind.ShiftRightEqualsToken
                        position++
                    } else if Current == '>' {
                        position++
                        if Current == '=' {
                            kind = SyntaxKind.UnsignedShiftRightEqualsToken
                            position++
                        } else {
                            kind = SyntaxKind.UnsignedShiftRightToken
                        }
                    } else {
                        kind = SyntaxKind.ShiftRightToken
                    }
                } else {
                    kind = SyntaxKind.GreaterToken
                }
            }
            case '"' {
                ReadString()
            }
            case '`' {
                ReadRawString()
            }
            case '\'' {
                ReadCharLiteral()
            }
            case '@' {
                kind = SyntaxKind.AtToken
                position++
            }
            case '$' {
                // ADR-0170 / issue #3610: `$` immediately followed by an
                // identifier-start spells an ESCAPED IDENTIFIER — an ordinary
                // IdentifierToken whose semantic name is the characters after
                // the `$` (carried via Value/ValueText) and whose Text keeps
                // the full source spelling for fidelity. Never
                // keyword-classified, so `class $defer {}` declares a type
                // whose metadata name is `defer`. A `$` not followed by an
                // identifier-start keeps the prior bad-character behavior
                // (room for future grammar; `$` inside string literals keeps
                // its interpolation meaning, handled by ReadString).
                if char.IsLetter(Lookahead) || Lookahead == '_' {
                    position++ // consume '$'
                    let nameStart = position
                    while char.IsLetterOrDigit(Current) || Current == '_' {
                        position++
                    }
                    kind = SyntaxKind.IdentifierToken
                    value = this.text.ToString(nameStart, position - nameStart)
                } else {
                    let badDollarLocation = TextLocation(this.text, TextSpan(position, 1))
                    Diagnostics.ReportBadCharacter(badDollarLocation, Current)
                    position++
                }
            }
            case '0', '1', '2', '3', '4', '5', '6', '7', '8', '9' {
                ReadNumber()
            }
            case ' ', '\t', '\n', '\r' {
                ReadWhiteSpace()
            }
            default {
                if Current == 'u' && Lookahead == '8' && (Peek(2) == '"' || Peek(2) == '`') {
                    ReadUtf8String()
                } else if Current == 'b' && Lookahead == '"' {
                    ReadByteString()
                } else if char.IsLetter(Current) || Current == '_' {
                    ReadIdentifierOrKeyword()
                } else if char.IsWhiteSpace(Current) {
                    ReadWhiteSpace()
                } else {
                    let location = TextLocation(this.text, TextSpan(position, 1))
                    Diagnostics.ReportBadCharacter(location, Current)
                    position++
                }
            }
        }
        let length = position - start
        var text string? = SyntaxFacts.GetText(kind)
        if text == nil {
            text = if kind == SyntaxKind.IdentifierToken && internedIdentifierText != nil {
                internedIdentifierText
            } else {
                GetTrivialText(start, length)
            }
        }
        return SyntaxToken(syntaxTree, kind, start, text!!, value)
    }

    // Issue #1677: whitespace runs (indentation, single newlines, blank lines) are a tiny,
    // closed alphabet of immutable strings, so a uniform run (all same char) is looked up
    // in a shared cache instead of substringed fresh every time. Non-uniform whitespace and
    // every other trivial-text kind (comments, numbers, strings) fall back to the substring:
    // their exact text is observed by consumers (for example GSharpFormatter reads
    // WhitespaceToken/CommentToken .Text verbatim to preserve user line breaks and comment
    // content), so it cannot be replaced by a placeholder.
    private func GetTrivialText(start int32, length int32) string {
        if kind == SyntaxKind.WhitespaceToken && length > 0 && length <= WhitespaceRunCacheMaxLength {
            let ch = text[start]
            var uniform = true
            for var i = start + 1; i < start + length; i++ {
                if text[i] != ch {
                    uniform = false
                    break
                }
            }
            if uniform {
                let key = (ch, length)
                if WhitespaceRunCache.TryGetValue(key, out var cached) {
                    return cached
                }
                return WhitespaceRunCache.GetOrAdd(key, this.text.ToString(start, length))
            }
        }
        return this.text.ToString(start, length)
    }

    private func Peek(offset int32) char {
        let index = position + offset
        if index >= end {
            return '\u0000'
        }
        return text[index]
    }

    private func ReadSingleLineComment() {
        // Skip the current slash character
        position++
        let sb = StringBuilder()
        var done = false
        while !done {
            switch Current {
                case '\u0000' {
                    done = true
                }
                case '\r', '\n' {
                    position++
                    done = true
                }
                default {
                    sb.Append(Current)
                    position++
                }
            }
        }
        kind = SyntaxKind.CommentToken
        value = sb.ToString()
    }

    // ADR-0057 §2: exactly three slashes start a doc comment. The first slash was
    // consumed by the Lex() dispatcher; we enter here with Current=='/' and
    // Peek(1)=='/'. We consume the second and third slashes, then strip one optional
    // following space. Everything after (including a 4th slash) is content.
    private func ReadDocumentationComment() {
        // Consume the second and third slashes (first was consumed by Lex dispatcher).
        position += 2
        // Strip one optional leading space (ADR §2).
        if Current == ' ' {
            position++
        }
        let sb = StringBuilder()
        var done = false
        while !done {
            switch Current {
                case '\u0000' {
                    done = true
                }
                case '\r' {
                    if Lookahead == '\n' {
                        position++
                    }
                    position++
                    done = true
                }
                case '\n' {
                    position++
                    done = true
                }
                default {
                    sb.Append(Current)
                    position++
                }
            }
        }
        kind = SyntaxKind.DocumentationCommentToken
        value = sb.ToString()
    }

    private func ReadMultiLineComment() {
        // Skip the current star character
        position++
        let sb = StringBuilder()
        var done = false
        while !done {
            switch Current {
                case '\u0000' {
                    let location = TextLocation(this.text, TextSpan(start, position - start))
                    Diagnostics.ReportUnterminatedComment(location)
                    done = true
                }
                case '*' {
                    if Lookahead == '/' {
                        position += 2
                        done = true
                    } else {
                        sb.Append(Current)
                        position++
                    }
                }
                default {
                    sb.Append(Current)
                    position++
                }
            }
        }
        kind = SyntaxKind.CommentToken
        value = sb.ToString()
    }

    private func ReadRawString() {
        // Backtick-delimited raw strings (Go-style). No escape processing,
        // multi-line allowed, no interpolation. Embedded backticks are not
        // representable; concatenate adjacent raw + interpreted literals to
        // include one (matches Go's choice).
        position++ // consume opening backtick
        let sb = StringBuilder()
        var done = false
        while !done {
            switch Current {
                case '\u0000' {
                    let loc = TextLocation(this.text, TextSpan(start, position - start))
                    Diagnostics.ReportUnterminatedString(loc)
                    done = true
                }
                case '`' {
                    position++
                    done = true
                }
                case '\r' {
                    // Normalize CRLF and bare CR to LF inside raw strings, matching Go's spec.
                    if Lookahead == '\n' {
                        position++
                    }
                    sb.Append('\n')
                    position++
                }
                default {
                    sb.Append(Current)
                    position++
                }
            }
        }
        kind = SyntaxKind.StringToken
        value = sb.ToString()
    }

    private func ReadUtf8String() {
        if Peek(2) == '`' {
            Diagnostics.ReportInvalidUtf8StringLiteral(
                TextLocation(text, TextSpan(start, 3)),
                "Raw UTF-8 delimiters are not supported; use ordinary quoted text escapes."
            )
            position += 2
            ReadRawString()
            kind = SyntaxKind.Utf8StringToken
            value = ImmutableArray[uint8].Empty
            return
        }
        if Peek(3) == '"' && Peek(4) == '"' {
            Diagnostics.ReportInvalidUtf8StringLiteral(
                TextLocation(text, TextSpan(start, 5)),
                "Raw and multiline UTF-8 delimiters are not supported; use ordinary quoted text escapes."
            )
        }
        if !text.IsEncodingValid {
            Diagnostics.ReportInvalidUtf8StringLiteral(
                TextLocation(text, TextSpan(start, 3)),
                "The source file contains invalid encoded characters; repaired source text is not permitted."
            )
        }
        position += 3
        let decoded = StringBuilder()
        let sourceSpans = List[TextSpan]()
        var terminated = false
        while position < end && Current != '\r' && Current != '\n' {
            if Current == '"' {
                position++
                terminated = true
                break
            }
            let pieceStart = position
            var piece = Current.ToString()
            position++
            if piece == "\\" {
                if position >= end || Current == '\r' || Current == '\n' {
                    break
                }
                let escape = Current
                position++
                piece = switch escape {
                    case '0': "\0"
                    case 'a': "\a"
                    case 'b': "\b"
                    case 'f': "\f"
                    case 'n': "\n"
                    case 'r': "\r"
                    case 't': "\t"
                    case 'v': "\v"
                    case '\'': "'"
                    case '"': "\""
                    case '\\': "\\"
                    default: ""
                }
                if escape is 'x' or 'u' or 'U' {
                    let maximum = if escape == 'x' {
                        4
                    } else if escape == 'u' {
                        4
                    } else {
                        8
                    }
                    let minimum = if escape == 'x' {
                        1
                    } else {
                        maximum
                    }
                    var scalar int64 = 0
                    var digits = 0
                    while digits < maximum && IsHexDigit(Current) {
                        scalar = (scalar << 4) | int64(HexValue(Current))
                        digits++
                        position++
                    }
                    if digits < minimum {
                        Diagnostics.ReportInvalidUtf8StringLiteral(
                            TextLocation(text, TextSpan(pieceStart, position - pieceStart)),
                            "The escape requires $minimum to $maximum hexadecimal digits."
                        )
                    } else if escape == 'U' {
                        if scalar > 0x10FFFF || (scalar >= 0xD800 && scalar <= 0xDFFF) {
                            Diagnostics.ReportInvalidUtf8StringLiteral(
                                TextLocation(text, TextSpan(pieceStart, position - pieceStart)),
                                "Expected a Unicode scalar from U+0000 through U+10FFFF."
                            )
                        } else {
                            piece = char.ConvertFromUtf32(int32(scalar))
                        }
                    } else {
                        piece = char(scalar).ToString()
                    }
                } else if piece.Length == 0 {
                    Diagnostics.ReportInvalidUtf8StringLiteral(
                        TextLocation(text, TextSpan(pieceStart, position - pieceStart)),
                        "Unknown text escape."
                    )
                }
            }
            decoded.Append(piece)
            for var index = 0; index < piece.Length; index++ {
                sourceSpans.Add(TextSpan(pieceStart, position - pieceStart))
            }
        }
        if !terminated {
            Diagnostics.ReportUnterminatedString(TextLocation(text, TextSpan(start, 3)))
        }
        let bytes = ImmutableArray.CreateBuilder[uint8]()
        for var index = 0; index < decoded.Length; index++ {
            let unit = decoded[index]
            if char.IsHighSurrogate(unit) && index + 1 < decoded.Length && char.IsLowSurrogate(decoded[index + 1]) {
                AppendUtf8Scalar(bytes, char.ConvertToUtf32(unit, decoded[index + 1]))
                index++
            } else if char.IsSurrogate(unit) {
                Diagnostics.ReportInvalidUtf8StringLiteral(
                    TextLocation(text, sourceSpans[index]),
                    "The decoded text contains an unpaired UTF-16 surrogate."
                )
            } else {
                AppendUtf8Scalar(bytes, int32(unit))
            }
        }
        kind = SyntaxKind.Utf8StringToken
        value = bytes.ToImmutable()
    }

    private func ReadByteString() {
        ValidateByteStringSourceEncoding()
        position += 2
        let bytes = ImmutableArray.CreateBuilder[uint8]()
        var terminated = false
        while position < end && Current != '\r' && Current != '\n' {
            if Current == '"' {
                position++
                terminated = true
                break
            }
            let scalarStart = position
            var scalar = int64(Current)
            if Current == '\\' {
                position++
                if position >= end || Current == '\r' || Current == '\n' {
                    break
                }
                let escape = Current
                position++
                switch escape {
                    case '0' {
                        bytes.Add(0)
                        continue
                    }
                    case 'n' {
                        bytes.Add(10)
                        continue
                    }
                    case 'r' {
                        bytes.Add(13)
                        continue
                    }
                    case 't' {
                        bytes.Add(9)
                        continue
                    }
                    case '\\' {
                        bytes.Add(92)
                        continue
                    }
                    case '"' {
                        bytes.Add(34)
                        continue
                    }
                    case 'x', 'u', 'U' {
                        let count = if escape == 'x' {
                            2
                        } else if escape == 'u' {
                            4
                        } else {
                            8
                        }
                        scalar = 0
                        var consumed = 0
                        while consumed < count && IsHexDigit(Current) {
                            scalar = (scalar << 4) | int64(HexValue(Current))
                            consumed++
                            position++
                        }
                        if consumed != count {
                            Diagnostics.ReportInvalidByteStringLiteral(
                                TextLocation(text, TextSpan(scalarStart, position - scalarStart)),
                                "The escape requires exactly $count hexadecimal digits."
                            )
                            continue
                        }
                        if escape == 'x' {
                            bytes.Add(uint8(scalar))
                            continue
                        }
                    }
                    default {
                        Diagnostics.ReportInvalidByteStringLiteral(
                            TextLocation(text, TextSpan(scalarStart, Math.Min(position, end) - scalarStart)),
                            "Unknown byte-string escape."
                        )
                        continue
                    }
                }
            } else {
                position++
                if char.IsHighSurrogate(char(scalar)) && char.IsLowSurrogate(Current) {
                    scalar = char.ConvertToUtf32(char(scalar), Current)
                    position++
                }
            }
            if scalar > 0x10FFFF || (scalar >= 0xD800 && scalar <= 0xDFFF) {
                Diagnostics.ReportInvalidByteStringLiteral(
                    TextLocation(text, TextSpan(scalarStart, position - scalarStart)),
                    "Expected a Unicode scalar; use a byte escape for arbitrary data."
                )
                continue
            }
            AppendUtf8Scalar(bytes, int32(scalar))
        }
        if !terminated {
            Diagnostics.ReportUnterminatedString(TextLocation(text, TextSpan(start, 2)))
        }
        kind = SyntaxKind.ByteStringToken
        value = bytes.ToImmutable()
    }

    private func ValidateByteStringSourceEncoding() {
        if !text.IsEncodingValid {
            Diagnostics.ReportInvalidByteStringLiteral(
                TextLocation(text, TextSpan(start, 2)),
                "The source file contains invalid encoded characters; byte literals cannot use repaired source text."
            )
        }
    }

    private func AppendUtf8Scalar(bytes ImmutableArray[uint8].Builder, scalar int32) {
        if scalar <= 0x7F {
            bytes.Add(uint8(scalar))
        } else if scalar <= 0x7FF {
            bytes.Add(uint8(0xC0 | (scalar >> 6)))
            bytes.Add(uint8(0x80 | (scalar & 0x3F)))
        } else if scalar <= 0xFFFF {
            bytes.Add(uint8(0xE0 | (scalar >> 12)))
            bytes.Add(uint8(0x80 | ((scalar >> 6) & 0x3F)))
            bytes.Add(uint8(0x80 | (scalar & 0x3F)))
        } else {
            bytes.Add(uint8(0xF0 | (scalar >> 18)))
            bytes.Add(uint8(0x80 | ((scalar >> 12) & 0x3F)))
            bytes.Add(uint8(0x80 | ((scalar >> 6) & 0x3F)))
            bytes.Add(uint8(0x80 | (scalar & 0x3F)))
        }
    }

    private func ReadString() {
        // Skip the current quote
        position++
        let sb = StringBuilder()
        var fragments List[InterpolationFragment]? = nil
        var done = false
        while !done {
            switch Current {
                case '\r', '\n' {
                    // ADR-0055: a raw newline in the literal portion of an
                    // interpolated string is its own diagnostic; in a plain
                    // string it is an unterminated literal. (Multiline holes
                    // are handled inside the `${ … }` scanner and never reach
                    // here.)
                    let newlineLoc = TextLocation(this.text, TextSpan(start, 1))
                    if fragments != nil {
                        Diagnostics.ReportNewlineInInterpolatedStringLiteral(newlineLoc)
                    } else {
                        Diagnostics.ReportUnterminatedString(newlineLoc)
                    }
                    done = true
                }
                case '\u0000' {
                    let location = TextLocation(this.text, TextSpan(start, 1))
                    Diagnostics.ReportUnterminatedString(location)
                    done = true
                }
                case '"' {
                    position++
                    done = true
                }
                case '\\' {
                    // Backslash escape sequences (C#/Go style).
                    position++ // consume '\'
                    switch Current {
                        case '\'' {
                            sb.Append('\'')
                            position++
                        }
                        case '"' {
                            sb.Append('"')
                            position++
                        }
                        case '\\' {
                            sb.Append('\\')
                            position++
                        }
                        case '0' {
                            sb.Append('\u0000')
                            position++
                        }
                        case 'a' {
                            sb.Append('\u0007')
                            position++
                        }
                        case 'b' {
                            sb.Append('\u0008')
                            position++
                        }
                        case 'f' {
                            sb.Append('\u000C')
                            position++
                        }
                        case 'n' {
                            sb.Append('\n')
                            position++
                        }
                        case 'r' {
                            sb.Append('\r')
                            position++
                        }
                        case 't' {
                            sb.Append('\t')
                            position++
                        }
                        case 'v' {
                            sb.Append('\u000B')
                            position++
                        }
                        case 'x' {
                            {
                                position++
                                var hexErr = false
                                sb.Append(ReadHexEscape(start, minDigits: 1, maxDigits: 4, &hexErr))
                            }
                        }
                        case 'u' {
                            {
                                position++
                                var hexErr = false
                                sb.Append(ReadHexEscape(start, minDigits: 4, maxDigits: 4, &hexErr))
                            }
                        }
                        case 'U' {
                            {
                                position++
                                var hexErr = false
                                sb.Append(ReadLongUnicodeEscape(start, &hexErr))
                            }
                        }
                        default {
                            {
                                let escLoc = TextLocation(this.text, TextSpan(position - 1, 2))
                                Diagnostics.ReportInvalidStringEscape(escLoc, Current)
                                if Current != '\u0000' && Current != '\r' && Current != '\n' && Current != '"' {
                                    sb.Append(Current)
                                    position++
                                }
                            }
                        }
                    }
                }
                case '$' {
                    // `$$` escapes to a literal `$`. `$ident` and `${expr}`
                    // open an interpolation segment; bare `$` followed by any
                    // other character is treated as a literal `$` (forward-
                    // compatible: future grammar may attach meaning to it).
                    if Lookahead == '$' {
                        sb.Append('$')
                        position += 2
                        break
                    }
                    if Lookahead == '{' {
                        fragments ??= List[InterpolationFragment]()
                        if sb.Length > 0 {
                            fragments!!.Add(InterpolationFragment.FromText(sb.ToString()))
                            sb.Clear()
                        }
                        position += 2 // consume '${'
                        let exprStart = position
                        // ADR-0055: scan the hole with a delimiter-aware
                        // sub-scanner that tracks ()[]{} nesting, skips nested
                        // string/char literals (recursively, so a nested
                        // interpolation is handled) and //, /* */ comments, and
                        // permits newlines. The hole ends at the matching
                        // top-level `}`.
                        if !ScanInterpolationHole(exprStart) {
                            done = true
                            break
                        }
                        let exprText = this.text.ToString(exprStart, position - exprStart)
                        fragments!!.Add(InterpolationFragment.FromExpression(exprText, exprStart))
                        position++ // consume '}'
                        break
                    }
                    if char.IsLetter(Lookahead) || Lookahead == '_' {
                        fragments ??= List[InterpolationFragment]()
                        if sb.Length > 0 {
                            fragments!!.Add(InterpolationFragment.FromText(sb.ToString()))
                            sb.Clear()
                        }
                        position++ // consume '$'
                        let idStart = position
                        while char.IsLetterOrDigit(Current) || Current == '_' {
                            position++
                        }
                        let idText = this.text.ToString(idStart, position - idStart)
                        fragments!!.Add(InterpolationFragment.FromExpression(idText, idStart))
                        break
                    }
                    sb.Append('$')
                    position++
                }
                default {
                    sb.Append(Current)
                    position++
                }
            }
        }
        if fragments == nil {
            kind = SyntaxKind.StringToken
            value = sb.ToString()
        } else {
            if sb.Length > 0 {
                fragments.Add(InterpolationFragment.FromText(sb.ToString()))
            }
            kind = SyntaxKind.InterpolatedStringToken
            value = InterpolationFragments(fragments.ToImmutableArray())
        }
    }

    /// ADR-0055 delimiter-aware interpolation-hole scanner. Assumes the opening
    /// `${` has already been consumed and (cref:position) sits at
    /// the first character of the hole body. Advances to the matching top-level
    /// `}` (left un-consumed for the caller), tracking `()[]{}`
    /// nesting and skipping nested string/char literals (recursively, so an
    /// inner interpolation is handled) and `//` / `/* */` comments.
    /// Newlines are permitted, so multiline holes are legal. Returns
    /// `false` (after reporting) if the hole is unterminated.
    /// @param holeStart Source offset of the hole body (for diagnostics).
    /// @returns `true` if the hole closed normally.
    private func ScanInterpolationHole(holeStart int32) bool {
        // Issue #1602: bound the ScanInterpolationHole ↔
        // SkipInterpolationNestedLiteral mutual recursion. Past the limit,
        // report GS0417 once and fail the whole hole scan; the failure
        // propagates outward (see SkipInterpolationNestedLiteral) so the
        // enclosing string lex stops cleanly instead of overflowing the stack.
        if interpolationHoleDepth >= MaxInterpolationNestingDepth {
            if !reportedInterpolationNestingTooDeep {
                reportedInterpolationNestingTooDeep = true
                let loc = TextLocation(this.text, TextSpan(holeStart, 1))
                Diagnostics.ReportNestingTooDeep(loc)
            }
            return false
        }
        interpolationHoleDepth++
        try {
            return ScanInterpolationHoleCore(holeStart)
        } finally {
            interpolationHoleDepth--
        }
    }

    private func ScanInterpolationHoleCore(holeStart int32) bool {
        // Issue #1609: track open delimiters by kind instead of a single
        // shared counter. A stray/mismatched ')' or ']' must not decrement
        // past the hole's own '{' — that let a later legit '}' slip through
        // unmatched and swallow the rest of the file into one token.
        let openDelimiters = Stack[char]()
        while true {
            let c = Current
            if c == '\u0000' {
                let loc = TextLocation(this.text, TextSpan(holeStart, 1))
                Diagnostics.ReportUnterminatedInterpolationHole(loc)
                return false
            }
            if (c == 'b' && Lookahead == '"') || (c == 'u' && Lookahead == '8' && Peek(2) == '"') {
                position += if c == 'b' {
                    1
                } else {
                    2
                }
                if !SkipInterpolationNestedLiteral('"', interpolate: false) {
                    return false
                }
                continue
            }
            if char.IsLetter(c) || c == '_' || (c == '$' && (char.IsLetter(Lookahead) || Lookahead == '_')) {
                position++
                while char.IsLetterOrDigit(Current) || Current == '_' {
                    position++
                }
                continue
            }
            if c == '"' || c == '\'' {
                if !SkipInterpolationNestedLiteral(c) {
                    // Issue #1602: a nested hole ran past the nesting limit —
                    // abandon this hole too so the failure reaches the string
                    // lexer without further recursion.
                    return false
                }
                continue
            }
            if c == '/' && Lookahead == '/' {
                while Current != '\u0000' && Current != '\r' && Current != '\n' {
                    position++
                }
                continue
            }
            if c == '/' && Lookahead == '*' {
                position += 2
                while Current != '\u0000' && !(Current == '*' && Lookahead == '/') {
                    position++
                }
                if Current != '\u0000' {
                    position += 2 // consume '*/'

                }
                continue
            }
            if c == '(' || c == '[' || c == '{' {
                openDelimiters.Push(c)
            } else if c == ')' {
                if openDelimiters.Count > 0 && openDelimiters.Peek() == '(' {
                    openDelimiters.Pop()
                }
                // else: stray/mismatched ')' — ignore, nothing open to close.

            } else if c == ']' {
                if openDelimiters.Count > 0 && openDelimiters.Peek() == '[' {
                    openDelimiters.Pop()
                }
                // else: stray/mismatched ']' — ignore, nothing open to close.

            } else if c == '}' {
                if openDelimiters.Count == 0 {
                    return true // matches the hole's own '{'; leave it for the caller

                }
                if openDelimiters.Peek() == '{' {
                    openDelimiters.Pop()
                }
                // else: stray/mismatched '}' closing a '(' or '[' — ignore.

            }
            position++
        }
    }

    /// Skips a nested string or character literal inside an interpolation hole.
    /// Mirrors the real literal lexers: a double-quoted string uses backslash
    /// escapes (`\"`) and may itself contain a nested
    /// `${ … }` interpolation; a single-quoted char literal uses backslash
    /// escapes. (cref:position) starts on the opening delimiter.
    /// @param quote The opening delimiter (`"` or `'`).
    /// @param interpolate Whether a nested double-quoted literal admits interpolation holes.
    /// @returns `false` when a nested interpolation hole
    /// exceeded the nesting limit (issue #1602), so the caller must abandon
    /// its own scan; `true` otherwise.
    private func SkipInterpolationNestedLiteral(quote char, interpolate bool = true) bool {
        position++ // consume opening delimiter
        if quote == '"' {
            while position < end && (!interpolate || Current != '\u0000') && Current != '\r' && Current != '\n' {
                if Current == '\\' && Lookahead != '\u0000' {
                    position += 2 // skip escaped character
                    continue
                }
                if Current == '"' {
                    position++ // closing quote
                    return true
                }
                if interpolate && Current == '$' && Lookahead == '{' {
                    position += 2 // consume nested '${'
                    if !ScanInterpolationHole(position) {
                        // Issue #1602: propagate the nested failure so every
                        // enclosing hole unwinds instead of rescanning the
                        // same deeply nested region.
                        return false
                    }
                    position++ // consume nested '}'
                    continue
                }
                position++
            }
            return true // unterminated; the outer scanner reports at EOF/newline

        }
        // Single-quoted character literal: backslash escapes a single char.
        while Current != '\u0000' && Current != '\r' && Current != '\n' {
            if Current == '\\' && Lookahead != '\u0000' {
                position += 2
                continue
            }
            if Current == '\'' {
                position++
                return true
            }
            position++
        }
        return true
    }

    private func ReadWhiteSpace() {
        while char.IsWhiteSpace(Current) {
            position++
        }
        kind = SyntaxKind.WhitespaceToken
    }

    private func ReadCharLiteral() {
        // ADR-0046 single-quote character literal. Exactly one Unicode code
        // unit (or one escape sequence) between the delimiters; line
        // terminators inside the literal are diagnostics; unknown escapes
        // are diagnostics.
        let literalStart = position
        position++ // consume opening '
        var produced = '\u0000'
        var sawChar = false
        var errored = false
        if Current == '\u0000' || Current == '\r' || Current == '\n' {
            let loc = TextLocation(this.text, TextSpan(literalStart, position - literalStart))
            Diagnostics.ReportUnterminatedCharLiteral(loc)
            value = '\u0000'
            kind = SyntaxKind.CharacterToken
            return
        }
        if Current == '\'' {
            // Empty literal: ''.
            position++
            let loc = TextLocation(this.text, TextSpan(literalStart, position - literalStart))
            Diagnostics.ReportEmptyCharLiteral(loc)
            value = '\u0000'
            kind = SyntaxKind.CharacterToken
            return
        }
        if Current == '\\' {
            // Escape sequence.
            position++ // consume '\'
            switch Current {
                case '\'' {
                    produced = '\''
                    position++
                }
                case '"' {
                    produced = '"'
                    position++
                }
                case '\\' {
                    produced = '\\'
                    position++
                }
                case '0' {
                    produced = '\u0000'
                    position++
                }
                case 'a' {
                    produced = '\u0007'
                    position++
                }
                case 'b' {
                    produced = '\u0008'
                    position++
                }
                case 'f' {
                    produced = '\u000C'
                    position++
                }
                case 'n' {
                    produced = '\n'
                    position++
                }
                case 'r' {
                    produced = '\r'
                    position++
                }
                case 't' {
                    produced = '\t'
                    position++
                }
                case 'v' {
                    produced = '\u000B'
                    position++
                }
                case 'x' {
                    position++
                    produced = ReadHexEscape(literalStart, minDigits: 1, maxDigits: 4, &errored)
                }
                case 'u' {
                    position++
                    produced = ReadHexEscape(literalStart, minDigits: 4, maxDigits: 4, &errored)
                }
                case 'U' {
                    position++
                    produced = ReadLongUnicodeEscape(literalStart, &errored)
                }
                default {
                    {
                        let loc = TextLocation(this.text, TextSpan(literalStart, position - literalStart + 1))
                        Diagnostics.ReportInvalidCharEscape(loc, Current)
                        produced = Current
                        if Current != '\u0000' && Current != '\r' && Current != '\n' && Current != '\'' {
                            position++
                        }
                        errored = true
                    }
                }
            }
            sawChar = true
        } else {
            produced = Current
            position++
            sawChar = true
        }
        // After the body, require the closing quote and exactly one character.
        if Current == '\'' {
            position++
        } else {
            // Multi-codepoint literal (e.g. 'ab') or missing closing quote.
            // Consume up to the matching quote / line terminator so the parser
            // recovers cleanly.
            let bodyStart = position
            while Current != '\'' && Current != '\u0000' && Current != '\r' && Current != '\n' {
                position++
            }
            let loc = TextLocation(this.text, TextSpan(literalStart, position - literalStart))
            if Current == '\'' {
                if !errored {
                    Diagnostics.ReportMultiCharCharLiteral(loc)
                }
                position++
            } else {
                Diagnostics.ReportUnterminatedCharLiteral(loc)
            }
        }
        kind = SyntaxKind.CharacterToken
        value = produced
    }

    private func ReadHexEscape(literalStart int32, minDigits int32, maxDigits int32, ref errored bool) char {
        let digitsStart = position
        var consumed = 0
        var accumulator = 0
        while consumed < maxDigits && IsHexDigit(Current) {
            accumulator = (accumulator << 4) | HexValue(Current)
            position++
            consumed++
        }
        if consumed < minDigits {
            let loc = TextLocation(this.text, TextSpan(literalStart, position - literalStart))
            Diagnostics.ReportInvalidUnicodeEscape(loc)
            errored = true
        }
        return char(accumulator)
    }

    private func ReadLongUnicodeEscape(literalStart int32, ref errored bool) char {
        // \U requires exactly 8 hex digits. Values > 0xFFFF cannot fit in a
        // single UTF-16 code unit and so cannot be represented in a `char`
        // literal (per ADR-0046).
        var consumed = 0
        var accumulator int64 = 0
        while consumed < 8 && IsHexDigit(Current) {
            accumulator = (accumulator << 4) | int64(HexValue(Current))
            position++
            consumed++
        }
        if consumed < 8 || accumulator > int64(0xFFFF) {
            let loc = TextLocation(this.text, TextSpan(literalStart, position - literalStart))
            Diagnostics.ReportInvalidUnicodeEscape(loc)
            errored = true
        }
        return char((accumulator & int64(0xFFFF)))
    }

    private func ReadNumber() {
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
        let numberStart = position
        var radix = 10
        var digitsStart = position
        let startedWithDot = Current == '.'
        if !startedWithDot && Current == '0' && (Lookahead == 'x' || Lookahead == 'X') {
            radix = 16
            position += 2
            digitsStart = position
        } else if !startedWithDot && Current == '0' && (Lookahead == 'o' || Lookahead == 'O') {
            radix = 8
            position += 2
            digitsStart = position
        } else if !startedWithDot && Current == '0' && (Lookahead == 'b' || Lookahead == 'B') {
            radix = 2
            position += 2
            digitsStart = position
        }
        // Disallow leading underscore in a decimal literal (which is impossible
        // here because the dispatcher only routes digits → ReadNumber, but kept
        // explicit for clarity). Underscore IS allowed immediately after a
        // base prefix per Go's spec (e.g., `0x_FF`).
        var sawIntDigit = false
        var last = '\u0000'
        if startedWithDot {
            // Consume the leading '.' and parse the fractional digit body.
            // We deliberately leave digitsStart at numberStart so the dot
            // is included in the substring passed to ParseFloatLiteral.
            last = Current
            position++
            while true {
                let c = Current
                if c == '_' {
                    last = c
                    position++
                    continue
                }
                if !IsDecimalDigit(c) {
                    break
                }
                sawIntDigit = true
                last = c
                position++
            }
        } else {
            while true {
                let c = Current
                if c == '_' {
                    last = c
                    position++
                    continue
                }
                if !IsDigitForRadix(c, radix) {
                    break
                }
                sawIntDigit = true
                last = c
                position++
            }
        }
        // After the integer body, decide whether this is a float. Only base-10
        // literals can become floats.
        var isFloat = startedWithDot
        if radix == 10 {
            // Fractional part: a '.' followed by at least one digit. A bare
            // trailing dot (`1.`) is intentionally not consumed here so that
            // member access like `(1).ToString()` stays unambiguous — float
            // literals must have a digit on at least one side of the dot.
            if !startedWithDot && Current == '.' && IsDecimalDigit(Lookahead) {
                isFloat = true
                last = Current
                position++ // consume '.'
                while true {
                    let c = Current
                    if c == '_' {
                        last = c
                        position++
                        continue
                    }
                    if !IsDecimalDigit(c) {
                        break
                    }
                    last = c
                    position++
                }
            }
            // Exponent: e/E [+/-] digits
            if (Current == 'e' || Current == 'E') &&
                (IsDecimalDigit(Lookahead) || ((Lookahead == '+' || Lookahead == '-') && IsDecimalDigit(Peek(2)))) {
                isFloat = true
                last = Current
                position++ // consume 'e'
                if Current == '+' || Current == '-' {
                    last = Current
                    position++
                }
                while true {
                    let c = Current
                    if c == '_' {
                        last = c
                        position++
                        continue
                    }
                    if !IsDecimalDigit(c) {
                        break
                    }
                    last = c
                    position++
                }
            }
        }
        // Optional type-pin suffix. In hex/oct/bin mode `F` and `D` are
        // valid hex digits, so only L / U / UL combinations are accepted
        // after non-decimal-radix integer bodies. In decimal-radix or
        // float bodies, every ADR-0044 suffix is accepted.
        var suffixKind SyntaxKind
        let (suffixType, suffixLen) = TryReadNumericSuffix(radix == 10 || isFloat, isFloat)
        position += suffixLen
        suffixKind = SyntaxKind.NumberToken
        let bodyEnd = position - suffixLen
        let length = position - numberStart
        let fullText = this.text.ToString(numberStart, length)
        let sawAnyDigit = sawIntDigit || isFloat
        if !sawAnyDigit || last == '_' {
            let loc = TextLocation(this.text, TextSpan(numberStart, length))
            Diagnostics.ReportInvalidNumber(loc, fullText, suffixType ?? TypeSymbol.Int32)
            this.value = 0
            kind = suffixKind
            return
        }
        let digitBody = this.text.ToString(digitsStart, bodyEnd - digitsStart).Replace("_", string.Empty)
        if isFloat || (suffixType != nil && IsFloatLikeType(suffixType)) {
            this.value = ParseFloatLiteral(digitBody, suffixType, fullText, numberStart, length)
        } else {
            this.value = ParseIntegerLiteral(digitBody, radix, suffixType, fullText, numberStart, length)
        }
        kind = suffixKind
    }

    private func TryReadNumericSuffix(allowFloatSuffixes bool, isFloatBody bool)(Type TypeSymbol?, Length int32) {
        // ADR-0044 numeric suffix grammar. Case-insensitive. UL and LU
        // combinations both denote ulong. F/D/M are not legal on hex,
        // octal, or binary integer bodies because F is a hex digit.
        let c0 = Current
        let c1 = Lookahead
        if c0 == 'L' || c0 == 'l' {
            if c1 == 'U' || c1 == 'u' {
                return (TypeSymbol.UInt64, 2)
            }
            return (TypeSymbol.Int64, 1)
        }
        if c0 == 'U' || c0 == 'u' {
            if c1 == 'L' || c1 == 'l' {
                return (TypeSymbol.UInt64, 2)
            }
            return (TypeSymbol.UInt32, 1)
        }
        if allowFloatSuffixes {
            if c0 == 'F' || c0 == 'f' {
                return (TypeSymbol.Float32, 1)
            }
            if c0 == 'D' || c0 == 'd' {
                return (TypeSymbol.Float64, 1)
            }
            if c0 == 'M' || c0 == 'm' {
                return (TypeSymbol.Decimal, 1)
            }
        }
        return (nil, 0)
    }

    private func ParseIntegerLiteral(
        digitBody string,
        radix int32,
        suffixType TypeSymbol?,
        fullText string,
        spanStart int32,
        spanLength int32
    ) object {
        // Big enough to hold any 64-bit literal; we narrow into a smaller
        // CLR type based on the suffix or default to int when none is given.
        var parsed uint64
        try {
            parsed = if radix == 10 {
                uint64.Parse(digitBody, CultureInfo.InvariantCulture)
            } else {
                Convert.ToUInt64(digitBody, radix)
            }
        } catch (Exception) {
            // The body parses but exceeds the 64-bit carrier: it is not
            // representable in any integer type. For an un-suffixed literal the
            // widest §6.4.5.3 candidate is uint64, so report against that.
            let loc = TextLocation(this.text, TextSpan(spanStart, spanLength))
            Diagnostics.ReportInvalidNumber(loc, fullText, suffixType ?? TypeSymbol.UInt64)
            return if suffixType == TypeSymbol.Int64 {
                object(0L)
            } else {
                (
                    if suffixType == TypeSymbol.UInt64 {
                        object(0UL)
                    } else {
                        (
                            if suffixType == TypeSymbol.UInt32 {
                                object(0U)
                            } else {
                                object(0)
                            }
                        )
                    }
                )
            }
        }
        if suffixType == TypeSymbol.Int64 {
            if parsed > uint64(int64.MaxValue) {
                ReportOverflow(fullText, spanStart, spanLength, TypeSymbol.Int64)
                return 0L
            }
            return int64(parsed)
        }
        if suffixType == TypeSymbol.UInt64 {
            return parsed
        }
        if suffixType == TypeSymbol.UInt32 {
            if parsed > uint64(uint32.MaxValue) {
                ReportOverflow(fullText, spanStart, spanLength, TypeSymbol.UInt32)
                return 0U
            }
            return uint32(parsed)
        }
        // No suffix → C# §6.4.5.3 integer-literal type inference. The literal
        // takes the type of the first of int32, uint32, int64, uint64 in which
        // its value can be represented. A bare literal that fits int32 stays
        // int32; larger in-range values widen to the smallest fitting type and
        // can then constant-narrow to a target type (issue #1183).
        if parsed <= uint64(int32.MaxValue) {
            return int32(parsed)
        }
        // Backwards compatibility: hex/octal/binary literals whose bit
        // pattern fits in 32 bits are bit-cast to int (so `0xDEAD_BEEF`
        // yields -559038737 rather than widening to uint32). Decimal literals
        // follow the §6.4.5.3 lattice below instead.
        if radix != 10 && parsed <= uint64(uint32.MaxValue) {
            return int32(uint32(parsed))
        }
        // §6.4.5.3 widening lattice: uint32 → int64 → uint64. `parsed` is a
        // ulong, so a value that overflowed uint64 already threw above and was
        // reported; anything reaching here is representable as uint64.
        if parsed <= uint64(uint32.MaxValue) {
            return uint32(parsed)
        }
        if parsed <= uint64(int64.MaxValue) {
            return int64(parsed)
        }
        return parsed
    }

    private func ParseFloatLiteral(
        digitBody string,
        suffixType TypeSymbol?,
        fullText string,
        spanStart int32,
        spanLength int32
    ) object {
        let targetType = suffixType ?? TypeSymbol.Float64
        try {
            if targetType == TypeSymbol.Float32 {
                let f = float32.Parse(digitBody, NumberStyles.Float, CultureInfo.InvariantCulture)
                // G# has no float-infinity literal syntax, so any non-finite
                // result here means the literal overflowed (net10.0's
                // float.Parse returns ±Infinity instead of throwing).
                if float32.IsInfinity(f) {
                    throw OverflowException()
                }
                return f
            }
            if targetType == TypeSymbol.Decimal {
                return decimal.Parse(digitBody, NumberStyles.Float, CultureInfo.InvariantCulture)
            }
            // Float64 default.
            let d = float64.Parse(digitBody, NumberStyles.Float, CultureInfo.InvariantCulture)
            if float64.IsInfinity(d) {
                throw OverflowException()
            }
            return d
        } catch (Exception) {
            ReportOverflow(fullText, spanStart, spanLength, targetType)
            if targetType == TypeSymbol.Float32 {
                return 0f
            }
            if targetType == TypeSymbol.Decimal {
                return 0m
            }
            return 0d
        }
    }

    private func ReportOverflow(fullText string, spanStart int32, spanLength int32, type TypeSymbol) {
        let loc = TextLocation(this.text, TextSpan(spanStart, spanLength))
        Diagnostics.ReportInvalidNumber(loc, fullText, type)
    }

    private func ReadIdentifierOrKeyword() {
        // Identifiers start with a letter or underscore (the caller has verified
        // the first character) and continue with letters, digits, or underscores.
        while char.IsLetterOrDigit(Current) || Current == '_' {
            position++
        }
        let length = position - start
        let text = this.text.ToString(start, length)
        kind = SyntaxFacts.GetKeywordKind(text)
        if kind == SyntaxKind.IdentifierToken {
            // Issue #1677: intern so repeated identifiers share one string, and stash it so
            // Lex() below doesn't substring the same source range a second time.
            if !internedIdentifiers.TryGetValue(text, out var interned) {
                interned = text
                internedIdentifiers.Add(text, text)
            }
            internedIdentifierText = interned
        }
    }

    shared {
        // Issue #1602: hard limit on the nesting depth of string-interpolation
        // holes. ScanInterpolationHole and SkipInterpolationNestedLiteral are
        // mutually recursive (`"${"${"${…`), so without a guard a few kilobytes of
        // nested interpolation kill the process with an uncatchable
        // StackOverflowException. The limit is deliberately modest: each nesting
        // level later costs a full nested SyntaxTree.Parse on the same call stack
        // when the parser parses the hole's expression text.
        private const MaxInterpolationNestingDepth int32 = 32

        // Issue #1677: uniform-run whitespace text (all-space or all-tab indentation, single
        // newlines, etc.) is shared process-wide instead of re-substringed per token, since it
        // is immutable and identical across files/lexers. Kept small and static (not tied to any
        // one lexer instance) because whitespace runs are a closed, tiny alphabet. Runs longer
        // than WhitespaceRunCacheMaxLength bypass the cache so the static table stays bounded
        // (a few whitespace chars x lengths 1..MaxLength) in a long-lived language-server process;
        // long uniform runs are rare and the per-occurrence win is dominated by short indent runs.
        private const WhitespaceRunCacheMaxLength int32 = 64

        private let WhitespaceRunCache ConcurrentDictionary[(Ch char, Length int32), string] = ConcurrentDictionary[
            (Ch char, Length int32),
            string
        ]()
        private func IsHexDigit(c char) bool -> (c >= '0' && c <= '9') ||
            (c >= 'a' && c <= 'f') ||
            (c >= 'A' && c <= 'F')

        private func HexValue(c char) int32 {
            if c >= '0' && c <= '9' {
                return c - '0'
            }
            if c >= 'a' && c <= 'f' {
                return c - 'a' + 10
            }
            return c - 'A' + 10
        }

        private func IsFloatLikeType(type TypeSymbol) bool {
            return type == TypeSymbol.Float32 || type == TypeSymbol.Float64 || type == TypeSymbol.Decimal
        }

        private func IsDecimalDigit(c char) bool -> c >= '0' && c <= '9'

        private func IsDigitForRadix(c char, radix int32) bool {
            return switch radix {
                case 2: c >= '0' && c <= '1'
                case 8: c >= '0' && c <= '7'
                case 10: c >= '0' && c <= '9'
                case 16: (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
                default: false
            }
        }
    }
}
