// <copyright file="ReplLayoutTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Engine
import GSharp.Repl.Screens
import GSharp.Repl.Shell
import GSharp.Repl.Widgets
import Spectre.Console
import Spectre.Console.Rendering
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text.RegularExpressions
import System.Threading
import Xunit

open class ReplLayoutTests {
    @Fact
    func Editor_RenderLines_PlacesCursor() {
        let ed = MultilineEditor()
        ed.Insert('a')
        ed.Insert('b')
        let line = ed.RenderLines("invert").Single()
        Assert.Contains("invert", line)
    }

    @Fact
    func Screen_TypingAndCompletions_RendersWithoutThrow() {
        using let engine = EmittedSessionEngine()
        let screen = ReplScreen(engine)
        for ch in "func Greet() string { return \"hi\" }" {
            screen.HandleKey(ConsoleKeyInfo(ch, ConsoleKey.NoName, false, false, false))
        }
        screen.HandleKey(ConsoleKeyInfo(' ', ConsoleKey.Spacebar, false, false, true))
        let r = screen.Render(80, 24)
        Assert.NotNull(r)
    }

    @Fact
    func Snapshot_Empty_BeforeAnyEvaluation() {
        using let engine = EmittedSessionEngine()
        Assert.True(engine.Snapshot().IsEmpty)
    }

    @Fact
    func Snapshot_CapturesFunctionsVariablesAndImports() {
        using let engine = EmittedSessionEngine()
        engine.Evaluate("import \"System\"")
        engine.Evaluate("var answer = 42")
        engine.Evaluate("func Twice(n int) int { return n * 2 }")
        let state = engine.Snapshot()
        Assert.False(state.IsEmpty)
        Assert.Contains(state.Variables, (v ReplSymbol) -> v.Display.Contains("answer"))
        Assert.Contains(state.Functions, (f ReplSymbol) -> f.Display.Contains("Twice"))
        Assert.Contains(state.Imports, (i ReplSymbol) -> i.Display.Contains("System"))
    }

    @Fact
    func Screen_WithState_RendersSidebarOnWideTerminal() {
        using let engine = EmittedSessionEngine()
        engine.Evaluate("var answer = 42")
        let screen = ReplScreen(engine)
        Assert.NotNull(screen.Render(120, 30))
        Assert.NotNull(screen.Render(40, 30))
    }

    @Fact
    func Backdrop_FillsBackgroundAcrossFullWidthWithAccentBar() {
        let backdrop = Backdrop(
            Markup("hi"),
            Color.Grey11,
            accent: Color.Purple,
            padLeft: 1,
            padRight: 1,
            padTop: 1,
            padBottom: 1
        )
        let text = RenderToAnsi(backdrop, 30)
        // The accent bar glyph and a 256-palette background fill are both emitted.
        Assert.Contains("▏", text)
        Assert.Contains("48;5;", text)
    }

    @Fact
    func Screen_Enter_EvaluatesAsynchronouslyAndClearsBusyOnCompletion() {
        using let engine = EmittedSessionEngine()
        let screen = ReplScreen(engine)
        for ch in "1 + 1" {
            screen.HandleKey(ConsoleKeyInfo(ch, ConsoleKey.NoName, false, false, false))
        }
        screen.HandleKey(ConsoleKeyInfo('\r', ConsoleKey.Enter, false, false, false))
        let deadline = DateTime.UtcNow.AddSeconds(2.0)
        while screen.IsBusy && DateTime.UtcNow < deadline {
            Thread.Sleep(5)
            screen.Render(80, 24)
        }
        Assert.False(screen.IsBusy)
        Assert.Null(screen.FooterOverride)
        Assert.Single(engine.Cells)
    }

    @Fact
    func Screen_TranscriptAndInput_EmitBackgroundFills() {
        using let engine = EmittedSessionEngine(default(IReadOnlyList[string])){CaptureConsole = true}
        engine.Evaluate("var answer = 42")
        let screen = ReplScreen(engine)
        let text = RenderToAnsi(screen.Render(100, 24), 100)
        // Distinct cell (Grey11 => idx 234) and input (Grey19 => idx 236) backgrounds.
        Assert.Contains("48;5;234", text)
        Assert.Contains("48;5;236", text)
    }

    @Theory
    @InlineData(int32(100), int32(24))
    @InlineData(int32(120), int32(30))
    @InlineData(int32(70), int32(18))
    func Screen_Render_FillsExactHeight_EvenWhenCellsOverflow(width int32, height int32) {
        using let engine = EmittedSessionEngine(default(IReadOnlyList[string])){CaptureConsole = true}
        for var i = 0; i < 12; i++ {
            engine.Evaluate("var x$i = $i")
        }
        let screen = ReplScreen(engine)
        Assert.Equal(height, LineCount(screen.Render(width, height), width))
    }

    @Fact
    func Screen_Render_FillsExactHeight_WithMultiLineInput() {
        using let engine = EmittedSessionEngine()
        let screen = ReplScreen(engine)
        for ch in "func F() {" {
            screen.HandleKey(ConsoleKeyInfo(ch, ConsoleKey.NoName, false, false, false))
        }
        // Shift+Enter inserts newlines, growing the input box upward.
        for var i = 0; i < 4; i++ {
            screen.HandleKey(ConsoleKeyInfo('\r', ConsoleKey.Enter, true, false, false))
        }
        Assert.Equal(26, LineCount(screen.Render(100, 26), 100))
    }

    @Fact
    func Dock_DocksFooterAtBottom_AndFillsExactHeight() {
        let tall = Rows(Enumerable.Range(0, 50).Select((i int32) -> cast[IRenderable](Markup("line $i"))).ToArray())
        let footer = Rows(Markup("footer-a"), Markup("footer-b"))
        let dock = Dock(tall, footer, 20, ScrollState())
        let lines = RenderToAnsi(dock, 40).Split(Environment.NewLine)
        Assert.Equal(20, lines.Length)
        // Footer occupies the final two lines, pinned to the bottom.
        Assert.Contains("footer-a", lines[18])
        Assert.Contains("footer-b", lines[19])
    }

    @Fact
    func Dock_Scroll_RevealsOlderContent_AndClampsOffset() {
        let tall = Rows(Enumerable.Range(0, 50).Select((i int32) -> cast[IRenderable](Markup("line$i"))).ToArray())
        let footer = Markup("footer")
        let scroll = ScrollState()
        let dock = Dock(tall, footer, 10, scroll)
        // Pinned to the bottom: newest line visible, oldest not.
        let bottom = RenderToAnsi(dock, 40)
        Assert.Contains("line49", bottom)
        // Scroll up beyond the content; the offset is clamped and older lines appear.
        scroll.ScrollUp(1000)
        let top = RenderToAnsi(dock, 40)
        Assert.Contains("line0", top)
        Assert.True(scroll.Offset <= 50, "Offset should be clamped to available scrollback.")
    }

    @Fact
    func Overlay_KeepsBaseHeight_AndDrawsModalOnTop() {
        let baseFrame = Rows(Enumerable.Range(0, 20).Select((i int32) -> cast[IRenderable](Markup("base$i"))).ToArray())
        let modal = Rows(Markup("MODAL-ROW"))
        let overlay = Overlay(baseFrame, modal, 20)
        let lines = RenderToAnsi(overlay, 60).Split(Environment.NewLine)
        Assert.Equal(20, lines.Length)
        Assert.Contains(lines, (l string) -> l.Contains("MODAL-ROW"))
        // Base chrome above and below the modal band is still present.
        Assert.Contains(lines, (l string) -> l.Contains("base0"))
        Assert.Contains(lines, (l string) -> l.Contains("base19"))
    }

    @Fact
    func Screen_MouseScroll_RevealsOlderCells() {
        // A dozen cells already overflows an 18-row viewport, which is all this test needs to
        // exercise scrolling. Evaluating many more submissions would be dominated by the
        // incremental compiler's (unrelated) per-submission cost rather than the scroll logic
        // under test, so keep the count modest.
        const count = 12
        using let engine = EmittedSessionEngine()
        for var i = 0; i < count; i++ {
            engine.Evaluate("var x$i = $i")
        }
        let screen = ReplScreen(engine)
        let newest = "x${count - 1}"
        // Pinned to the bottom: newest cell visible, oldest scrolled off.
        let bottom = Plain(RenderToAnsi(screen.Render(70, 18), 70))
        Assert.Contains(newest, bottom)
        Assert.DoesNotContain("x0 ", bottom)
        // Scroll the wheel up repeatedly; older cells come into view.
        for var i = 0; i < 40; i++ {
            Assert.True(screen.HandleScroll(ScrollDirection.Up, 3))
        }
        let top = Plain(RenderToAnsi(screen.Render(70, 18), 70))
        Assert.Contains("x0 ", top)
        // Scrolling back down returns to the newest content.
        for var i = 0; i < 40; i++ {
            screen.HandleScroll(ScrollDirection.Down, 3)
        }
        Assert.Contains(newest, Plain(RenderToAnsi(screen.Render(70, 18), 70)))
    }

    @Fact
    func AppShell_DispatchScroll_RoutesToActiveTab_ButNotWhenModalOpen() {
        let tab = RecordingTab()
        let shell = AppShell(NullConsole(), []ITabScreen{cast[ITabScreen](tab)})
        shell.DispatchScroll(ScrollDirection.Up)
        shell.DispatchScroll(ScrollDirection.Down)
        Assert.Equal(2, tab.Scrolls.Count)
        Assert.Equal(ScrollDirection.Up, tab.Scrolls[0])
        Assert.Equal(ScrollDirection.Down, tab.Scrolls[1])
        // A modal swallows scroll so the palette list isn't scrolled behind it.
        shell.ShowModal(CommandPalette([](string, string){("theme", "cycle")}, (_ string) -> { }))
        shell.DispatchScroll(ScrollDirection.Up)
        Assert.Equal(2, tab.Scrolls.Count)
    }

    @Fact
    func AppShell_CtrlC_DoesNotExit() {
        let shell = AppShell(NullConsole(), []ITabScreen{cast[ITabScreen](RecordingTab())})
        let ctrlC = ConsoleKeyInfo('\u0003', ConsoleKey.C, false, false, true)
        Assert.Equal(ShellAction.Continue, shell.Dispatch(ctrlC))
        Assert.Equal(ShellAction.Continue, shell.Dispatch(ctrlC))
    }

    private class RecordingTab : ITabScreen {
        init() {
            Scrolls = List[ScrollDirection]()
        }

        prop Scrolls List[ScrollDirection] {
            get;
        }

        prop Title string -> "Rec"
        prop NumberKey char -> '1'

        func Render(width int32, height int32) IRenderable -> Markup(string.Empty)

        func HandleKey(key ConsoleKeyInfo) bool -> false

        func HandleScroll(direction ScrollDirection, lines int32) bool {
            Scrolls.Add(direction)
            return true
        }
    }

    shared {
        private func LineCount(renderable IRenderable, width int32) int32 -> RenderToAnsi(renderable, width).Split(
            Environment.NewLine
        )
            .Length

        private func Plain(ansi string) string -> Regex.Replace(ansi, "\u001B\\[[0-9;]*m", string.Empty)

        private func NullConsole() IAnsiConsole {
            let console = AnsiConsole.Create(
                AnsiConsoleSettings{
                    Ansi: AnsiSupport.No,
                    ColorSystem: ColorSystemSupport.NoColors,
                    Out: AnsiConsoleOutput(StringWriter{NewLine: Environment.NewLine}),
                    Interactive: InteractionSupport.No
                }
            )
            console.Profile.Width = 80
            console.Profile.Height = 24
            return console
        }

        private func RenderToAnsi(renderable IRenderable, width int32) string {
            let sw = StringWriter{NewLine: Environment.NewLine}
            let console = AnsiConsole.Create(
                AnsiConsoleSettings{
                    Ansi: AnsiSupport.Yes,
                    ColorSystem: ColorSystemSupport.TrueColor,
                    Out: AnsiConsoleOutput(sw),
                    Interactive: InteractionSupport.No
                }
            )
            console.Profile.Width = width
            console.Write(renderable)
            return sw.ToString()
        }
    }
}
