// <copyright file="ReplLayoutTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GSharp.Repl.Engine;
using GSharp.Repl.Screens;
using GSharp.Repl.Shell;
using GSharp.Repl.Widgets;
using Spectre.Console;
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

    [Fact]
    public void Snapshot_Empty_BeforeAnyEvaluation()
    {
        var engine = new SessionEngine();
        Assert.True(engine.Snapshot().IsEmpty);
    }

    [Fact]
    public void Snapshot_CapturesFunctionsVariablesAndImports()
    {
        var engine = new SessionEngine();
        engine.Evaluate("import \"System\"");
        engine.Evaluate("var answer = 42");
        engine.Evaluate("func Twice(n int) int { return n * 2 }");

        var state = engine.Snapshot();
        Assert.False(state.IsEmpty);
        Assert.Contains(state.Variables, v => v.Display.Contains("answer"));
        Assert.Contains(state.Functions, f => f.Display.Contains("Twice"));
        Assert.Contains(state.Imports, i => i.Display.Contains("System"));
    }

    [Fact]
    public void Screen_WithState_RendersSidebarOnWideTerminal()
    {
        var engine = new SessionEngine();
        engine.Evaluate("var answer = 42");
        var screen = new ReplScreen(engine);
        Assert.NotNull(screen.Render(120, 30));
        Assert.NotNull(screen.Render(40, 30));
    }

    [Fact]
    public void Backdrop_FillsBackgroundAcrossFullWidthWithAccentBar()
    {
        var backdrop = new Backdrop(
            new Markup("hi"),
            Color.Grey11,
            accent: Color.Purple,
            padLeft: 1,
            padRight: 1,
            padTop: 1,
            padBottom: 1);

        var text = RenderToAnsi(backdrop, 30);

        // The accent bar glyph and a 256-palette background fill are both emitted.
        Assert.Contains("▏", text);
        Assert.Contains("48;5;", text);
    }

    [Fact]
    public void Screen_TranscriptAndInput_EmitBackgroundFills()
    {
        var engine = new SessionEngine { CaptureConsole = true };
        engine.Evaluate("var answer = 42");
        var screen = new ReplScreen(engine);

        var text = RenderToAnsi(screen.Render(100, 24), 100);

        // Distinct cell (Grey11 => idx 234) and input (Grey19 => idx 236) backgrounds.
        Assert.Contains("48;5;234", text);
        Assert.Contains("48;5;236", text);
    }

    [Theory]
    [InlineData(100, 24)]
    [InlineData(120, 30)]
    [InlineData(70, 18)]
    public void Screen_Render_FillsExactHeight_EvenWhenCellsOverflow(int width, int height)
    {
        var engine = new SessionEngine { CaptureConsole = true };
        for (var i = 0; i < 12; i++)
        {
            engine.Evaluate($"var x{i} = {i}");
        }

        var screen = new ReplScreen(engine);
        Assert.Equal(height, LineCount(screen.Render(width, height), width));
    }

    [Fact]
    public void Screen_Render_FillsExactHeight_WithMultiLineInput()
    {
        var screen = new ReplScreen(new SessionEngine());
        foreach (var ch in "func F() {")
        {
            screen.HandleKey(new ConsoleKeyInfo(ch, ConsoleKey.NoName, false, false, false));
        }

        // Shift+Enter inserts newlines, growing the input box upward.
        for (var i = 0; i < 4; i++)
        {
            screen.HandleKey(new ConsoleKeyInfo('\r', ConsoleKey.Enter, true, false, false));
        }

        Assert.Equal(26, LineCount(screen.Render(100, 26), 100));
    }

    [Fact]
    public void Dock_DocksFooterAtBottom_AndFillsExactHeight()
    {
        var tall = new Rows(Enumerable.Range(0, 50).Select(i => (Spectre.Console.Rendering.IRenderable)new Markup($"line {i}")).ToArray());
        var footer = new Rows(new Markup("footer-a"), new Markup("footer-b"));
        var dock = new Dock(tall, footer, 20, new ScrollState());

        var lines = RenderToAnsi(dock, 40).Split('\n');
        Assert.Equal(20, lines.Length);

        // Footer occupies the final two lines, pinned to the bottom.
        Assert.Contains("footer-a", lines[18]);
        Assert.Contains("footer-b", lines[19]);
    }

    [Fact]
    public void Dock_Scroll_RevealsOlderContent_AndClampsOffset()
    {
        var tall = new Rows(Enumerable.Range(0, 50).Select(i => (Spectre.Console.Rendering.IRenderable)new Markup($"line{i}")).ToArray());
        var footer = new Markup("footer");
        var scroll = new ScrollState();
        var dock = new Dock(tall, footer, 10, scroll);

        // Pinned to the bottom: newest line visible, oldest not.
        var bottom = RenderToAnsi(dock, 40);
        Assert.Contains("line49", bottom);

        // Scroll up beyond the content; the offset is clamped and older lines appear.
        scroll.ScrollUp(1000);
        var top = RenderToAnsi(dock, 40);
        Assert.Contains("line0", top);
        Assert.True(scroll.Offset <= 50, "Offset should be clamped to available scrollback.");
    }

    [Fact]
    public void Overlay_KeepsBaseHeight_AndDrawsModalOnTop()
    {
        var baseFrame = new Rows(Enumerable.Range(0, 20).Select(i => (Spectre.Console.Rendering.IRenderable)new Markup($"base{i}")).ToArray());
        var modal = new Rows(new Markup("MODAL-ROW"));
        var overlay = new Overlay(baseFrame, modal, 20);

        var lines = RenderToAnsi(overlay, 60).Split('\n');
        Assert.Equal(20, lines.Length);
        Assert.Contains(lines, l => l.Contains("MODAL-ROW"));

        // Base chrome above and below the modal band is still present.
        Assert.Contains(lines, l => l.Contains("base0"));
        Assert.Contains(lines, l => l.Contains("base19"));
    }

    private static int LineCount(Spectre.Console.Rendering.IRenderable renderable, int width)
        => RenderToAnsi(renderable, width).Split('\n').Length;

    [Fact]
    public void Screen_MouseScroll_RevealsOlderCells()
    {
        // A dozen cells already overflows an 18-row viewport, which is all this test needs to
        // exercise scrolling. Evaluating many more submissions would be dominated by the
        // incremental compiler's (unrelated) per-submission cost rather than the scroll logic
        // under test, so keep the count modest.
        const int count = 12;
        var engine = new SessionEngine();
        for (var i = 0; i < count; i++)
        {
            engine.Evaluate($"var x{i} = {i}");
        }

        var screen = new ReplScreen(engine);
        var newest = $"x{count - 1}";

        // Pinned to the bottom: newest cell visible, oldest scrolled off.
        var bottom = Plain(RenderToAnsi(screen.Render(70, 18), 70));
        Assert.Contains(newest, bottom);
        Assert.DoesNotContain("x0 ", bottom);

        // Scroll the wheel up repeatedly; older cells come into view.
        for (var i = 0; i < 40; i++)
        {
            Assert.True(screen.HandleScroll(ScrollDirection.Up, 3));
        }

        var top = Plain(RenderToAnsi(screen.Render(70, 18), 70));
        Assert.Contains("x0 ", top);

        // Scrolling back down returns to the newest content.
        for (var i = 0; i < 40; i++)
        {
            screen.HandleScroll(ScrollDirection.Down, 3);
        }

        Assert.Contains(newest, Plain(RenderToAnsi(screen.Render(70, 18), 70)));
    }

    private static string Plain(string ansi)
        => System.Text.RegularExpressions.Regex.Replace(ansi, "\u001b\\[[0-9;]*m", string.Empty);

    [Fact]
    public void AppShell_DispatchScroll_RoutesToActiveTab_ButNotWhenModalOpen()
    {
        var tab = new RecordingTab();
        var shell = new AppShell(NullConsole(), new[] { (ITabScreen)tab }, "1.0");

        shell.DispatchScroll(ScrollDirection.Up);
        shell.DispatchScroll(ScrollDirection.Down);
        Assert.Equal(2, tab.Scrolls.Count);
        Assert.Equal(ScrollDirection.Up, tab.Scrolls[0]);
        Assert.Equal(ScrollDirection.Down, tab.Scrolls[1]);

        // A modal swallows scroll so the palette list isn't scrolled behind it.
        shell.ShowModal(new CommandPalette(new[] { ("theme", "cycle") }, _ => { }));
        shell.DispatchScroll(ScrollDirection.Up);
        Assert.Equal(2, tab.Scrolls.Count);
    }

    private static IAnsiConsole NullConsole()
    {
        var console = AnsiConsole.Create(new AnsiConsoleSettings
        {
            Ansi = AnsiSupport.No,
            ColorSystem = ColorSystemSupport.NoColors,
            Out = new AnsiConsoleOutput(new StringWriter { NewLine = "\n" }),
            Interactive = InteractionSupport.No,
        });
        console.Profile.Width = 80;
        console.Profile.Height = 24;
        return console;
    }

    private sealed class RecordingTab : ITabScreen
    {
        public System.Collections.Generic.List<ScrollDirection> Scrolls { get; } = new();

        public string Title => "Rec";

        public char NumberKey => '1';

        public Spectre.Console.Rendering.IRenderable Render(int width, int height) => new Markup(string.Empty);

        public bool HandleKey(ConsoleKeyInfo key) => false;

        public bool HandleScroll(ScrollDirection direction, int lines)
        {
            Scrolls.Add(direction);
            return true;
        }
    }

    private static string RenderToAnsi(Spectre.Console.Rendering.IRenderable renderable, int width)
    {
        var sw = new StringWriter { NewLine = "\n" };
        var console = AnsiConsole.Create(new AnsiConsoleSettings
        {
            Ansi = AnsiSupport.Yes,
            ColorSystem = ColorSystemSupport.TrueColor,
            Out = new AnsiConsoleOutput(sw),
            Interactive = InteractionSupport.No,
        });
        console.Profile.Width = width;
        console.Write(renderable);
        return sw.ToString();
    }
}
