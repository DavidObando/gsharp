// <copyright file="GSharpFormatter.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Globalization
import System.Text

/// Produces the single canonical G# source form defined by ADR-0179.
shared class GSharpFormatter {
    private enum DiffKind {
        Equal,
        Delete,
        Insert
    }

    private data struct DiffOperation(Kind DiffKind, Text string) : IEquatable[DiffOperation] { }

    private class LayoutBuilder {
        private let tree SyntaxTree
        private let tokens List[LayoutToken]
        private let matchingDelimiters Dictionary[int32, int32] = Dictionary[int32, int32]()
        private let breaksBefore Dictionary[int32, int32] = Dictionary[int32, int32]()
        private let fusionCache Dictionary[string, bool] = Dictionary[string, bool](StringComparer.Ordinal)
        private let memberChains Dictionary[int32, MemberChainInfo] = Dictionary[int32, MemberChainInfo]()

        init(tree SyntaxTree) {
            this.tree = tree
            tokens = BindTrivia(tree)
            BuildDelimiterMap()
            BuildMemberChains()
            BuildLineBoundaries()
        }

        func Build() Doc -> if tokens.Count == 0 {
            Doc.HardLine
        } else {
            BuildRange(0, tokens.Count, suppressLeadingBreak: true, groupSegments: true)
        }

        private func BuildDelimiterMap() {
            let stack = Stack[int32]()
            for var i = 0; i < tokens.Count; i++ {
                let kind = tokens[i].Token.Kind
                if kind == SyntaxKind.OpenParenthesisToken ||
                    kind == SyntaxKind.OpenSquareBracketToken ||
                    kind == SyntaxKind.QuestionOpenBracketToken ||
                    kind == SyntaxKind.OpenBraceToken {
                    stack.Push(i)
                    continue
                }
                if !(
                    (
                        kind == SyntaxKind.CloseParenthesisToken ||
                            kind == SyntaxKind.CloseSquareBracketToken ||
                            kind == SyntaxKind.CloseBraceToken
                    )
                ) {
                    continue
                }
                if stack.Count == 0 {
                    continue
                }
                let open_ = stack.Pop()
                if IsMatching(tokens[open_].Token.Kind, kind) {
                    matchingDelimiters[open_] = i
                }
            }
        }

        private func BuildLineBoundaries() {
            for parent in tree.Root.DescendantNodesAndSelf() {
                if !IsLineContainer(parent) {
                    continue
                }
                let children = parent
                    .GetChildren()
                    .Where(IsLineItem)
                    .OrderBy((child SyntaxNode) -> child.Span.Start)
                    .ToArray()
                for var i = 1; i < children.Length; i++ {
                    if children[i - 1].Span.End > children[i].Span.Start {
                        continue
                    }
                    let breakCount = if IsMemberBlankLine(children[i - 1], children[i]) {
                        2
                    } else {
                        1
                    }
                    breaksBefore[LeadingTriviaPosition(children[i].Span.Start)] = breakCount
                }
            }
        }

        private func LeadingTriviaPosition(position int32) int32 {
            var index = tokens.FindIndex((token LayoutToken) -> token.Token.Position == position)
            if index < 0 {
                return position
            }
            while index > 0 &&
                (tokens[index - 1].Token.Kind is SyntaxKind.CommentToken or SyntaxKind.DocumentationCommentToken) &&
                IsStandaloneComment(tokens[index - 1]) {
                index--
            }
            return tokens[index].Token.Position
        }

        private func IsStandaloneComment(token LayoutToken) bool {
            if token.Token.Kind == SyntaxKind.DocumentationCommentToken || token.NewlinesBefore > 0 {
                return true
            }
            let line = tree.Text.GetLineIndex(token.Token.Position)
            let lineStart = tree.Text.Lines[line].Start
            let prefix = tree.Text.ToString(lineStart, token.Token.Position - lineStart)
            return prefix.All(char.IsWhiteSpace)
        }

        private func BuildRange(
            start int32,
            end int32,
            suppressLeadingBreak bool,
            groupSegments bool,
            groupElements bool = false
        ) Doc {
            let completed = List[Doc]()
            let segment = List[Doc]()
            var previous LayoutToken? = nil
            var separatorAlreadyEmitted = false
            var index = start
            while index < end {
                let current = tokens[index]
                let breakCount = if separatorAlreadyEmitted {
                    0
                } else {
                    GetBreakCount(previous, current, suppressLeadingBreak && index == start)
                }
                if breakCount > 0 {
                    FlushSegment(completed, segment, groupSegments)
                    AddHardLines(completed, breakCount)
                    previous = nil
                } else if previous != nil && !separatorAlreadyEmitted {
                    segment.Add(Separator(previous, current))
                }
                separatorAlreadyEmitted = false
                // One group per list element, with the comma's own break OUTSIDE
                // it. Wadler's rule is that a group breaks its own lines, not its
                // children's, so without this every `.`-chain and `+`-chain inside
                // every argument broke the moment the argument list did — the
                // receiver-per-line shape the migrated tree was full of. Splitting
                // here re-asks "does THIS element fit?" per element, which is the
                // entire reason to have the algebra rather than hand-written
                // break rules.
                //
                // A trailing comma (`{a, b, }`) is not an element boundary: what
                // follows it is the closing delimiter, and a break there leaves a
                // stray space or a blank line in front of the brace.
                if groupElements &&
                    current
                    .Token
                    .Kind == SyntaxKind.CommaToken &&
                    index +
                    1 < end &&
                    !matchingDelimiters
                    .ContainsKey(index) {
                    segment.Add(Doc.Text(current.Text))
                    FlushSegment(completed, segment, group: true)
                    completed.Add(Doc.Line)
                    previous = current
                    separatorAlreadyEmitted = true
                    index++
                    continue
                }
                if matchingDelimiters.TryGetValue(index, out var close) && close < end {
                    if current.Token.Kind == SyntaxKind.OpenBraceToken && IsStructuralBrace(current.Parent) {
                        segment.Add(Doc.Text(current.Text))
                        if close == index + 1 {
                            segment.Add(Doc.Text(" "))
                            segment.Add(Doc.Text(tokens[close].Text))
                        } else {
                            FlushSegment(completed, segment, groupSegments)
                            let inner = BuildRange(index + 1, close, suppressLeadingBreak: true, groupSegments: true)
                            completed.Add(Doc.Nest(4, Doc.Concat(Doc.HardLine, inner)))
                            completed.Add(Doc.HardLine)
                            segment.Add(Doc.Text(tokens[close].Text))
                        }
                    } else {
                        let inner = BuildRange(
                            index + 1,
                            close,
                            suppressLeadingBreak: true,
                            groupSegments: true,
                            groupElements: true
                        )
                        let afterOpen = if MustKeepFirstCollectionElementOnBraceLine(current) {
                            Doc.Empty
                        } else {
                            Doc.SoftLine
                        }
                        let delimited = if close == index + 1 {
                            Doc.Concat(Doc.Text(current.Text), Doc.Text(tokens[close].Text))
                        } else {
                            Doc.Group(
                                Doc.Concat(
                                    Doc.Text(current.Text),
                                    Doc.Nest(4, Doc.Concat(afterOpen, inner)),
                                    Doc.SoftLine,
                                    Doc.Text(tokens[close].Text)
                                )
                            )
                        }
                        // Keep the member-call prefix in its own group. A block
                        // argument can then break the argument list without also
                        // forcing a short `Console.WriteLine` prefix to break,
                        // while an over-wide short chain can still break at `.`.
                        if ShouldGroupMemberCallPrefix(current) {
                            FlushSegment(completed, segment, group: true)
                        }
                        segment.Add(delimited)
                    }
                    previous = tokens[close]
                    index = close + 1
                    continue
                }
                segment.Add(Doc.Text(current.Text))
                if current.IsLineComment {
                    FlushSegment(completed, segment, groupSegments)
                    completed.Add(Doc.HardLine)
                    previous = nil
                } else {
                    previous = current
                }
                index++
            }
            FlushSegment(completed, segment, groupSegments || groupElements)
            return Doc.Concat(completed)
        }

        private func GetBreakCount(previous LayoutToken?, current LayoutToken, suppressLeadingBreak bool) int32 {
            if suppressLeadingBreak {
                return 0
            }
            if previous == nil {
                return current.NewlinesBefore
            }
            if breaksBefore.TryGetValue(current.Token.Position, out var required) {
                return Math.Max(required, current.NewlinesBefore)
            }
            // `;` is a statement terminator everywhere EXCEPT the two clause
            // separators of a C-style `for init; cond; post { … }` header,
            // where it is a list separator like `,` (ForClauseStatementSyntax
            // is the only node that owns a `;` as a direct child rather than
            // as the close of a StatementSyntax). SyntaxFacts.IsBreakRequiredBetween
            // is a two-token predicate and cannot see that distinction — only
            // the owning node can — so it is guarded here rather than fixed
            // there, matching how IsCallNullableMarker/IsNullableMarker below
            // already disambiguate a bare token kind by its parent.
            if SyntaxFacts.IsBreakRequiredBetween(previous.Token, current.Token) && !IsForClauseSeparator(previous) {
                return 1
            }
            if current.NewlinesBefore == 0 {
                return 0
            }
            if current.Token.Kind == SyntaxKind.OpenBraceToken && IsStructuralBrace(current.Parent) {
                return 0
            }
            // At a continuation boundary the LAYOUT owns the break, so the
            // author's newline is dropped and the enclosing group re-derives it.
            // Keeping it emits a hard break at the enclosing indent instead,
            // losing the +4 the group would have used — and that is what made
            // gsfmt non-idempotent on its OWN output: a line it had wrapped with
            // a continuation indent came back without one on the next pass, on
            // 111 of the 3,873 migrated files.
            //
            // `SyntaxFacts.IsBreakLegalBetween` is deliberately not consulted
            // here. It refuses a break before `(`, `{` and `*` because after an
            // EXPRESSION those spell a call, an object initializer and a
            // dereference statement; a two-token predicate cannot see that the
            // token on the left is a comma or a binary operator, which no
            // expression can end with. Joining across a continuation boundary is
            // unconditionally safe, and D4's round-trip check is the backstop.
            if IsContinuationBoundary(previous, current) {
                return 0
            }
            if previous
                .Token
                .Kind == SyntaxKind.CloseBraceToken &&
                (
                current
                    .Token
                    .Kind is SyntaxKind.ElseKeyword or
                    SyntaxKind.CatchKeyword or
                    SyntaxKind.FinallyKeyword or
                    SyntaxKind.WhileKeyword
            ) {
                return 0
            }
            return current.NewlinesBefore
        }

        /// Applies the spacing rule for a token boundary, then re-checks that
        /// the result cannot be re-lexed into a different token stream.
        private func Separator(previous LayoutToken, current LayoutToken) Doc {
            let separator = InlineSeparator(previous, current)
            return if object.ReferenceEquals(separator, Doc.Empty) && WouldFuse(previous.Text, current.Text) {
                Doc.Text(" ")
            } else {
                separator
            }
        }

        // Two tokens the spacing rules want flush against each other must still
        // lex back as those two tokens. `! !on` — a double logical negation the
        // C# corpus produces — collapsed to `!!on`, which is the null-assertion
        // operator: a different program, and a violation of the token-stream
        // invariant that ADR-0179 D4 makes the whole design rest on.
        //
        // Rather than enumerate the lexer's multi-character operators here and
        // go stale the next time one is added, ask the lexer. The pairs that
        // reach this check are few and highly repetitive within one document,
        // so the answers are memoised per format call.
        private func WouldFuse(left string, right string) bool {
            if left.Length == 0 || right.Length == 0 {
                return false
            }
            let key = left + "\u0000" + right
            if fusionCache.TryGetValue(key, out var cached) {
                return cached
            }
            let relexed = SyntaxTree.ParseTokens(left + right)
            let fuses = relexed.Length < 2 || !string.Equals(relexed[0].Text, left, StringComparison.Ordinal) ||
                !string.Equals(relexed[1].Text, right, StringComparison.Ordinal)
            fusionCache[key] = fuses
            return fuses
        }

        // Short chains normally stay flat, but still need a break opportunity
        // when their own tokens exceed the line budget.
        private func BuildMemberChains() {
            for var i = 0; i < tokens.Count; i++ {
                if tokens[i]
                    .Token
                    .Kind is not(SyntaxKind.DotToken or SyntaxKind.QuestionDotToken) ||
                    memberChains.ContainsKey(tokens[i].Token.Position) {
                    continue
                }
                let chain = List[int32]()
                let start = Math.Max(0, i - 1)
                var index = i
                while index < tokens.Count &&
                    (tokens[index].Token.Kind is SyntaxKind.DotToken or SyntaxKind.QuestionDotToken) {
                    chain.Add(index)
                    index++
                    if index < tokens.Count && !IsDelimiterOpen(tokens[index].Token.Kind) {
                        index++
                    }
                    if index < tokens.Count && IsCallNullableMarker(tokens[index]) {
                        index++
                    }
                    while index < tokens.Count && matchingDelimiters.TryGetValue(index, out var close) {
                        index = close + 1
                    }
                }
                var flatWidth = 0
                for var tokenIndex = start; tokenIndex < index; tokenIndex++ {
                    flatWidth += tokens[tokenIndex].Text.Length
                }
                let info = MemberChainInfo(chain.Count, flatWidth > GSharpFormatter.MaxLineWidth)
                for dot in chain {
                    memberChains[tokens[dot].Token.Position] = info
                }
            }
        }

        private func ShouldGroupMemberCallPrefix(token LayoutToken) bool {
            if token
                .Token
                .Kind != SyntaxKind.OpenParenthesisToken ||
                !(token.Parent is CallExpressionSyntax{Parent: AccessorExpressionSyntax accessor}) {
                return false
            }
            return memberChains.TryGetValue(accessor.DotToken.Position, out var chain) &&
                chain.Links <= MemberChainBreakThreshold
        }

        private func InlineSeparator(previous LayoutToken, current LayoutToken) Doc {
            let left = previous.Token.Kind
            let right = current.Token.Kind
            if left == SyntaxKind.CommaToken {
                return Doc.Line
            }
            if left == SyntaxKind.PlusToken ||
                left == SyntaxKind.AmpersandAmpersandToken ||
                left == SyntaxKind.PipePipeToken ||
                left == SyntaxKind.QuestionQuestionToken ||
                IsPatternCombinator(previous) {
                return Doc.Nest(4, Doc.Line)
            }
            // A for-clause separator `;` behaves like `,`: a wrap point that
            // flattens to a single space, not a hard terminator. This must be
            // checked before the "no space before `;`" rule below, or the
            // all-empty form (`for ; ; {`, both clauses empty) would have its
            // `right is SemicolonToken` case swallow it.
            if IsForClauseSeparator(previous) {
                return Doc.Nest(4, Doc.Line)
            }
            // An empty initializer clause (`for ; cond; post {`) leaves the
            // for-clause separator directly after the `for` keyword, with no
            // clause token to its left to hug. The "no space before `;`" rule
            // below assumes `;` always closes a preceding expression/clause
            // and would otherwise glue it to the keyword as `for;`.
            if left == SyntaxKind.ForKeyword && IsForClauseSeparator(current) {
                return Doc.Text(" ")
            }
            if right == SyntaxKind.DotToken || right == SyntaxKind.QuestionDotToken {
                return if memberChains.TryGetValue(current.Token.Position, out var chain) &&
                    (chain.Links >= MemberChainBreakThreshold || chain.ExceedsLineWidth) {
                    Doc.Nest(4, Doc.SoftLine)
                } else {
                    Doc.Empty
                }
            }
            if left == SyntaxKind.DotToken ||
                left == SyntaxKind.QuestionDotToken ||
                left == SyntaxKind.AtToken ||
                left == SyntaxKind.OpenParenthesisToken ||
                left == SyntaxKind.OpenSquareBracketToken ||
                left == SyntaxKind.QuestionOpenBracketToken ||
                right == SyntaxKind.CloseParenthesisToken ||
                right == SyntaxKind.CloseSquareBracketToken ||
                right == SyntaxKind.CommaToken ||
                right == SyntaxKind.SemicolonToken ||
                right == SyntaxKind.DotToken ||
                right == SyntaxKind.QuestionDotToken {
                return Doc.Empty
            }
            // `default(T)` is one operator with a parenthesised operand, not a
            // keyword followed by a parenthesised expression, and that is how it
            // is spelled everywhere else in the repo.
            if right == SyntaxKind.OpenParenthesisToken &&
                (
                left == SyntaxKind.IdentifierToken ||
                    left == SyntaxKind.DefaultKeyword ||
                    left == SyntaxKind.CloseParenthesisToken ||
                    left == SyntaxKind.CloseSquareBracketToken
            ) {
                return Doc.Empty
            }
            // `callee?(args)` (null-conditional invocation) and `int32?(n)`
            // (nullable conversion call) both hang a `?` off the argument list,
            // and the token alone cannot tell them from the `?:` conditional
            // operator — `CallExpressionSyntax.NullableQuestionToken` can. A
            // space here turns `x?(y)` into `x ? (y)` and the parser then looks
            // for the `:` that never comes, which is precisely how the formatter
            // was rejecting its own output on 28 migrated files.
            if right == SyntaxKind.OpenParenthesisToken && IsCallNullableMarker(previous) {
                return Doc.Empty
            }
            if right == SyntaxKind.OpenSquareBracketToken &&
                (
                left == SyntaxKind.IdentifierToken ||
                    left == SyntaxKind.ChanKeyword ||
                    left == SyntaxKind.MapKeyword ||
                    left == SyntaxKind.SequenceKeyword ||
                    left == SyntaxKind.CloseParenthesisToken ||
                    left == SyntaxKind.CloseSquareBracketToken
            ) {
                return Doc.Empty
            }
            if right == SyntaxKind.QuestionOpenBracketToken {
                return Doc.Empty
            }
            if left == SyntaxKind.CloseSquareBracketToken &&
                (right == SyntaxKind.IdentifierToken || right == SyntaxKind.QuestionToken) {
                return Doc.Empty
            }
            if right == SyntaxKind.OpenBraceToken && !IsStructuralBrace(current.Parent) {
                return if left == SyntaxKind.IdentifierToken ||
                    left == SyntaxKind.CloseParenthesisToken ||
                    left == SyntaxKind.CloseSquareBracketToken {
                    Doc.Empty
                } else {
                    Doc.Text(" ")
                }
            }
            if right == SyntaxKind.OpenBraceToken {
                return Doc.Text(" ")
            }
            if right == SyntaxKind.ColonToken {
                return if NeedsSpaceBeforeColon(current.Parent) {
                    Doc.Text(" ")
                } else {
                    Doc.Empty
                }
            }
            if left == SyntaxKind.ColonToken {
                return Doc.Text(" ")
            }
            if IsPostfix(current) {
                return Doc.Empty
            }
            if IsPrefix(previous) {
                return Doc.Empty
            }
            // A nullable `?` never takes a space before it, and takes one after
            // it only at the END of the type clause it belongs to. The marker is
            // a suffix in `string?` but an infix in `[]?int32`, so "no space on
            // either side" and "no space before, always one after" are both
            // wrong; what actually holds is that no space appears INSIDE a type
            // clause. Suppressing the space unconditionally produced
            // `let root XElement?= XDocument.Parse(…)` — `?=` re-lexes as one
            // token, the file stopped parsing, and D4's round-trip check then
            // discarded the whole file's layout, which is how 15 migrated files
            // silently kept the printer's wrapping.
            if IsNullableMarker(current) || (IsNullableMarker(previous) && current.Parent is TypeClauseSyntax) {
                return Doc.Empty
            }
            return Doc.Text(" ")
        }

        private data struct MemberChainInfo(Links int32, ExceedsLineWidth bool) : IEquatable[MemberChainInfo] { }

        private class LayoutToken {
            init(token SyntaxToken, parent SyntaxNode?, newlinesBefore int32, isLineComment bool, text string) {
                Token = token
                Parent = parent
                NewlinesBefore = newlinesBefore
                IsLineComment = isLineComment
                Text = text
            }

            prop Token SyntaxToken {
                get;
            }

            prop Parent SyntaxNode? {
                get;
            }

            prop NewlinesBefore int32 {
                get;
            }

            prop IsLineComment bool {
                get;
            }

            prop Text string {
                get;
            }
        }

        shared {
            private const MemberChainBreakThreshold int32 = 2

            private func BindTrivia(tree SyntaxTree) List[LayoutToken] {
                let parsedTokens = EnumerateTokens(tree.Root)
                    .Where((token SyntaxToken) -> !token.IsMissing)
                    .GroupBy((token SyntaxToken) -> (token.Position, token.Kind, token.Text))
                    .ToDictionary(
                    (group IGrouping[(Position int32, Kind SyntaxKind, Text string), SyntaxToken]) -> group.Key,
                    (group IGrouping[(Position int32, Kind SyntaxKind, Text string), SyntaxToken]) -> group.First()
                        .Parent
                )
                let result = List[LayoutToken]()
                var pendingNewlines = 0
                for token in SyntaxTree.ParseTokens(tree.Text) {
                    if token.Kind == SyntaxKind.WhitespaceToken {
                        pendingNewlines += CountNewlines(token.Text)
                        continue
                    }
                    parsedTokens.TryGetValue((token.Position, token.Kind, token.Text), out var parent)
                    result.Add(
                        LayoutToken(
                            token,
                            parent,
                            Math.Min(2, pendingNewlines),
                            IsLineComment(token),
                            NormalizeTokenText(token)
                        )
                    )
                    pendingNewlines = 0
                }
                return result
            }

            private func EnumerateTokens(node SyntaxNode) ImmutableArray[SyntaxToken] {
                let result = ImmutableArray.CreateBuilder[SyntaxToken]()
                AddTokens(node, result)
                return result.ToImmutable()
            }

            private func AddTokens(node SyntaxNode, result ImmutableArray[SyntaxToken].Builder) {
                if node is SyntaxToken token {
                    result.Add(token)
                    return
                }
                for child in node.GetChildren() {
                    AddTokens(child, result)
                }
            }

            private func CountNewlines(text string) int32 {
                var count = 0
                for var i = 0; i < text.Length; i++ {
                    if text[i] == '\n' || (text[i] == '\r' && (i + 1 >= text.Length || text[i + 1] != '\n')) {
                        count++
                    }
                }
                return count
            }

            private func IsLineComment(token SyntaxToken) bool -> token.Kind == SyntaxKind.DocumentationCommentToken ||
                (token.Kind == SyntaxKind.CommentToken && token.Text.StartsWith("//", StringComparison.Ordinal))

            private func NormalizeTokenText(token SyntaxToken) string -> if IsLineComment(token) {
                token.Text.TrimEnd('\r', '\n')
            } else {
                token.Text
            }

            private func IsMatching($open SyntaxKind, close SyntaxKind) bool -> (
                $open == SyntaxKind.OpenParenthesisToken && close == SyntaxKind.CloseParenthesisToken
            ) ||
                (
                ($open == SyntaxKind.OpenSquareBracketToken || $open == SyntaxKind.QuestionOpenBracketToken) &&
                    close == SyntaxKind.CloseSquareBracketToken
            ) ||
                ($open == SyntaxKind.OpenBraceToken && close == SyntaxKind.CloseBraceToken)

            private func IsLineContainer(node SyntaxNode) bool -> node is CompilationUnitSyntax ||
                node is BlockStatementSyntax ||
                node is StructDeclarationSyntax ||
                node is InterfaceDeclarationSyntax ||
                node is EnumDeclarationSyntax ||
                node is SharedBlockSyntax ||
                node is SwitchStatementSyntax ||
                node is SwitchExpressionSyntax ||
                node is SelectStatementSyntax ||
                node is PropertyDeclarationSyntax ||
                node is EventDeclarationSyntax ||
                node is AnonymousClassExpressionSyntax

            private func IsLineItem(node SyntaxNode) bool -> node is MemberSyntax ||
                node is StatementSyntax ||
                node is SwitchCaseSyntax ||
                node is SwitchExpressionArmSyntax ||
                node is SelectCaseSyntax ||
                node is EnumMemberSyntax ||
                node is PropertyAccessorSyntax ||
                node is EventAccessorSyntax ||
                node is AnonymousClassMemberInitializerSyntax

            private func IsMemberBlankLine(previous SyntaxNode, current SyntaxNode) bool {
                if previous is ImportSyntax && current is ImportSyntax {
                    return false
                }
                if previous is PackageSyntax || previous is ImportSyntax || current is ImportSyntax {
                    return true
                }
                return IsDeclarationMember(previous) && IsDeclarationMember(current)
            }

            private func IsDeclarationMember(node SyntaxNode) bool -> node is MemberSyntax &&
                !(node is GlobalStatementSyntax) &&
                !(node is PackageSyntax) &&
                !(node is ImportSyntax)

            private func IsContinuationBoundary(left LayoutToken, right LayoutToken) bool -> IsPatternCombinator(
                left
            ) ||
                IsForClauseSeparator(left) ||
                IsContinuationBoundary(left.Token.Kind, right.Token.Kind)

            // The `;` separating a for-clause header's init/condition/post, as
            // opposed to a statement-terminating `;` (whose parent is the
            // statement it ends, never ForClauseStatementSyntax directly).
            private func IsForClauseSeparator(token LayoutToken) bool -> token
                .Token
                .Kind == SyntaxKind.SemicolonToken &&
                token.Parent is ForClauseStatementSyntax

            // `case A or B or C:` — G# spells pattern disjunction and conjunction as
            // the contextual identifiers `or` and `and` rather than as operator
            // tokens, so the layout cannot recognise them by `SyntaxKind` the way it
            // recognises `&&` and `||`. `BinaryPatternSyntax` is the node that owns
            // the combinator, and the long `SyntaxKind.X or SyntaxKind.Y or …` arms
            // the translated parser is full of are the last construct in the phase-6
            // inventory with no break point at all.
            private func IsPatternCombinator(token LayoutToken) bool -> token
                .Token
                .Kind == SyntaxKind.IdentifierToken &&
                token.Parent is BinaryPatternSyntax &&
                (
                string.Equals(token.Token.Text, "or", StringComparison.Ordinal) || string.Equals(
                    token.Token.Text,
                    "and",
                    StringComparison.Ordinal
                )
            )

            private func IsContinuationBoundary(
                previous SyntaxKind,
                current SyntaxKind
            ) bool -> previous == SyntaxKind.OpenParenthesisToken ||
                previous == SyntaxKind.OpenSquareBracketToken ||
                previous == SyntaxKind.QuestionOpenBracketToken ||
                previous == SyntaxKind.CommaToken ||
                previous == SyntaxKind.PlusToken ||
                previous == SyntaxKind.AmpersandAmpersandToken ||
                previous == SyntaxKind.PipePipeToken ||
                previous == SyntaxKind.QuestionQuestionToken ||
                current == SyntaxKind.CloseParenthesisToken ||
                current == SyntaxKind.CloseSquareBracketToken ||
                current == SyntaxKind.DotToken ||
                current == SyntaxKind.QuestionDotToken

            private func IsDelimiterOpen(kind SyntaxKind) bool -> kind == SyntaxKind.OpenParenthesisToken ||
                kind == SyntaxKind.OpenSquareBracketToken ||
                kind == SyntaxKind.QuestionOpenBracketToken ||
                kind == SyntaxKind.OpenBraceToken

            private func IsStructuralBrace(parent SyntaxNode?) bool -> (
                parent is BlockStatementSyntax or
                    StructDeclarationSyntax or
                    InterfaceDeclarationSyntax or
                    EnumDeclarationSyntax or
                    SharedBlockSyntax or
                    SwitchStatementSyntax or
                    SwitchExpressionSyntax or
                    SelectStatementSyntax or
                    PropertyDeclarationSyntax or
                    EventDeclarationSyntax or
                    BlockExpressionSyntax
            )

            // A single nonliteral element after an explicit constructor call is
            // newline-sensitive in LooksLikeCollectionInitializerBrace. Every
            // other collection shape may use the normal delimiter break.
            private func MustKeepFirstCollectionElementOnBraceLine(token LayoutToken) bool {
                if token
                    .Token
                    .Kind != SyntaxKind.OpenBraceToken ||
                    token.Parent is not CollectionInitializerExpressionSyntax initializer ||
                    initializer.Target is not CallExpressionSyntax call ||
                    call
                    .OpenParenthesisToken
                    .Position == call
                    .CloseParenthesisToken
                    .Position ||
                    initializer
                    .Elements
                    .Count != 1 {
                    return false
                }
                return (
                    initializer.Elements[0] is ExpressionCollectionElementSyntax and
                        {Expression: not LiteralExpressionSyntax}
                )
            }

            private func NeedsSpaceBeforeColon(parent SyntaxNode?) bool -> (
                parent is StructDeclarationSyntax or InterfaceDeclarationSyntax or ConstructorDeclarationSyntax
            )

            private func IsPostfix(token LayoutToken) bool -> (
                token.Token.Kind is SyntaxKind.BangBangToken or SyntaxKind.PlusPlusToken or SyntaxKind.MinusMinusToken
            ) ||
                (
                token.Token.Kind == SyntaxKind.QuestionToken && (IsNullableMarker(token) || IsCallNullableMarker(token))
            )

            private func IsPrefix(token LayoutToken) bool {
                if (
                    token.Parent is UnaryExpressionSyntax or
                        FromEndIndexExpressionSyntax or
                        SpreadElementExpressionSyntax
                ) {
                    return true
                }
                return (token.Token.Kind is SyntaxKind.BangToken or SyntaxKind.AtToken) ||
                    (
                    (
                        token
                            .Token
                            .Kind is SyntaxKind.StarToken or
                            SyntaxKind.AmpersandToken or
                            SyntaxKind.EllipsisToken
                    ) &&
                        (token.Parent is TypeClauseSyntax or ParameterSyntax)
                )
            }

            private func IsNullableMarker(token LayoutToken) bool -> token
                .Token
                .Kind == SyntaxKind.QuestionToken &&
                token.Parent is TypeClauseSyntax

            // The `?` of `callee?(args)` (null-conditional invocation) and of
            // `int32?(n)` (nullable conversion call). Token kind alone cannot
            // separate these from the `?:` conditional operator — only the owning
            // node can, and `CallExpressionSyntax.NullableQuestionToken` is the
            // node that owns them. Both sides of this `?` must stay tight: `x ?(y)`
            // and `x? (y)` each re-parse as a conditional expression whose `:` is
            // missing, which is how gsfmt was rejecting its own output on 28 files
            // of the migrated tree and silently keeping the printer's layout.
            private func IsCallNullableMarker(token LayoutToken) bool -> token
                .Token
                .Kind == SyntaxKind.QuestionToken &&
                token.Parent is CallExpressionSyntax

            private func FlushSegment(completed List[Doc], segment List[Doc], group bool) {
                if segment.Count == 0 {
                    return
                }
                let document = Doc.Concat(segment)
                completed.Add(
                    if group {
                        Doc.Group(document)
                    } else {
                        document
                    }
                )
                segment.Clear()
            }

            private func AddHardLines(completed List[Doc], count int32) {
                completed.Add(Doc.HardLine)
                if count > 1 {
                    completed.Add(Doc.HardLine)
                }
            }
        }
    }

    private const MaxLineWidth int32 = 120
    private const MaxDiffTraceEntries int64 = 8_000_000

    /// Formats a complete source document.
    /// @param text The source document.
    /// @returns The canonical text, edits, and any diagnostics.
    func Format(text SourceText) FormatResult {
        ArgumentNullException.ThrowIfNull(text, paramName: "text")
        return FormatCore(text, span: nil)
    }

    /// Formats the source changes intersecting a requested span.
    /// @param text The source document.
    /// @param span The requested source span.
    /// @returns The canonical text, intersecting edits, and any diagnostics.
    func Format(text SourceText, span TextSpan) FormatResult {
        var span = span
        ArgumentNullException.ThrowIfNull(text, paramName: "text")
        if span.Start < 0 || span.End > text.Length {
            throw ArgumentOutOfRangeException("span")
        }
        return FormatCore(text, span)
    }

    private func FormatCore(original SourceText, span TextSpan?) FormatResult {
        let working = SortImports(original)
        let tree = SyntaxTree.Parse(working)
        if tree.Diagnostics.Any((diagnostic Diagnostic) -> diagnostic.IsError) {
            return FormatResult(nil, ImmutableArray[TextEdit].Empty, tree.Diagnostics, Changed: false)
        }
        let builder = LayoutBuilder(tree)
        let formatted = Doc.Render(builder.Build(), MaxLineWidth).TrimEnd(' ', '\t', '\r', '\n') + "\n"
        let formattedText = SourceText.From(formatted, original.FileName)
        let validationDiagnostics = ValidateRoundTrip(working, tree, formattedText)
        if !validationDiagnostics.IsEmpty {
            return FormatResult(nil, ImmutableArray[TextEdit].Empty, validationDiagnostics, Changed: false)
        }
        let originalString = original.ToString()
        if formatted == originalString {
            return FormatResult(
                formattedText,
                ImmutableArray[TextEdit].Empty,
                ImmutableArray[Diagnostic].Empty,
                Changed: false
            )
        }
        var edits = CreateLineEdits(originalString, formatted, compareLineContentOnly: span != nil)
        if span is TextSpan requested {
            let requestedLines = ExpandToFullLines(original, requested)
            edits = RestrictEditsToLines(originalString, edits, requestedLines)
            if edits.IsEmpty {
                return FormatResult(
                    original,
                    ImmutableArray[TextEdit].Empty,
                    ImmutableArray[Diagnostic].Empty,
                    Changed: false
                )
            }
        }
        let resultText = if span == nil {
            formattedText
        } else {
            SourceText.From(ApplyEdits(originalString, edits), original.FileName)
        }
        return FormatResult(resultText, edits, ImmutableArray[Diagnostic].Empty, Changed: true)
    }

    private func SortImports(original SourceText) SourceText {
        let tree = SyntaxTree.Parse(original)
        if tree.Diagnostics.Any((diagnostic Diagnostic) -> diagnostic.IsError) {
            return original
        }
        let imports = tree.Root.Members.OfType[ImportSyntax]().ToArray()
        if imports.Length < 2 {
            return original
        }
        let localNames = imports.Select(
            ($import ImportSyntax) -> $import
                .AliasIdentifier
                ?.ValueText ??
                (
                if $import.Identifiers.Length == 0 {
                    string.Empty
                } else {
                    $import.Identifiers[^1].ValueText
                }
            )
        )
            .ToArray()
        if localNames.GroupBy((name string) -> name, StringComparer.Ordinal).Any(
            (group IGrouping[string, string]) -> group.Count() > 1
        ) {
            return original
        }
        let source = original.ToString()
        for var i = 1; i < imports.Length; i++ {
            let gap = source.Substring(imports[i - 1].Span.End, imports[i].Span.Start - imports[i - 1].Span.End)
            if gap.Any((character char) -> !char.IsWhiteSpace(character)) {
                return original
            }
        }
        // A comment is not part of an import's span, so one at either end of
        // the block would stay put while the lines move, re-attaching it to
        // another import. The round-trip check compares comments as an
        // unordered set and cannot see that, so refuse to sort instead.
        let firstLine = Math.Max(0, original.GetLineIndex(imports[0].Span.Start) - 1)
        let lastLine = original.GetLineIndex(imports[^1].Span.End)
        let blockStart = original.Lines[firstLine].Start
        let blockEnd = original.Lines[lastLine].SpanIncludingLineBreak.End
        if SyntaxTree.ParseTokens(original).Any(
            (token SyntaxToken) -> (token.Kind is SyntaxKind.CommentToken or SyntaxKind.DocumentationCommentToken) &&
                token
                .Span
                .Start >= blockStart &&
                token
                .Span
                .Start < blockEnd
        ) {
            return original
        }
        let lines = imports
            .Select(($import ImportSyntax) -> source.Substring($import.Span.Start, $import.Span.Length).Trim())
            .OrderBy((line string) -> line, StringComparer.Ordinal)
            .ToArray()
        if lines.SequenceEqual(
            imports.Select(($import ImportSyntax) -> source.Substring($import.Span.Start, $import.Span.Length).Trim()),
            StringComparer.Ordinal
        ) {
            return original
        }
        let start = imports[0].Span.Start
        let end = imports[^1].Span.End
        let sorted = string.Join("\n", lines)
        return SourceText.From(source.Substring(0, start) + sorted + source.Substring(end), original.FileName)
    }

    private func ValidateRoundTrip(input SourceText, inputTree SyntaxTree, formatted SourceText) ImmutableArray[
        Diagnostic
    ] {
        let formattedTree = SyntaxTree.Parse(formatted)
        if formattedTree.Diagnostics.Any((diagnostic Diagnostic) -> diagnostic.IsError) {
            return formattedTree.Diagnostics
        }
        if !string.Equals(inputTree.Root.ToString(), formattedTree.Root.ToString(), StringComparison.Ordinal) ||
            !SignificantTokens(input).SequenceEqual(SignificantTokens(formatted), StringComparer.Ordinal) || !Comments(
            input
        )
            .SequenceEqual(Comments(formatted), StringComparer.Ordinal) {
            let location = TextLocation(input, TextSpan(0, 0))
            return ImmutableArray.Create(
                Diagnostic(
                    location,
                    "GSF0001",
                    DiagnosticSeverity.Error,
                    "Formatting was rejected because it changed the parsed program or source comments."
                )
            )
        }
        return ImmutableArray[Diagnostic].Empty
    }

    private func SignificantTokens(text SourceText) ImmutableArray[string] {
        let result = ImmutableArray.CreateBuilder[string]()
        for token in SyntaxTree.ParseTokens(text) {
            if (
                token.Kind is SyntaxKind.WhitespaceToken or
                    SyntaxKind.CommentToken or
                    SyntaxKind.DocumentationCommentToken
            ) {
                continue
            }
            result.Add((int32(token.Kind)).ToString(CultureInfo.InvariantCulture) + "\u0000" + token.ValueText)
        }
        return result.ToImmutable()
    }

    private func Comments(text SourceText) ImmutableArray[string] -> SyntaxTree
        .ParseTokens(text)
        .Where((token SyntaxToken) -> (token.Kind is SyntaxKind.CommentToken or SyntaxKind.DocumentationCommentToken))
        .Select((token SyntaxToken) -> token.ValueText)
        .OrderBy((comment string) -> comment, StringComparer.Ordinal)
        .ToImmutableArray()

    private func CreateLineEdits(original string, formatted string, compareLineContentOnly bool) ImmutableArray[
        TextEdit
    ] {
        let originalLines = SplitLines(original)
        let formattedLines = SplitLines(formatted)
        let operations List[DiffOperation]? = DiffLines(originalLines, formattedLines, compareLineContentOnly)
        if operations == nil {
            return ImmutableArray.Create(TextEdit(TextSpan(0, original.Length), formatted))
        }
        let offsets = [originalLines.Length + 1]int32
        for var i = 0; i < originalLines.Length; i++ {
            offsets[i + 1] = offsets[i] + originalLines[i].Length
        }
        let edits = ImmutableArray.CreateBuilder[TextEdit]()
        var originalIndex = 0
        var hunkStart = -1
        var deletedLines = 0
        let replacement = StringBuilder()
        let Flush = func () {
            if hunkStart < 0 {
                return
            }
            let start = offsets[hunkStart]
            let end = offsets[hunkStart + deletedLines]
            edits.Add(TextEdit(TextSpan.FromBounds(start, end), replacement.ToString()))
            hunkStart = -1
            deletedLines = 0
            replacement.Clear()
        }
        for operation in operations {
            switch operation.Kind {
                case DiffKind.Equal {
                    Flush()
                    originalIndex++
                }
                case DiffKind.Delete {
                    hunkStart = if hunkStart < 0 {
                        originalIndex
                    } else {
                        hunkStart
                    }
                    deletedLines++
                    originalIndex++
                }
                case DiffKind.Insert {
                    hunkStart = if hunkStart < 0 {
                        originalIndex
                    } else {
                        hunkStart
                    }
                    replacement.Append(operation.Text)
                }
            }
        }
        Flush()
        return if edits.Count == 0 {
            ImmutableArray.Create(TextEdit(TextSpan(0, original.Length), formatted))
        } else {
            edits.ToImmutable()
        }
    }

    private func ApplyEdits(source string, edits ImmutableArray[TextEdit]) string {
        var source = source
        for var i = edits.Length - 1; i >= 0; i-- {
            var edit = edits[i]
            source = source.Substring(0, edit.Span.Start) + edit.NewText + source.Substring(edit.Span.End)
        }
        return source
    }

    private func RestrictEditsToLines(
        original string,
        edits ImmutableArray[TextEdit],
        requestedLines TextSpan
    ) ImmutableArray[TextEdit] {
        var requestedLines = requestedLines
        let originalLines = SplitLines(original)
        let offsets = [originalLines.Length + 1]int32
        for var i = 0; i < originalLines.Length; i++ {
            offsets[i + 1] = offsets[i] + originalLines[i].Length
        }
        let requestedStart = FindLineBoundary(offsets, requestedLines.Start)
        let requestedEnd = FindLineBoundary(offsets, requestedLines.End)
        let result = ImmutableArray.CreateBuilder[TextEdit]()
        for edit in edits {
            let editStart = FindLineBoundary(offsets, edit.Span.Start)
            let editEnd = FindLineBoundary(offsets, edit.Span.End)
            let deletedLineCount = editEnd - editStart
            let replacementLines = SplitLines(edit.NewText)
            if deletedLineCount == 0 {
                if editStart >= requestedStart && editStart < requestedEnd {
                    result.Add(edit)
                }
                continue
            }
            let selectedStart = Math.Max(editStart, requestedStart)
            let selectedEnd = Math.Min(editEnd, requestedEnd)
            if selectedStart >= selectedEnd {
                continue
            }
            if replacementLines.Length == deletedLineCount {
                let replacementStart = selectedStart - editStart
                result.Add(
                    TextEdit(
                        TextSpan.FromBounds(offsets[selectedStart], offsets[selectedEnd]),
                        string.Concat(replacementLines.Skip(replacementStart).Take(selectedEnd - selectedStart))
                    )
                )
            } else if replacementLines.Length == 0 {
                result.Add(TextEdit(TextSpan.FromBounds(offsets[selectedStart], offsets[selectedEnd]), string.Empty))
            } else if editStart >= requestedStart && editEnd <= requestedEnd {
                result.Add(edit)
            }
        }
        return result.ToImmutable()
    }

    private func FindLineBoundary(offsets[]int32, position int32) int32 {
        for var i = 0; i < offsets.Length; i++ {
            if offsets[i] == position {
                return i
            }
        }
        throw InvalidOperationException("Formatter edits must align to complete source lines.")
    }

    private func SplitLines(text string)[]string {
        let lines = List[string]()
        var start = 0
        for var i = 0; i < text.Length; i++ {
            // `SourceText` treats a lone CR as a line break, so this must too:
            // the line starts it produces are matched against these offsets.
            if text[i] != '\n' && !(text[i] == '\r' && (i + 1 >= text.Length || text[i + 1] != '\n')) {
                continue
            }
            lines.Add(text.Substring(start, i - start + 1))
            start = i + 1
        }
        if start < text.Length {
            lines.Add(text.Substring(start))
        }
        return lines.ToArray()
    }

    private func DiffLines(original[]string, formatted[]string, compareLineContentOnly bool) List[DiffOperation]? {
        let maximum = original.Length + formatted.Length
        let offset = maximum + 1
        let frontier = Enumerable.Repeat(-1, (maximum * 2) + 3).ToArray()
        frontier[offset + 1] = 0
        let trace = List[[]int32]()
        var distance = 0
        for ; distance <= maximum; distance++ {
            // The trace keeps one frontier per edit-distance step, so a large
            // file whose every line changes would need O(D * (N + M)) ints.
            // Give up instead and let the caller fall back to replacing the
            // whole document.
            if int64(trace.Count) * int64(frontier.Length) > MaxDiffTraceEntries {
                return nil
            }
            trace.Add(cast[[]int32](frontier.Clone()))
            for var diagonal = -distance; diagonal <= distance; diagonal += 2 {
                let frontierIndex = offset + diagonal
                var x = if diagonal == -distance ||
                    (diagonal != distance && frontier[frontierIndex - 1] < frontier[frontierIndex + 1]) {
                    frontier[frontierIndex + 1]
                } else {
                    frontier[frontierIndex - 1] + 1
                }
                var y = x - diagonal
                while x < original.Length &&
                    y < formatted.Length &&
                    LinesEqual(original[x], formatted[y], compareLineContentOnly) {
                    x++
                    y++
                }
                frontier[frontierIndex] = x
                if x >= original.Length && y >= formatted.Length {
                    return BacktrackDiff(trace, original, formatted, distance, offset)
                }
            }
        }
        throw InvalidOperationException("Line diff did not converge.")
    }

    private func LinesEqual(left string, right string, compareContentOnly bool) bool -> string.Equals(
        if compareContentOnly {
            left.TrimEnd('\r', '\n')
        } else {
            left
        },
        if compareContentOnly {
            right.TrimEnd('\r', '\n')
        } else {
            right
        },
        StringComparison.Ordinal
    )

    private func BacktrackDiff(
        trace List[[]int32],
        original[]string,
        formatted[]string,
        distance int32,
        offset int32
    ) List[DiffOperation] {
        var x = original.Length
        var y = formatted.Length
        let reversed = List[DiffOperation]()
        for var depth = distance; depth >= 0; depth-- {
            let frontier = trace[depth]
            let diagonal = x - y
            let previousDiagonal = if diagonal == -depth ||
                (diagonal != depth && frontier[offset + diagonal - 1] < frontier[offset + diagonal + 1]) {
                diagonal + 1
            } else {
                diagonal - 1
            }
            let previousX = frontier[offset + previousDiagonal]
            let previousY = previousX - previousDiagonal
            while x > previousX && y > previousY {
                reversed.Add(DiffOperation(DiffKind.Equal, original[x - 1]))
                x--
                y--
            }
            if depth == 0 {
                break
            }
            if x == previousX {
                reversed.Add(DiffOperation(DiffKind.Insert, formatted[previousY]))
                y--
            } else {
                reversed.Add(DiffOperation(DiffKind.Delete, original[previousX]))
                x--
            }
        }
        reversed.Reverse()
        return reversed
    }

    private func ExpandToFullLines(text SourceText, span TextSpan) TextSpan {
        var span = span
        let startLine = text.GetLineIndex(Math.Min(span.Start, Math.Max(0, text.Length - 1)))
        let endPosition = Math.Min(Math.Max(span.Start, span.End), Math.Max(0, text.Length - 1))
        let endLine = text.GetLineIndex(endPosition)
        let end = text.Lines[endLine]
        return TextSpan.FromBounds(text.Lines[startLine].Start, end.Start + end.LengthIncludingLineBreak)
    }
}
