// <copyright file="Cell.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using GSharp.Core.CodeAnalysis;

namespace GSharp.Repl.Engine;

/// <summary>One transcript entry: input plus its result, captured console output, or diagnostics.</summary>
public sealed record Cell(
    int Index,
    string Input,
    object? Value,
    ImmutableArray<Diagnostic> Diagnostics,
    bool HasError,
    string Output = "",
    string StandardError = "",
    string SyntaxTree = "",
    string IntermediateLanguage = "");

/// <summary>A single entry in the REPL state sidebar, rendered via the shared <c>SymbolDisplay</c> service.</summary>
public sealed record ReplSymbol(string Display);

/// <summary>Snapshot of the accumulated REPL session: imports, functions, variables, and user types.</summary>
public sealed record ReplState(
    IReadOnlyList<ReplSymbol> Imports,
    IReadOnlyList<ReplSymbol> Functions,
    IReadOnlyList<ReplSymbol> Variables,
    IReadOnlyList<ReplSymbol> Types)
{
    public static ReplState Empty { get; } = new(
        Array.Empty<ReplSymbol>(),
        Array.Empty<ReplSymbol>(),
        Array.Empty<ReplSymbol>(),
        Array.Empty<ReplSymbol>());

    public bool IsEmpty => Imports.Count == 0 && Functions.Count == 0 && Variables.Count == 0 && Types.Count == 0;
}

/// <summary>
/// A <see cref="TextReader"/> that sources whole lines from a callback, letting the interactive
/// REPL prompt the user on demand when evaluated code reads from <see cref="Console.In"/>.
/// </summary>
internal sealed class CallbackTextReader : TextReader
{
    private readonly Func<string?> readLine;
    private string? buffer;
    private int bufferPos;

    public CallbackTextReader(Func<string?> readLine) => this.readLine = readLine ?? throw new ArgumentNullException(nameof(readLine));

    public override string? ReadLine() => readLine();

    public override int Peek() => EnsureBuffer() ? buffer![bufferPos] : -1;

    public override int Read()
    {
        if (!EnsureBuffer())
        {
            return -1;
        }

        var ch = buffer![bufferPos++];
        if (bufferPos >= buffer!.Length)
        {
            buffer = null;
        }

        return ch;
    }

    private bool EnsureBuffer()
    {
        if (buffer is not null && bufferPos < buffer.Length)
        {
            return true;
        }

        var line = readLine();
        if (line is null)
        {
            return false;
        }

        buffer = line + "\n";
        bufferPos = 0;
        return true;
    }
}
