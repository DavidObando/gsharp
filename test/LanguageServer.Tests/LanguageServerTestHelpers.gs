// <copyright file="LanguageServerTestHelpers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Collections.Generic

internal shared class LanguageServerTestHelpers {
    func Content(source string) DocumentContent {
        let lines = List[int32]()
        for var i = 0; i < source.Length; i++ {
            if source[i] == '\n' {
                lines.Add(i)
            }
        }
        return DocumentContent(SyntaxTree.Parse(source), lines)
    }

    func PositionOf(source string, text string, occurrence int32 = 0) Position {
        var index = -1
        var start = 0
        for var i = 0; i <= occurrence; i++ {
            index = source.IndexOf(text, start, StringComparison.Ordinal)
            start = index + text.Length
        }
        var line = 0
        var lineStart = 0
        for var i = 0; i < index; i++ {
            if source[i] == '\n' {
                line++
                lineStart = i + 1
            }
        }
        return Position(line, index - lineStart)
    }
}
