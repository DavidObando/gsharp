// <copyright file="LanguageServerTestHelpers.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Syntax;
using OmniSharp.Extensions.LanguageServer.Protocol.Models;

namespace GSharp.LanguageServer.Tests;

internal static class LanguageServerTestHelpers
{
    public static DocumentContent Content(string source)
    {
        var lines = new List<int>();
        for (var i = 0; i < source.Length; i++)
        {
            if (source[i] == '\n')
            {
                lines.Add(i);
            }
        }

        return new DocumentContent(SyntaxTree.Parse(source), lines);
    }

    public static Position PositionOf(string source, string text, int occurrence = 0)
    {
        var index = -1;
        var start = 0;
        for (var i = 0; i <= occurrence; i++)
        {
            index = source.IndexOf(text, start, System.StringComparison.Ordinal);
            start = index + text.Length;
        }

        var line = 0;
        var lineStart = 0;
        for (var i = 0; i < index; i++)
        {
            if (source[i] == '\n')
            {
                line++;
                lineStart = i + 1;
            }
        }

        return new Position(line, index - lineStart);
    }
}
