// <copyright file="AnalysisBridge.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Engine

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Collections.Generic
import System.Linq

/// In-process bridge to the G# language server: completions and hover for editor text.
shared class AnalysisBridge {
    func Completions(text string, line int32, col int32) IReadOnlyList[CompletionItem] -> Safe(
        () -> CompletionComputer.ComputeCompletions(Build(text), Position(line, col)),
        Array.Empty[CompletionItem]()
    )

    func Hover(text string, line int32, col int32) string? -> Safe(
        () -> HoverComputer.ComputeHover(Build(text), Position(line, col))?.Contents?.MarkupContent?.Value,
        nil
    )

    private func Build(text string) DocumentContent {
        let lines = List[int32]()
        var i = text.IndexOf('\n')
        while i >= 0 {
            lines.Add(i)
            i = text.IndexOf('\n', i + 1)
        }
        return DocumentContent(SyntaxTree.Parse(text), lines)
    }

    private func Safe[T](f() -> T, fallback T) T {
        try {
            return f()
        } catch {
            return fallback
        }
    }
}
