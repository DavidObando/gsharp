// <copyright file="ReplLayoutTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using GSharp.Repl.Engine;
using GSharp.Repl.Screens;
using Xunit;

namespace GSharp.Interpreter.Tests;

public class ReplLayoutTests
{
    [Fact]
    public void Editor_RenderLines_PlacesCursor()
    {
        var ed = new MultilineEditor();
        ed.Insert('a');
        ed.Insert('b');
        var line = ed.RenderLines("invert").Single();
        Assert.Contains("invert", line);
    }

    [Fact]
    public void Screen_TypingAndCompletions_RendersWithoutThrow()
    {
        var screen = new ReplScreen(new SessionEngine());
        foreach (var ch in "func Greet() string { return \"hi\" }")
        {
            screen.HandleKey(new ConsoleKeyInfo(ch, ConsoleKey.NoName, false, false, false));
        }

        screen.HandleKey(new ConsoleKeyInfo(' ', ConsoleKey.Spacebar, false, false, true));
        var r = screen.Render(80, 24);
        Assert.NotNull(r);
    }
}
