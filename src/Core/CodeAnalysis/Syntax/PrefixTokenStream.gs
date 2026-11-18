// <copyright file="PrefixTokenStream.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable

/// The tokens of a prefix tree (ADR-0225): the tokens before the cut, one zero-width closing token for
/// each delimiter that is open at the cut, and the kept tokens after the cut.
/// @remarks The tokens keep their positions in the source text, so the prefix tree and the source
/// tree agree on every position before the cut.
internal sealed class PrefixTokenStream {
    private init(
        tokens ImmutableArray[SyntaxToken],
        documentationTokens ImmutableArray[SyntaxToken],
        lexerDiagnostics ImmutableArray[Diagnostic],
        cut PrefixCut
    ) {
        Tokens = tokens
        DocumentationTokens = documentationTokens
        LexerDiagnostics = lexerDiagnostics
        Cut = cut
    }

    /// Gets the tokens. The last token is the end-of-file token.
    internal prop Tokens ImmutableArray[SyntaxToken] {
        get;
    }

    /// Gets the documentation comment tokens.
    internal prop DocumentationTokens ImmutableArray[SyntaxToken] {
        get;
    }

    /// Gets the lexer diagnostics.
    internal prop LexerDiagnostics ImmutableArray[Diagnostic] {
        get;
    }

    /// Gets the facts of the cut.
    internal prop Cut PrefixCut {
        get;
    }

    shared {
        /// Builds the tokens of a prefix tree.
        /// @param prefixTree The new tree that owns the tokens. Its text is the text of [`source`](paramref).
        /// @param source The tree that the host gave.
        /// @param cut The cut position.
        /// @param remainder What follows the cut.
        /// @returns The tokens and the facts of the cut.
        internal func Build(
            prefixTree SyntaxTree,
            source SyntaxTree,
            cut int32,
            remainder PrefixRemainder
        ) PrefixTokenStream {
            let tokens = List[SyntaxToken]()
            let documentationTokens = ImmutableArray.CreateBuilder[SyntaxToken]()
            let diagnostics = List[Diagnostic]()
            let atCut = List[Diagnostic]()
            Lex(prefixTree, 0, cut, tokens, documentationTokens, diagnostics, atCut)
            let openers = OpenDelimiters(tokens)
            let textLength = prefixTree.Text.Length
            var sealFrom = 0
            var laterDeclarationsPossible = remainder == PrefixRemainder.Nothing
            var openMemberStart = -1
            let kept = List[TextSpan]()
            if remainder == PrefixRemainder.KeepDeclarations {
                let layout = CutLayout.Find(source.Root, cut)
                if layout.ContainerBraces.Count <= openers.Count && StartsWith(openers, layout.ContainerBraces) {
                    sealFrom = layout.ContainerBraces.Count
                    let member = layout.Member
                    if member != nil {
                        openMemberStart = member.Span.Start
                    }
                    let resume = if member != nil {
                        member.Span.End
                    } else {
                        cut
                    }
                    if layout.ContainerBraces.Count == 0 && layout.TopLevelStatementsOpen {
                        // The top-level statements after the cut belong to the open statement sequence.
                        laterDeclarationsPossible = true
                        for candidate in layout.FileMembers {
                            if candidate.Span.Start >= resume && candidate is not GlobalStatementSyntax {
                                kept.Add(candidate.Span)
                            }
                        }
                    } else if resume < textLength {
                        kept.Add(TextSpan.FromBounds(resume, textLength))
                    }
                } else {
                    // The source tree does not match the delimiters before the cut (an unbalanced
                    // source). Nothing is kept, so a later declaration stays possible.
                    laterDeclarationsPossible = true
                }
            }
            let lastToken = if tokens.Count > 0 {
                tokens[tokens.Count - 1]
            } else {
                default(SyntaxToken?)
            }
            let sealedTokens = ImmutableArray.CreateBuilder[SyntaxToken]()
            for var i = openers.Count - 1; i >= sealFrom; i-- {
                let token = SyntaxToken.SealedAtCut(prefixTree, CloserOf(openers[i].Kind), cut)
                sealedTokens.Add(token)
                tokens.Add(token)
            }
            var endOfFile = cut
            for span in kept {
                Lex(prefixTree, span.Start, span.End, tokens, documentationTokens, diagnostics)
                endOfFile = span.End
            }
            tokens.Add(SyntaxToken(prefixTree, SyntaxKind.EndOfFileToken, endOfFile, string.Empty, nil))
            let keptStart = if kept.Count > 0 {
                kept[0].Start
            } else {
                textLength
            }
            let facts = PrefixCut(
                prefixTree.Text,
                cut,
                remainder,
                Math.Max(keptStart, cut),
                laterDeclarationsPossible,
                openMemberStart,
                sealedTokens.ToImmutable()
            )
            if lastToken != nil {
                facts.LastToken = lastToken.Span
                facts.LastTokenIsWord = lastToken
                    .Text
                    .Length > 0 &&
                    IsWordCharacter(lastToken.Text[lastToken.Text.Length - 1])
            }
            facts.HasKeptText = kept.Count > 0
            facts.UnfinishedTokenDiagnostics = atCut.ToImmutableArray()
            return PrefixTokenStream(
                tokens.ToImmutableArray(),
                documentationTokens.ToImmutable(),
                diagnostics.ToImmutableArray(),
                facts
            )
        }

        // Lexes [start, end) as the parser does, without the end-of-file token.
        private func Lex(
            tree SyntaxTree,
            start int32,
            end int32,
            tokens List[SyntaxToken],
            documentationTokens ImmutableArray[SyntaxToken].Builder,
            diagnostics List[Diagnostic],
            atEndOfInput List[Diagnostic]? = nil
        ) {
            let lexer = Lexer(tree, start, end)
            while true {
                let token = lexer.Lex()
                if token.Kind == SyntaxKind.EndOfFileToken {
                    break
                }
                if token.Kind == SyntaxKind.DocumentationCommentToken {
                    documentationTokens.Add(token)
                } else if token.Kind != SyntaxKind.WhitespaceToken &&
                    token.Kind != SyntaxKind.CommentToken &&
                    token.Kind != SyntaxKind.BadToken {
                    tokens.Add(token)
                }
            }
            diagnostics.AddRange(lexer.Diagnostics)
            atEndOfInput?.AddRange(lexer.DiagnosticsAtEndOfInput)
        }

        // The opening delimiters that no later token closes, outermost first.
        private func OpenDelimiters(tokens List[SyntaxToken]) List[SyntaxToken] {
            let openers = List[SyntaxToken]()
            for token in tokens {
                switch token.Kind {
                    case SyntaxKind.OpenParenthesisToken,
                    SyntaxKind.OpenSquareBracketToken,
                    SyntaxKind.QuestionOpenBracketToken,
                    SyntaxKind.OpenBraceToken {
                        openers.Add(token)
                    }
                    case SyntaxKind.CloseParenthesisToken,
                    SyntaxKind.CloseSquareBracketToken,
                    SyntaxKind
                        .CloseBraceToken {
                        // A stray closer closes the nearest opener of its kind and every opener after it,
                        // as the parser's recovery does. A closer without an opener changes nothing.
                        for var i = openers.Count - 1; i >= 0; i-- {
                            if CloserOf(openers[i].Kind) == token.Kind {
                                openers.RemoveRange(i, openers.Count - i)
                                break
                            }
                        }
                    }
                    default { }
                }
            }
            return openers
        }

        /// Returns a value that tells whether [`c`](paramref) can continue a name, a keyword or a number.
        /// @param c A character.
        /// @returns `true` for a letter, a digit or `_`.
        internal func IsWordCharacter(c char) bool -> char.IsLetterOrDigit(c) || c == '_'

        private func StartsWith(openers List[SyntaxToken], positions List[int32]) bool {
            for var i = 0; i < positions.Count; i++ {
                if openers[i].Kind != SyntaxKind.OpenBraceToken || openers[i].Position != positions[i] {
                    return false
                }
            }
            return true
        }

        private func CloserOf(kind SyntaxKind) SyntaxKind -> switch kind {
            case SyntaxKind.OpenParenthesisToken: SyntaxKind.CloseParenthesisToken
            case SyntaxKind.OpenBraceToken: SyntaxKind.CloseBraceToken
            default: SyntaxKind.CloseSquareBracketToken
        }
    }
}

/// Where a cut lies in the declarations of a source tree (ADR-0225).
internal sealed class CutLayout {
    private init(
        containerBraces List[int32],
        member SyntaxNode?,
        topLevelStatementsOpen bool,
        fileMembers ImmutableArray[MemberSyntax]
    ) {
        ContainerBraces = containerBraces
        Member = member
        TopLevelStatementsOpen = topLevelStatementsOpen
        FileMembers = fileMembers
    }

    /// Gets the open-brace positions of the declaration bodies that contain the cut, outermost first.
    internal prop ContainerBraces List[int32] {
        get;
    }

    /// Gets the member of the innermost declaration body that contains the cut, or `null` when the cut
    /// is between members.
    internal prop Member SyntaxNode? {
        get;
    }

    /// Gets a value that tells whether the cut is in the top-level statements of the file.
    internal prop TopLevelStatementsOpen bool {
        get;
    }

    /// Gets the members of the file.
    internal prop FileMembers ImmutableArray[MemberSyntax] {
        get;
    }

    shared {
        /// Finds the declaration bodies and the member that contain [`cut`](paramref).
        /// @param root The root of the source tree.
        /// @param cut The cut position.
        /// @returns The layout.
        internal func Find(root CompilationUnitSyntax, cut int32) CutLayout {
            let braces = List[int32]()
            var container SyntaxNode = root
            var member SyntaxNode? = nil
            while true {
                let child = ChildContaining(container, cut)
                if child == nil {
                    break
                }
                let brace = BodyOpenBrace(child)
                // A body whose closing brace the source does not have is sealed like any open construct.
                if brace != nil && !brace.IsMissing && brace.Position < cut && !EndsWithMissingToken(child) {
                    braces.Add(brace.Position)
                    container = child
                    continue
                }
                member = child
                break
            }
            var topLevelStatementsOpen = false
            if braces.Count == 0 {
                if member != nil {
                    topLevelStatementsOpen = member is GlobalStatementSyntax
                } else {
                    // Between two members of the file: the statements are open when the member
                    // before the cut is a top-level statement.
                    for candidate in root.Members {
                        if candidate.Span.End <= cut {
                            topLevelStatementsOpen = candidate is GlobalStatementSyntax
                        }
                    }
                }
            }
            return CutLayout(braces, member, topLevelStatementsOpen, root.Members)
        }

        // A child that ends at the cut contains it when the parser closed it with a missing token: the
        // source text ends inside that child.
        private func ChildContaining(node SyntaxNode, cut int32) SyntaxNode? {
            for child in node.GetChildren() {
                let span = child.Span
                if span.Start < cut && (cut < span.End || cut == span.End && EndsWithMissingToken(child)) {
                    return child
                }
            }
            return nil
        }

        private func EndsWithMissingToken(node SyntaxNode) bool {
            var current SyntaxNode = node
            while current is not SyntaxToken {
                let count = current.ChildCount
                if count == 0 {
                    return false
                }
                current = current.GetChild(count - 1)
            }
            return cast[SyntaxToken](current).IsMissing
        }

        // The open brace of a body that holds declarations, or null.
        private func BodyOpenBrace(node SyntaxNode) SyntaxToken? {
            if node is StructDeclarationSyntax type {
                return type.OpenBraceToken
            }
            if node is InterfaceDeclarationSyntax contract {
                return contract.OpenBraceToken
            }
            if node is EnumDeclarationSyntax enumeration {
                return enumeration.OpenBraceToken
            }
            if node is SharedBlockSyntax block {
                return block.OpenBraceToken
            }
            return nil
        }
    }
}
