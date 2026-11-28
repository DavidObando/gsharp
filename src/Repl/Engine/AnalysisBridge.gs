// <copyright file="AnalysisBridge.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Engine

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Collections.Generic
import System.Linq
import System.Text.RegularExpressions

/// In-process bridge to the G# language server: completions, hover, semantic tokens,
/// diagnostics, formatting, and syntax-tree dumps for editor text.
shared class AnalysisBridge {
    func Completions(text string, line int32, col int32, state ReplState? = nil) IReadOnlyList[CompletionItem] -> Safe(
        () -> ComputeCompletions(Build(text), nil, line, col, state),
        Array.Empty[CompletionItem]()
    )

    internal func Completions(
        content DocumentContent,
        compilation Compilation,
        line int32,
        col int32,
        state ReplState
    ) IReadOnlyList[CompletionItem] -> Safe(
        () -> ComputeCompletions(content, compilation, line, col, state),
        Array.Empty[CompletionItem]()
    )

    private func ComputeCompletions(
        content DocumentContent,
        compilation Compilation?,
        line int32,
        col int32,
        state ReplState?
    ) IReadOnlyList[CompletionItem] {
        let baseline = CompletionComputer.ComputeCompletionsWithContext(
            content,
            Position(line, col),
            out var isUnqualified,
            compilation: compilation
        )
        return if isUnqualified {
            AddSessionCompletions(baseline, state)
        } else {
            baseline
        }
    }

    func Hover(text string, line int32, col int32, state ReplState? = nil) string? -> Safe(
        () -> HoverComputer.ComputeHover(Build(text), Position(line, col))?.Contents?.MarkupContent?.Value ??
            SessionHover(text, line, col, state),
        nil
    )

    internal func Hover(
        content DocumentContent,
        compilation Compilation,
        line int32,
        col int32,
        state ReplState
    ) string? -> Safe(
        () -> HoverComputer
            .ComputeHover(content, Position(line, col), compilation: compilation)
            ?.Contents
            ?.MarkupContent
            ?.Value ??
            SessionHover(content.SyntaxTree.Text.ToString(), line, col, state),
        nil
    )

    func Analyze(text string) EditorAnalysis -> Safe(() -> AnalyzeCore(text), EditorAnalysis.Empty)

    func Format(text string) string -> Safe(
        () -> GSharpFormatter.Format(SourceText.From(text)).Text?.ToString() ?? text,
        text
    )

    func SyntaxTree(text string) string -> Safe(
        () -> FormatSyntaxTree(GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(text).Root),
        string.Empty
    )

    internal func FormatSyntaxTree(root SyntaxNode) string {
        let sb = System.Text.StringBuilder()
        AppendSyntaxTree(sb, root, "", true)
        return sb.ToString()
    }

    private func AppendSyntaxTree(sb System.Text.StringBuilder, node SyntaxNode, indent string, isLast bool) {
        sb.Append(indent)
        sb.Append(
            if isLast {
                "└──"
            } else {
                "├──"
            }
        )
        sb.Append(node.Kind.ToString())
        if node is SyntaxToken t && t.Value != nil {
            sb.Append(' ')
            sb.Append(t.Value)
        }
        sb.Append('\n')
        let childIndent = indent +
            (
            if isLast {
                "   "
            } else {
                "│  "
            }
        )
        let children = node.GetChildren().ToList()
        for var i = 0; i < children.Count; i++ {
            AppendSyntaxTree(sb, children[i], childIndent, i == children.Count - 1)
        }
    }

    func CompletionEdit(item CompletionItem, line int32, character int32, fallbackStart int32) EditorCompletionEdit {
        var startLine = line
        var startCharacter = fallbackStart
        var endLine = line
        var endCharacter = character
        var text = item.InsertText ?? item.Label ?? string.Empty
        if item.TextEdit != nil {
            startLine = item.TextEdit.Range.Start.Line
            startCharacter = item.TextEdit.Range.Start.Character
            endLine = item.TextEdit.Range.End.Line
            endCharacter = item.TextEdit.Range.End.Character
            text = item.TextEdit.NewText
        }
        if item.InsertTextFormat == InsertTextFormat.Snippet {
            text = Regex.Replace(text, "\\$\\{\\d+:([^}]*)\\}", "$1")
            text = Regex.Replace(text, "\\$\\{\\d+\\}", string.Empty)
            text = Regex.Replace(text, "\\$\\d+", string.Empty)
        }
        return EditorCompletionEdit(startLine, startCharacter, endLine, endCharacter, text)
    }

    internal func WithDiagnostics(
        baseline EditorAnalysis,
        diagnostics IEnumerable[GSharp.Core.CodeAnalysis.Diagnostic],
        source SourceText
    ) EditorAnalysis {
        let mapped = List[EditorDiagnostic]()
        for diagnostic in diagnostics {
            if !object.ReferenceEquals(diagnostic.Location.Text, source) {
                continue
            }
            let severity = if diagnostic.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error {
                1
            } else if diagnostic.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Warning {
                2
            } else {
                3
            }
            mapped.Add(
                EditorDiagnostic(
                    diagnostic.Location.StartLine,
                    diagnostic.Location.StartCharacter,
                    diagnostic.Location.EndLine,
                    diagnostic.Location.EndCharacter,
                    diagnostic.Id,
                    diagnostic.Message,
                    severity
                )
            )
        }
        return EditorAnalysis(baseline.Tokens, mapped)
    }

    internal func AnalyzeTokens(text string) EditorAnalysis -> Safe(
        () -> EditorAnalysis(Tokenize(Build(text), nil), Array.Empty[EditorDiagnostic]()),
        EditorAnalysis.Empty
    )

    internal func AnalyzeTokens(content DocumentContent, compilation Compilation?) EditorAnalysis -> Safe(
        () -> EditorAnalysis(Tokenize(content, compilation), Array.Empty[EditorDiagnostic]()),
        EditorAnalysis.Empty
    )

    internal func Build(text string) DocumentContent {
        let lines = List[int32]()
        var i = text.IndexOf('\n')
        while i >= 0 {
            lines.Add(i)
            i = text.IndexOf('\n', i + 1)
        }
        return DocumentContent(
            GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(text, string.Empty)),
            lines
        )
    }

    private func AnalyzeCore(text string) EditorAnalysis {
        let result = DocumentSyncHandler.ComputeDiagnostics(text, skipBinding: false)
        let tokens = Tokenize(result.Content, nil)
        let diagnostics = result
            .Diagnostics
            .Select(
            (d GSharp.LanguageServer.Protocol.Diagnostic) -> EditorDiagnostic(
                d.Range.Start.Line,
                d.Range.Start.Character,
                d.Range.End.Line,
                d.Range.End.Character,
                d.Code?.Value ?? string.Empty,
                d.Message,
                int32(d.Severity)
            )
        )
            .ToArray()
        return EditorAnalysis(tokens, diagnostics)
    }

    private func Tokenize(content DocumentContent, compilation Compilation?) IReadOnlyList[EditorToken] {
        let document = SemanticTokensDocument(SemanticTokensHandler.Legend)
        let builder = document.Create()
        SemanticTokensComputer.Tokenize(builder, content, compilation: compilation)
        builder.Commit()
        let data = document.GetSemanticTokens().Data
        let tokens = List[EditorToken](data.Length / 5)
        var line = 0
        var character = 0
        for var i = 0; i + 4 < data.Length; i += 5 {
            line += data[i]
            character = if data[i] == 0 {
                character + data[i + 1]
            } else {
                data[i + 1]
            }
            tokens.Add(EditorToken(line, character, data[i + 2], data[i + 3]))
        }
        return tokens
    }

    private func AddSessionCompletions(baseline IReadOnlyList[CompletionItem], state ReplState?) IReadOnlyList[
        CompletionItem
    ] {
        if state == nil || state.IsEmpty {
            return baseline
        }
        let items = baseline.ToList()
        let seen = HashSet[string](
            items.Select((item CompletionItem) -> item.Label ?? string.Empty),
            StringComparer.Ordinal
        )
        Add(items, seen, state.Imports, CompletionItemKind.Module)
        Add(items, seen, state.Functions, CompletionItemKind.Function)
        Add(items, seen, state.Variables, CompletionItemKind.Variable)
        Add(items, seen, state.Types, CompletionItemKind.Class)
        return items
    }

    private func Add(
        items List[CompletionItem],
        seen HashSet[string],
        symbols IReadOnlyList[ReplSymbol],
        kind CompletionItemKind
    ) {
        for symbol in symbols {
            if !seen.Add(symbol.Name) {
                continue
            }
            items.Add(CompletionItem{Label: symbol.Name, Detail: symbol.Display, Kind: kind})
        }
    }

    private func SessionHover(text string, line int32, col int32, state ReplState?) string? {
        if state == nil || state.IsEmpty {
            return nil
        }
        let sourceLines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n')
        if line < 0 || line >= sourceLines.Length || col < 0 || col > sourceLines[line].Length {
            return nil
        }
        let sourceLine = sourceLines[line]
        var start = col
        while start > 0 && IsIdentifierCharacter(sourceLine[start - 1]) {
            start -= 1
        }
        var end = col
        while end < sourceLine.Length && IsIdentifierCharacter(sourceLine[end]) {
            end += 1
        }
        if start == end {
            return nil
        }
        let name = sourceLine.Substring(start, end - start)
        return AllSymbols(state).FirstOrDefault(
            (symbol ReplSymbol) -> string.Equals(symbol.Name, name, StringComparison.Ordinal)
        )
            ?.Display
    }

    private func AllSymbols(state ReplState) IEnumerable[ReplSymbol] -> state
        .Imports
        .Concat(state.Functions)
        .Concat(state.Variables)
        .Concat(state.Types)

    private func IsIdentifierCharacter(value char) bool -> char.IsLetterOrDigit(value) || value == '_'

    private func Safe[T](f() -> T, fallback T) T {
        try {
            return f()
        } catch {
            return fallback
        }
    }
}

/// One semantic token span for live editor styling.
data class EditorToken(Line int32, StartCharacter int32, Length int32, Kind int32) : IEquatable[EditorToken] { }

/// One live diagnostic span for inline editor underlines.
data class EditorDiagnostic(
    StartLine int32,
    StartCharacter int32,
    EndLine int32,
    EndCharacter int32,
    Code string,
    Message string,
    Severity int32
) : IEquatable[EditorDiagnostic] { }

/// Live semantic tokens and diagnostics for the editor buffer.
data class EditorAnalysis(Tokens IReadOnlyList[EditorToken], Diagnostics IReadOnlyList[EditorDiagnostic]) : IEquatable[
    EditorAnalysis
] {
    shared {
        private let _empty EditorAnalysis = EditorAnalysis(Array.Empty[EditorToken](), Array.Empty[EditorDiagnostic]())

        prop Empty EditorAnalysis {
            get {
                return _empty
            }
        }
    }
}

/// Normalized completion replacement range and text.
data class EditorCompletionEdit(
    StartLine int32,
    StartCharacter int32,
    EndLine int32,
    EndCharacter int32,
    NewText string
) : IEquatable[EditorCompletionEdit] { }
