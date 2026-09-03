// <copyright file="AnalysisBridge.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer;
using CoreDiagnostic = GSharp.Core.CodeAnalysis.Diagnostic;
using CompletionItem = GSharp.LanguageServer.Protocol.CompletionItem;
using CompletionItemKind = GSharp.LanguageServer.Protocol.CompletionItemKind;
using InsertTextFormat = GSharp.LanguageServer.Protocol.InsertTextFormat;
using Position = GSharp.LanguageServer.Protocol.Position;
using SemanticTokensDocument = GSharp.LanguageServer.Protocol.SemanticTokensDocument;

namespace GSharp.Repl.Engine;

/// <summary>In-process bridge to the G# language server: completions and hover for editor text.</summary>
public static class AnalysisBridge
{
    public static IReadOnlyList<CompletionItem> Completions(string text, int line, int col, ReplState? state = null)
        => Safe(() => AddSessionCompletions(
            CompletionComputer.ComputeCompletions(Build(text), new Position(line, col)), state), Array.Empty<CompletionItem>());

    internal static IReadOnlyList<CompletionItem> Completions(
        DocumentContent content,
        Compilation compilation,
        int line,
        int col,
        ReplState state)
        => Safe(() => AddSessionCompletions(
            CompletionComputer.ComputeCompletions(content, new Position(line, col), compilation: compilation), state), Array.Empty<CompletionItem>());

    public static string? Hover(string text, int line, int col, ReplState? state = null)
        => Safe(() => HoverComputer.ComputeHover(Build(text), new Position(line, col))?.Contents?.MarkupContent?.Value
            ?? SessionHover(text, line, col, state), null);

    internal static string? Hover(
        DocumentContent content,
        Compilation compilation,
        int line,
        int col,
        ReplState state)
        => Safe(() => HoverComputer.ComputeHover(content, new Position(line, col), compilation: compilation)?.Contents?.MarkupContent?.Value
            ?? SessionHover(content.SyntaxTree.Text.ToString(), line, col, state), null);

    public static EditorAnalysis Analyze(string text)
        => Safe(() => AnalyzeCore(text), EditorAnalysis.Empty);

    public static string Format(string text)
        => Safe(() => FormattingEngine.Format(text), text);

    public static string SyntaxTree(string text)
        => Safe(() => GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(text).Root.ToString(), string.Empty);

    public static EditorCompletionEdit CompletionEdit(CompletionItem item, int line, int character, int fallbackStart)
    {
        var startLine = line;
        var startCharacter = fallbackStart;
        var endLine = line;
        var endCharacter = character;
        var text = item.InsertText ?? item.Label ?? string.Empty;
        if (item.TextEdit is not null)
        {
            startLine = item.TextEdit.Range.Start.Line;
            startCharacter = item.TextEdit.Range.Start.Character;
            endLine = item.TextEdit.Range.End.Line;
            endCharacter = item.TextEdit.Range.End.Character;
            text = item.TextEdit.NewText;
        }

        if (item.InsertTextFormat == InsertTextFormat.Snippet)
        {
            text = Regex.Replace(text, @"\$\{\d+:([^}]*)\}", "$1");
            text = Regex.Replace(text, @"\$\{\d+\}", string.Empty);
            text = Regex.Replace(text, @"\$\d+", string.Empty);
        }

        return new EditorCompletionEdit(startLine, startCharacter, endLine, endCharacter, text);
    }

    internal static EditorAnalysis WithDiagnostics(EditorAnalysis baseline, IEnumerable<CoreDiagnostic> diagnostics, SourceText source)
    {
        var mapped = new List<EditorDiagnostic>();
        foreach (var diagnostic in diagnostics)
        {
            if (!ReferenceEquals(diagnostic.Location.Text, source))
            {
                continue;
            }

            mapped.Add(new EditorDiagnostic(
                diagnostic.Location.StartLine,
                diagnostic.Location.StartCharacter,
                diagnostic.Location.EndLine,
                diagnostic.Location.EndCharacter,
                diagnostic.Id,
                diagnostic.Message,
                diagnostic.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Error ? 1
                    : diagnostic.Severity == GSharp.Core.CodeAnalysis.DiagnosticSeverity.Warning ? 2 : 3));
        }

        return new EditorAnalysis(baseline.Tokens, mapped);
    }

    internal static EditorAnalysis AnalyzeTokens(string text)
        => Safe(() => new EditorAnalysis(Tokenize(Build(text)), Array.Empty<EditorDiagnostic>()), EditorAnalysis.Empty);

    private static EditorAnalysis AnalyzeCore(string text)
    {
        var result = DocumentSyncHandler.ComputeDiagnostics(text, skipBinding: false);
        var tokens = Tokenize(result.Content);
        var diagnostics = result.Diagnostics.Select(d => new EditorDiagnostic(
            d.Range.Start.Line,
            d.Range.Start.Character,
            d.Range.End.Line,
            d.Range.End.Character,
            d.Code?.Value ?? string.Empty,
            d.Message,
            (int)d.Severity)).ToArray();
        return new EditorAnalysis(tokens, diagnostics);
    }

    private static IReadOnlyList<EditorToken> Tokenize(DocumentContent content)
    {
        var document = new SemanticTokensDocument(SemanticTokensHandler.Legend);
        var builder = document.Create();
        SemanticTokensComputer.Tokenize(builder, content);
        builder.Commit();

        var data = document.GetSemanticTokens().Data;
        var tokens = new List<EditorToken>(data.Length / 5);
        var line = 0;
        var character = 0;
        for (var i = 0; i + 4 < data.Length; i += 5)
        {
            line += data[i];
            character = data[i] == 0 ? character + data[i + 1] : data[i + 1];
            tokens.Add(new EditorToken(line, character, data[i + 2], data[i + 3]));
        }

        return tokens;
    }

    internal static DocumentContent Build(string text)
    {
        var lines = new List<int>();
        var i = text.IndexOf('\n');
        while (i >= 0)
        {
            lines.Add(i);
            i = text.IndexOf('\n', i + 1);
        }

        return new DocumentContent(SyntaxTree.Parse(text), lines);
    }

    private static IReadOnlyList<CompletionItem> AddSessionCompletions(IReadOnlyList<CompletionItem> baseline, ReplState? state)
    {
        if (state is null || state.IsEmpty)
        {
            return baseline;
        }

        var items = baseline.ToList();
        var seen = new HashSet<string>(items.Select(item => item.Label ?? string.Empty), StringComparer.Ordinal);
        Add(items, seen, state.Imports, CompletionItemKind.Module);
        Add(items, seen, state.Functions, CompletionItemKind.Function);
        Add(items, seen, state.Variables, CompletionItemKind.Variable);
        Add(items, seen, state.Types, CompletionItemKind.Class);
        return items;
    }

    private static void Add(List<CompletionItem> items, HashSet<string> seen, IReadOnlyList<ReplSymbol> symbols, CompletionItemKind kind)
    {
        foreach (var symbol in symbols)
        {
            if (!seen.Add(symbol.Name))
            {
                continue;
            }

            items.Add(new CompletionItem
            {
                Label = symbol.Name,
                Detail = symbol.Display,
                Kind = kind,
            });
        }
    }

    private static string? SessionHover(string text, int line, int col, ReplState? state)
    {
        if (state is null || state.IsEmpty)
        {
            return null;
        }

        var sourceLines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n');
        if (line < 0 || line >= sourceLines.Length || col < 0 || col > sourceLines[line].Length)
        {
            return null;
        }

        var sourceLine = sourceLines[line];
        var start = col;
        while (start > 0 && IsIdentifierCharacter(sourceLine[start - 1]))
        {
            start--;
        }

        var end = col;
        while (end < sourceLine.Length && IsIdentifierCharacter(sourceLine[end]))
        {
            end++;
        }

        if (start == end)
        {
            return null;
        }

        var name = sourceLine.Substring(start, end - start);
        return AllSymbols(state).FirstOrDefault(symbol => string.Equals(symbol.Name, name, StringComparison.Ordinal))?.Display;
    }

    private static IEnumerable<ReplSymbol> AllSymbols(ReplState state)
        => state.Imports.Concat(state.Functions).Concat(state.Variables).Concat(state.Types);

    private static bool IsIdentifierCharacter(char value) => char.IsLetterOrDigit(value) || value == '_';

    private static T Safe<T>(Func<T> f, T fallback)
    {
        try
        {
            return f();
        }
        catch
        {
            return fallback;
        }
    }
}

public sealed record EditorToken(int Line, int StartCharacter, int Length, int Kind);

public sealed record EditorDiagnostic(
    int StartLine,
    int StartCharacter,
    int EndLine,
    int EndCharacter,
    string Code,
    string Message,
    int Severity);

public sealed record EditorAnalysis(
    IReadOnlyList<EditorToken> Tokens,
    IReadOnlyList<EditorDiagnostic> Diagnostics)
{
    public static EditorAnalysis Empty { get; } = new(Array.Empty<EditorToken>(), Array.Empty<EditorDiagnostic>());
}

public sealed record EditorCompletionEdit(
    int StartLine,
    int StartCharacter,
    int EndLine,
    int EndCharacter,
    string NewText);
