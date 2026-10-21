// <copyright file="SyntaxTree.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Threading

/// Represents the language's syntax tree.
open class SyntaxTree {
    private var documentationTable Dictionary[SyntaxNode, string]?
    private var parents Dictionary[SyntaxNode, SyntaxNode]?
    private var root CompilationUnitSyntax?

    private init(text SourceText) {
        Text = text
        Diagnostics = ImmutableArray[Diagnostic].Empty
        DocumentationTokens = ImmutableArray[SyntaxToken].Empty
    }

    /// Gets the source text.
    prop Text SourceText {
        get;
    }

    /// Gets the diagnostics.
    prop Diagnostics ImmutableArray[Diagnostic] {
        get;
        private set;
    }

    /// Gets the compilation unit root.
    prop Root CompilationUnitSyntax -> Invariant.Required(
        root,
        "a syntax tree publishes its root before returning to callers",
        expression: "root"
    )

    /// Gets the documentation comment tokens collected during lexing (ADR-0057 §7).
    internal prop DocumentationTokens ImmutableArray[SyntaxToken] {
        get;
        private set;
    }

    /// Returns the parent of [`node`](paramref) within this tree, or
    /// `null` for the root (ADR-0169: backs
    /// (cref:SyntaxNode.Parent)). The parent index is built lazily on
    /// first use with one (cref:SyntaxNode.GetChildren) walk and cached
    /// for the tree's lifetime; trees are immutable, so it never invalidates.
    /// @param node A node belonging to this tree.
    /// @returns The parent node, or null for the root.
    func GetParent(node SyntaxNode) SyntaxNode? {
        var index Dictionary[SyntaxNode, SyntaxNode]? = parents
        if index == nil {
            index = BuildParentIndex()
            Interlocked.CompareExchange(&parents, index, nil)
            index = parents
        }
        return if index!!.TryGetValue(node, out var parent) {
            parent
        } else {
            default(SyntaxNode?)
        }
    }

    /// Gets the attached documentation text for a declaration node, or `null`
    /// when no documentation block is associated (ADR-0057 §7).
    /// @param node The declaration syntax node.
    /// @returns The joined documentation block text, or `null`.
    internal func GetDocumentation(node SyntaxNode) string? {
        if documentationTable == nil {
            documentationTable = DocumentationAttacher.Attach(this)
        }
        return if documentationTable!!.TryGetValue(node, out var doc) {
            doc
        } else {
            default(string?)
        }
    }

    private func SetParseResult(
        root CompilationUnitSyntax,
        diagnostics ImmutableArray[Diagnostic],
        documentationTokens ImmutableArray[SyntaxToken]
    ) {
        this.root = root
        Diagnostics = diagnostics
        DocumentationTokens = documentationTokens
    }

    private func BuildParentIndex() Dictionary[SyntaxNode, SyntaxNode] {
        let index = Dictionary[SyntaxNode, SyntaxNode](ReferenceEqualityComparer.Instance)
        let pending = Stack[SyntaxNode]()
        pending.Push(Root)
        while pending.Count > 0 {
            let current = pending.Pop()
            for child in current.GetChildren() {
                index[child] = current
                pending.Push(child)
            }
        }
        return index
    }

    shared {
        /// Parses the source text from the provided file path into a syntax tree.
        /// @param filePath The source file path.
        /// @returns A parsed syntax tree.
        func Load(filePath string) SyntaxTree {
            return Parse(SourceText.Load(filePath))
        }

        /// Parses the source text into a syntax tree.
        /// @param text The source text.
        /// @returns A parsed syntax tree.
        func Parse(text string) SyntaxTree {
            let sourceText = SourceText.From(text)
            return Parse(sourceText)
        }

        /// Parses the source text into a syntax tree.
        /// @param text The source text.
        /// @returns A parsed syntax tree.
        func Parse(text SourceText) SyntaxTree {
            let syntaxTree = SyntaxTree(text)
            let parser = Parser(syntaxTree)
            syntaxTree.SetParseResult(
                parser.ParseCompilationUnit(),
                parser.Diagnostics.ToImmutableArray(),
                parser.DocumentationTokens
            )
            return syntaxTree
        }

        /// Parses the tokens in the provided source text.
        /// @param text The source text.
        /// @returns The tokens in the source text.
        func ParseTokens(text string) ImmutableArray[SyntaxToken] {
            let sourceText = SourceText.From(text)
            return ParseTokens(sourceText)
        }

        /// Parses the tokens in the provided source text.
        /// @param text The source text.
        /// @returns The tokens in the source text.
        func ParseTokens(text SourceText) ImmutableArray[SyntaxToken] {
            return ParseTokens(text, out _)
        }

        /// Parses the tokens in the provided source text and provides error diagnostics information.
        /// @param text The source text.
        /// @param diagnostics The diagnostics obtained by parsing the source text.
        /// @returns The tokens in the source text.
        func ParseTokens(text string, out diagnostics ImmutableArray[Diagnostic]) ImmutableArray[SyntaxToken] {
            let sourceText = SourceText.From(text)
            return ParseTokens(sourceText, out diagnostics)
        }

        /// Parses the tokens in the provided source text and provides error diagnostics information.
        /// @param text The source text.
        /// @param diagnostics The diagnostics obtained by parsing the source text.
        /// @returns The tokens in the source text.
        func ParseTokens(text SourceText, out diagnostics ImmutableArray[Diagnostic]) ImmutableArray[SyntaxToken] {
            let tokens = List[SyntaxToken]()
            let syntaxTree = SyntaxTree(text)
            let lexer = Lexer(syntaxTree)
            var root CompilationUnitSyntax? = nil
            while true {
                let token = lexer.Lex()
                if token.Kind == SyntaxKind.EndOfFileToken {
                    root = CompilationUnitSyntax(syntaxTree, ImmutableArray[MemberSyntax].Empty, token)
                    break
                }
                tokens.Add(token)
            }
            syntaxTree.SetParseResult(root!!, lexer.Diagnostics.ToImmutableArray(), ImmutableArray[SyntaxToken].Empty)
            diagnostics = syntaxTree.Diagnostics
            return tokens.ToImmutableArray()
        }
    }
}
