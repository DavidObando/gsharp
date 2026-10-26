// <copyright file="SyntaxFacts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System
import System.Collections.Generic

/// Utility functions related to the language syntax.
shared class SyntaxFacts {
    internal func IsUtf8LiteralRepresentation(syntax ExpressionSyntax) bool -> switch syntax {
        case literal is LiteralExpressionSyntax: literal.LiteralToken.Kind == SyntaxKind.Utf8StringToken
        case parenthesized is ParenthesizedExpressionSyntax: IsUtf8LiteralRepresentation(parenthesized.Expression)
        case binary is BinaryExpressionSyntax: binary
            .OperatorToken
            .Kind == SyntaxKind.PlusToken &&
            IsUtf8LiteralRepresentation(binary.Left) &&
            IsUtf8LiteralRepresentation(binary.Right)
        default: false
    }

    /// Determines whether a formatter may introduce a line break between two
    /// significant tokens without crossing one of G#'s newline-sensitive
    /// grammar boundaries (ADR-0179).
    /// @param left The token before the candidate break.
    /// @param right The token after the candidate break.
    /// @returns `true` when a new line break is grammar-safe.
    func IsBreakLegalBetween(left SyntaxToken, right SyntaxToken) bool {
        ArgumentNullException.ThrowIfNull(left, paramName: "left")
        ArgumentNullException.ThrowIfNull(right, paramName: "right")
        // An open range ends at a newline, postfix continuations stop at a
        // newline, and a leading star starts a dereference statement.
        if left.Kind == SyntaxKind.DotDotToken ||
            (
            right.Kind is SyntaxKind.StarToken or
                SyntaxKind.OpenParenthesisToken or
                SyntaxKind.OpenBraceToken or
                SyntaxKind.PlusPlusToken or
                SyntaxKind.MinusMinusToken
        ) {
            return false
        }
        // These statements carry an optional same-line operand/target. A
        // formatter must not split the keyword from one that parsed.
        if (
            left.Kind is SyntaxKind.ReturnKeyword or
                SyntaxKind.BreakKeyword or
                SyntaxKind.ContinueKeyword or
                SyntaxKind.FallthroughKeyword or
                SyntaxKind.ThrowKeyword
        ) {
            return false
        }
        // Pattern designations and contextual type trials are also
        // same-line constructs. Conservatively keep adjacent identifiers on
        // the same line; the layout engine has no useful wrap point here.
        return left.Kind != SyntaxKind.IdentifierToken || right.Kind != SyntaxKind.IdentifierToken
    }

    /// Determines whether canonical layout requires a line break between two
    /// significant tokens (ADR-0179).
    /// @param left The token before the boundary.
    /// @param right The token after the boundary.
    /// @returns `true` when the boundary is always a line break.
    func IsBreakRequiredBetween(left SyntaxToken, right SyntaxToken) bool {
        ArgumentNullException.ThrowIfNull(left, paramName: "left")
        ArgumentNullException.ThrowIfNull(right, paramName: "right")
        // A `//` comment runs to the end of its line, so the next token is
        // necessarily on a new one. A `/* */` comment does not: it can sit
        // mid-expression, where a break would cross a newline-sensitive
        // boundary and change the program.
        return left.Kind == SyntaxKind.DocumentationCommentToken ||
            left.Kind == SyntaxKind.SemicolonToken ||
            (left.Kind == SyntaxKind.CommentToken && left.Text.StartsWith("//", StringComparison.Ordinal))
    }

    /// If the given token is a compound assignment operator (e.g. `+=`),
    /// returns the underlying binary operator kind (e.g. `+`).
    /// @param kind The candidate compound assignment token kind.
    /// @param baseOperatorKind The base binary operator kind, if any.
    /// @returns `true` if the token is a compound assignment operator.
    func TryGetCompoundAssignmentBaseOperator(kind SyntaxKind, out baseOperatorKind SyntaxKind) bool {
        switch kind {
            case SyntaxKind.PlusEqualsToken {
                baseOperatorKind = SyntaxKind.PlusToken
                return true
            }
            case SyntaxKind.MinusEqualsToken {
                baseOperatorKind = SyntaxKind.MinusToken
                return true
            }
            case SyntaxKind.StarEqualsToken {
                baseOperatorKind = SyntaxKind.StarToken
                return true
            }
            case SyntaxKind.SlashEqualsToken {
                baseOperatorKind = SyntaxKind.SlashToken
                return true
            }
            case SyntaxKind.PercentEqualsToken {
                baseOperatorKind = SyntaxKind.PercentToken
                return true
            }
            case SyntaxKind.HatEqualsToken {
                baseOperatorKind = SyntaxKind.HatToken
                return true
            }
            case SyntaxKind.AmpersandEqualsToken {
                baseOperatorKind = SyntaxKind.AmpersandToken
                return true
            }
            case SyntaxKind.PipeEqualsToken {
                baseOperatorKind = SyntaxKind.PipeToken
                return true
            }
            case SyntaxKind.AmpersandHatEqualsToken {
                baseOperatorKind = SyntaxKind.AmpersandHatToken
                return true
            }
            case SyntaxKind.ShiftLeftEqualsToken {
                baseOperatorKind = SyntaxKind.ShiftLeftToken
                return true
            }
            case SyntaxKind.ShiftRightEqualsToken {
                baseOperatorKind = SyntaxKind.ShiftRightToken
                return true
            }
            case SyntaxKind.UnsignedShiftRightEqualsToken {
                baseOperatorKind = SyntaxKind.UnsignedShiftRightToken
                return true
            }
            default {
                baseOperatorKind = SyntaxKind.BadToken
                return false
            }
        }
    }

    /// Given a string, if it's a language keyword, this method will return
    /// the syntax kind for that keyword.
    /// @param text The text to verify.
    /// @returns The syntax kind associated to the text.
    func GetKeywordKind(text string) SyntaxKind {
        switch text {
            case "as" {
                return SyntaxKind.AsKeyword
            }
            case "async" {
                return SyntaxKind.AsyncKeyword
            }
            case "await" {
                return SyntaxKind.AwaitKeyword
            }
            case "break" {
                return SyntaxKind.BreakKeyword
            }
            case "case" {
                return SyntaxKind.CaseKeyword
            }
            case "catch" {
                return SyntaxKind.CatchKeyword
            }
            case "chan" {
                return SyntaxKind.ChanKeyword
            }
            case "class" {
                return SyntaxKind.ClassKeyword
            }
            case "const" {
                return SyntaxKind.ConstKeyword
            }
            case "continue" {
                return SyntaxKind.ContinueKeyword
            }
            case "default" {
                return SyntaxKind.DefaultKeyword
            }
            case "defer" {
                return SyntaxKind.DeferKeyword
            }
            case "do" {
                return SyntaxKind.DoKeyword
            }
            case "else" {
                return SyntaxKind.ElseKeyword
            }
            case "enum" {
                return SyntaxKind.EnumKeyword
            }
            case "false" {
                return SyntaxKind.FalseKeyword
            }
            case "fallthrough" {
                return SyntaxKind.FallthroughKeyword
            }
            case "finally" {
                return SyntaxKind.FinallyKeyword
            }
            case "for" {
                return SyntaxKind.ForKeyword
            }
            case "func" {
                return SyntaxKind.FuncKeyword
            }
            case "go" {
                return SyntaxKind.GoKeyword
            }
            case "goto" {
                return SyntaxKind.GotoKeyword
            }
            case "guard" {
                return SyntaxKind.GuardKeyword
            }
            case "if" {
                return SyntaxKind.IfKeyword
            }
            case "import" {
                return SyntaxKind.ImportKeyword
            }
            case "interface" {
                return SyntaxKind.InterfaceKeyword
            }
            case "internal" {
                return SyntaxKind.InternalKeyword
            }
            case "is" {
                return SyntaxKind.IsKeyword
            }
            case "let" {
                return SyntaxKind.LetKeyword
            }
            case "map" {
                return SyntaxKind.MapKeyword
            }
            case "nil" {
                return SyntaxKind.NilKeyword
            }
            case "open" {
                return SyntaxKind.OpenKeyword
            }
            case "operator" {
                return SyntaxKind.OperatorKeyword
            }
            case "override" {
                return SyntaxKind.OverrideKeyword
            }
            case "package" {
                return SyntaxKind.PackageKeyword
            }
            case "private" {
                return SyntaxKind.PrivateKeyword
            }
            case "protected" {
                return SyntaxKind.ProtectedKeyword
            }
            case "public" {
                return SyntaxKind.PublicKeyword
            }
            case "range" {
                return SyntaxKind.RangeKeyword
            }
            case "rethrow" {
                return SyntaxKind.RethrowKeyword
            }
            case "return" {
                return SyntaxKind.ReturnKeyword
            }
            case "scope" {
                return SyntaxKind.ScopeKeyword
            }
            case "sealed" {
                return SyntaxKind.SealedKeyword
            }
            case "select" {
                return SyntaxKind.SelectKeyword
            }
            case "sequence" {
                return SyntaxKind.SequenceKeyword
            }
            case "struct" {
                return SyntaxKind.StructKeyword
            }
            case "suspend" {
                return SyntaxKind.SuspendKeyword
            }
            case "switch" {
                return SyntaxKind.SwitchKeyword
            }
            case "throw" {
                return SyntaxKind.ThrowKeyword
            }
            case "true" {
                return SyntaxKind.TrueKeyword
            }
            case "try" {
                return SyntaxKind.TryKeyword
            }
            case "using" {
                return SyntaxKind.UsingKeyword
            }
            case "var" {
                return SyntaxKind.VarKeyword
            }
            case "while" {
                return SyntaxKind.WhileKeyword
            }
            case "lock" {
                return SyntaxKind.LockKeyword
            }
            default {
                return SyntaxKind.IdentifierToken
            }
        }
    }

    /// Determines whether a spelling is a hard G# keyword.
    /// @param text The identifier spelling to inspect.
    /// @returns `true` for hard keywords.
    func IsReservedIdentifier(text string) bool -> IsReservedIdentifier(text, IdentifierNameContext.General)

    /// Determines whether a spelling is consumed by the grammar in a specific
    /// identifier context.
    /// @param text The identifier spelling to inspect.
    /// @param context The emitted grammar contexts where the name is used.
    /// @returns `true` when the spelling must be changed.
    func IsReservedIdentifier(text string, context IdentifierNameContext) bool {
        if GetKeywordKind(text) != SyntaxKind.IdentifierToken {
            return true
        }
        if (context & IdentifierNameContext.Parameter) != 0 &&
            (text == "params" || text == "scoped" || text == "ref" || text == "out" || text == "in") {
            return true
        }
        if (context & IdentifierNameContext.Local) != 0 && (text == "scoped" || text == "ref") {
            return true
        }
        if (context & IdentifierNameContext.TypeParameter) != 0 && (text == "in" || text == "out") {
            return true
        }
        if (context & IdentifierNameContext.Invocation) != 0 &&
            (
            text == "typeof" ||
                text == "sizeof" ||
                text == "checked" ||
                text == "unchecked" ||
                text == "nameof" ||
                text == "init"
        ) {
            return true
        }
        if (context & IdentifierNameContext.Pattern) != 0 &&
            (text == "and" || text == "or" || text == "when" || text == "not") {
            return true
        }
        if (context & IdentifierNameContext.Index) != 0 && (text == "stackalloc" || text == "base") {
            return true
        }
        return (context & IdentifierNameContext.Type) != 0 &&
            (
            text == "event" ||
                text == "prop" ||
                text == "init" ||
                text == "convenience" ||
                text == "shared" ||
                text == "delegate" ||
                text == "unmanaged"
        )
    }

    /// Produces a grammar-safe emitted spelling while preserving every legal
    /// source name in the same scope.
    /// @param name The source identifier value.
    /// @param context The emitted grammar contexts where the name is used.
    /// @param scopeNames Source names occupying the same emitted scope.
    /// @returns The unchanged legal name, or a collision-free suffixed spelling.
    func GetEmittedIdentifier(
        name string,
        context IdentifierNameContext,
        scopeNames IEnumerable[string]? = nil
    ) string {
        if string.IsNullOrEmpty(name) || !IsReservedIdentifier(name, context) {
            return name
        }
        let occupied HashSet[string]? = if scopeNames == nil {
            default(HashSet[string]?)
        } else {
            HashSet[string](scopeNames, StringComparer.Ordinal)
        }
        var candidate = name + "_"
        while occupied?.Contains(candidate) == true {
            candidate += "_"
        }
        return candidate
    }

    /// Determines whether a spelling is the unsupported C# variadic modifier.
    /// @param text The token spelling to inspect.
    /// @returns `true` for `params`.
    func IsParamsKeyword(text string) bool -> text == "params"

    /// Provides a list o all supported unary operators.
    /// @returns An enumeration of sytax kinds that represent unary operators.
    func GetUnaryOperatorKinds() sequence[SyntaxKind] {
        let kinds = cast[[]SyntaxKind](Enum.GetValues(typeof(SyntaxKind)))
        for kind in kinds {
            if kind.GetUnaryOperatorPrecedence() > 0 {
                yield kind
            }
        }
    }

    /// Provides a list o all supported binary operators.
    /// @returns An enumeration of sytax kinds that represent binary operators.
    func GetBinaryOperatorKinds() sequence[SyntaxKind] {
        let kinds = cast[[]SyntaxKind](Enum.GetValues(typeof(SyntaxKind)))
        for kind in kinds {
            if kind.GetBinaryOperatorPrecedence() > 0 {
                yield kind
            }
        }
    }

    /// Given a syntax kind token, provides the associated text representation.
    /// @param kind The token syntax kind.
    /// @returns A string representing the token as defined by the language.
    func GetText(kind SyntaxKind) string? {
        switch kind {
            case SyntaxKind.PlusToken {
                return "+"
            }
            case SyntaxKind.PlusEqualsToken {
                return "+="
            }
            case SyntaxKind.PlusPlusToken {
                return "++"
            }
            case SyntaxKind.MinusToken {
                return "-"
            }
            case SyntaxKind.MinusEqualsToken {
                return "-="
            }
            case SyntaxKind.MinusMinusToken {
                return "--"
            }
            case SyntaxKind.StarToken {
                return "*"
            }
            case SyntaxKind.StarEqualsToken {
                return "*="
            }
            case SyntaxKind.SlashToken {
                return "/"
            }
            case SyntaxKind.SlashEqualsToken {
                return "/="
            }
            case SyntaxKind.PercentToken {
                return "%"
            }
            case SyntaxKind.PercentEqualsToken {
                return "%="
            }
            case SyntaxKind.OpenParenthesisToken {
                return "("
            }
            case SyntaxKind.CloseParenthesisToken {
                return ")"
            }
            case SyntaxKind.OpenSquareBracketToken {
                return "["
            }
            case SyntaxKind.CloseSquareBracketToken {
                return "]"
            }
            case SyntaxKind.OpenBraceToken {
                return "{"
            }
            case SyntaxKind.CloseBraceToken {
                return "}"
            }
            case SyntaxKind.ColonToken {
                return ":"
            }
            case SyntaxKind.ColonEqualsToken {
                return ":="
            }
            case SyntaxKind.SemicolonToken {
                return ";"
            }
            case SyntaxKind.CommaToken {
                return ","
            }
            case SyntaxKind.DotToken {
                return "."
            }
            case SyntaxKind.DotDotToken {
                return ".."
            }
            case SyntaxKind.EllipsisToken {
                return "..."
            }
            case SyntaxKind.HatToken {
                return "^"
            }
            case SyntaxKind.HatEqualsToken {
                return "^="
            }
            case SyntaxKind.TildeToken {
                return "~"
            }
            case SyntaxKind.AmpersandToken {
                return "&"
            }
            case SyntaxKind.AmpersandAmpersandToken {
                return "&&"
            }
            case SyntaxKind.AmpersandEqualsToken {
                return "&="
            }
            case SyntaxKind.AmpersandHatToken {
                return "&^"
            }
            case SyntaxKind.AmpersandHatEqualsToken {
                return "&^="
            }
            case SyntaxKind.PipeToken {
                return "|"
            }
            case SyntaxKind.PipeEqualsToken {
                return "|="
            }
            case SyntaxKind.PipePipeToken {
                return "||"
            }
            case SyntaxKind.EqualsToken {
                return "="
            }
            case SyntaxKind.EqualsEqualsToken {
                return "=="
            }
            case SyntaxKind.BangToken {
                return "!"
            }
            case SyntaxKind.BangEqualsToken {
                return "!="
            }
            case SyntaxKind.BangBangToken {
                return "!!"
            }
            case SyntaxKind.QuestionToken {
                return "?"
            }
            case SyntaxKind.QuestionDotToken {
                return "?."
            }
            case SyntaxKind.QuestionQuestionToken {
                return "??"
            }
            case SyntaxKind.QuestionQuestionEqualsToken {
                return "??="
            }
            case SyntaxKind.QuestionOpenBracketToken {
                return "?["
            }
            case SyntaxKind.LessToken {
                return "<"
            }
            case SyntaxKind.LessOrEqualsToken {
                return "<="
            }
            case SyntaxKind.LeftArrowToken {
                return "<-"
            }
            case SyntaxKind.RightArrowToken {
                return "->"
            }
            case SyntaxKind.ShiftLeftToken {
                return "<<"
            }
            case SyntaxKind.ShiftLeftEqualsToken {
                return "<<="
            }
            case SyntaxKind.GreaterToken {
                return ">"
            }
            case SyntaxKind.GreaterOrEqualsToken {
                return ">="
            }
            case SyntaxKind.ShiftRightToken {
                return ">>"
            }
            case SyntaxKind.ShiftRightEqualsToken {
                return ">>="
            }
            case SyntaxKind.UnsignedShiftRightToken {
                return ">>>"
            }
            case SyntaxKind.UnsignedShiftRightEqualsToken {
                return ">>>="
            }
            case SyntaxKind.AtToken {
                return "@"
            }
            case SyntaxKind.AsKeyword {
                return "as"
            }
            case SyntaxKind.AsyncKeyword {
                return "async"
            }
            case SyntaxKind.AwaitKeyword {
                return "await"
            }
            case SyntaxKind.BreakKeyword {
                return "break"
            }
            case SyntaxKind.CaseKeyword {
                return "case"
            }
            case SyntaxKind.CatchKeyword {
                return "catch"
            }
            case SyntaxKind.ChanKeyword {
                return "chan"
            }
            case SyntaxKind.ClassKeyword {
                return "class"
            }
            case SyntaxKind.ConstKeyword {
                return "const"
            }
            case SyntaxKind.ContinueKeyword {
                return "continue"
            }
            case SyntaxKind.DefaultKeyword {
                return "default"
            }
            case SyntaxKind.DeferKeyword {
                return "defer"
            }
            case SyntaxKind.DoKeyword {
                return "do"
            }
            case SyntaxKind.ElseKeyword {
                return "else"
            }
            case SyntaxKind.EnumKeyword {
                return "enum"
            }
            case SyntaxKind.FalseKeyword {
                return "false"
            }
            case SyntaxKind.FallthroughKeyword {
                return "fallthrough"
            }
            case SyntaxKind.FinallyKeyword {
                return "finally"
            }
            case SyntaxKind.ForKeyword {
                return "for"
            }
            case SyntaxKind.FuncKeyword {
                return "func"
            }
            case SyntaxKind.GoKeyword {
                return "go"
            }
            case SyntaxKind.GotoKeyword {
                return "goto"
            }
            case SyntaxKind.GuardKeyword {
                return "guard"
            }
            case SyntaxKind.IfKeyword {
                return "if"
            }
            case SyntaxKind.ImportKeyword {
                return "import"
            }
            case SyntaxKind.InterfaceKeyword {
                return "interface"
            }
            case SyntaxKind.InternalKeyword {
                return "internal"
            }
            case SyntaxKind.IsKeyword {
                return "is"
            }
            case SyntaxKind.LetKeyword {
                return "let"
            }
            case SyntaxKind.MapKeyword {
                return "map"
            }
            case SyntaxKind.OpenKeyword {
                return "open"
            }
            case SyntaxKind.NilKeyword {
                return "nil"
            }
            case SyntaxKind.OverrideKeyword {
                return "override"
            }
            case SyntaxKind.OperatorKeyword {
                return "operator"
            }
            case SyntaxKind.PackageKeyword {
                return "package"
            }
            case SyntaxKind.PrivateKeyword {
                return "private"
            }
            case SyntaxKind.ProtectedKeyword {
                return "protected"
            }
            case SyntaxKind.PublicKeyword {
                return "public"
            }
            case SyntaxKind.RangeKeyword {
                return "range"
            }
            case SyntaxKind.ReturnKeyword {
                return "return"
            }
            case SyntaxKind.SealedKeyword {
                return "sealed"
            }
            case SyntaxKind.ScopeKeyword {
                return "scope"
            }
            case SyntaxKind.SelectKeyword {
                return "select"
            }
            case SyntaxKind.SequenceKeyword {
                return "sequence"
            }
            case SyntaxKind.StructKeyword {
                return "struct"
            }
            case SyntaxKind.SuspendKeyword {
                return "suspend"
            }
            case SyntaxKind.SwitchKeyword {
                return "switch"
            }
            case SyntaxKind.RethrowKeyword {
                return "rethrow"
            }
            case SyntaxKind.ThrowKeyword {
                return "throw"
            }
            case SyntaxKind.TrueKeyword {
                return "true"
            }
            case SyntaxKind.TryKeyword {
                return "try"
            }
            case SyntaxKind.TypeKeyword {
                return "type"
            }
            case SyntaxKind.UsingKeyword {
                return "using"
            }
            case SyntaxKind.VarKeyword {
                return "var"
            }
            case SyntaxKind.WhileKeyword {
                return "while"
            }
            case SyntaxKind.LockKeyword {
                return "lock"
            }
            default {
                return nil
            }
        }
    }

    /// Gets the fixed source text for [`kind`](paramref), or
    /// (cref:string.Empty) when the kind has none.
    /// @remarks For callers that pass a fixed operator or keyword kind, where
    /// (cref:GetText) cannot return `null`. Keeps the
    /// null-returning overload honest without scattering `!` across the
    /// parser's synthetic-token construction.
    /// @param kind The kind of syntax.
    /// @returns The text, or an empty string.
    func GetTextOrEmpty(kind SyntaxKind) string -> GetText(kind) ?? string.Empty
}

/// Gets the presendence for unary operators. A higher number indicates higher presendence.
/// @returns A number indicating the presendence.
@ExtensionOwner(typeof(SyntaxFacts))
func (kind SyntaxKind) GetUnaryOperatorPrecedence() int32 {
    switch kind {
        case SyntaxKind.PlusToken,
        SyntaxKind.MinusToken,
        SyntaxKind.BangToken,
        SyntaxKind.TildeToken,
        SyntaxKind.StarToken,
        SyntaxKind.AmpersandToken,
        SyntaxKind.LeftArrowToken {
            return 6
        }
        default {
            return 0
        }
    }
}

/// Gets the presendence for binary operators. A higher number indicates higher presendence.
/// @returns A number indicating the presendence.
@ExtensionOwner(typeof(SyntaxFacts))
func (kind SyntaxKind) GetBinaryOperatorPrecedence() int32 {
    switch kind {
        case SyntaxKind.StarToken,
        SyntaxKind.SlashToken,
        SyntaxKind.PercentToken,
        SyntaxKind.ShiftLeftToken,
        SyntaxKind.ShiftRightToken,
        SyntaxKind.UnsignedShiftRightToken,
        SyntaxKind.AmpersandToken,
        SyntaxKind.AmpersandHatToken {
            return 5
        }
        case SyntaxKind.PlusToken, SyntaxKind.MinusToken, SyntaxKind.PipeToken, SyntaxKind.HatToken {
            return 4
        }
        case SyntaxKind.EqualsEqualsToken,
        SyntaxKind.BangEqualsToken,
        SyntaxKind.LessToken,
        SyntaxKind.LessOrEqualsToken,
        SyntaxKind.GreaterToken,
        SyntaxKind.GreaterOrEqualsToken {
            return 3
        }
        case SyntaxKind.AmpersandAmpersandToken {
            return 2
        }
        case SyntaxKind.PipePipeToken {
            return 1
        }
        default {
            // Issue #941: `??` null-coalescing is NOT handled by the
            // left-associative binary loop. It is parsed separately by
            // Parser.ParseNullCoalescingExpression so it can be
            // right-associative and sit at a precedence strictly below `||`.
            // Returning 0 here keeps the binary loop from consuming it.
            return 0
        }
    }
}
