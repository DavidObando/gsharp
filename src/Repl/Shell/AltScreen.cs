// <copyright file="AltScreen.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;

namespace GSharp.Repl.Shell;

/// <summary>
/// Tiny ANSI helper that toggles the alt-screen buffer and synchronized updates.
/// Bypasses Spectre so Enter/Leave work even if the shell crashes mid-render.
/// </summary>
public static class AltScreen
{
    public const string EnterSequence = "\u001b[?1049h\u001b[?25l";

    public const string LeaveSequence = "\u001b[?25h\u001b[?1049l";

    public const string ClearSequence = "\u001b[H\u001b[2J";

    public const string SyncStartSequence = "\u001b[?2026h";

    public const string SyncEndSequence = "\u001b[?2026l";

    public static string InjectEraseBeforeNewlines(string raw)
    {
        if (string.IsNullOrEmpty(raw))
        {
            return raw ?? string.Empty;
        }

        return raw
            .Replace("\r\n", "\n")
            .Replace("\r", string.Empty)
            .Replace("\n", "\u001b[K\n");
    }

    public static void Enter(TextWriter? writer = null) => Emit(EnterSequence, writer);

    public static void Leave(TextWriter? writer = null) => Emit(LeaveSequence, writer);

    public static void Clear(TextWriter? writer = null) => Emit(ClearSequence, writer);

    private static void Emit(string seq, TextWriter? writer)
    {
        var w = writer ?? Console.Out;
        try
        {
            w.Write(seq);
            w.Flush();
        }
        catch
        {
            // Best effort.
        }
    }
}
