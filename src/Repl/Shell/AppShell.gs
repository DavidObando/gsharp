// <copyright file="AppShell.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Shell

import GSharp.Repl.Tokens
import GSharp.Repl.Widgets
import Spectre.Console
import Spectre.Console.Rendering
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text.RegularExpressions

/// Top-level TUI controller: header + tab strip + body + pinned hint bar, a modal
/// overlay, and a flicker-free synchronized render loop.
class AppShell : IAppShellNavigator {
    private let console IAnsiConsole
    private let tabs IReadOnlyList[ITabScreen]

    // Captured once, up front: a cell evaluation can run on a background thread while the
    // busy spinner keeps this render loop going on the main thread, and the session engine
    // temporarily swaps the *global* Console.Out/Error to capture that cell's stdout. Writing
    // frames through the live Console.Out property would race with that swap and corrupt the
    // screen; writing through this captured reference to the real terminal writer never does.
    private let realOut TextWriter = Console.Out

    private var activeTab int32
    private var activeModal IModal?
    private var toast string?
    private var exitRequested bool

    init(console IAnsiConsole, tabs IReadOnlyList[ITabScreen]) {
        this.console = console ?? throw ArgumentNullException("console")
        this.tabs = if tabs != nil && tabs.Count > 0 {
            tabs
        } else {
            throw ArgumentException("At least one tab required.", "tabs")
            default(IReadOnlyList[ITabScreen])
        }
    }

    prop ActiveTab int32 -> activeTab

    func SwitchToTab(numberKey char) {
        for var i = 0; i < tabs.Count; i++ {
            if tabs[i].NumberKey == numberKey && i != activeTab {
                activeTab = i
                tabs[i].OnActivated(this)
                return
            }
        }
    }

    func ShowModal(modal IModal) -> activeModal = modal ?? throw ArgumentNullException("modal")

    func DismissModal() -> activeModal = nil

    func ShowToast(message string) -> toast = message ?? string.Empty

    func RequestExit() -> exitRequested = true

    func Run(inputReader IInputReader) int32 {
        ArgumentNullException.ThrowIfNull(inputReader, paramName: "inputReader")
        tabs[activeTab].OnActivated(this)
        Render()
        while true {
            var input InputEvent?
            if tabs[activeTab].IsBusy {
                // Poll instead of blocking indefinitely so the busy spinner keeps animating
                // while an evaluation runs, without spinning the CPU when idle.
                input = inputReader.Read(BusyPollInterval, out var timedOut)
                if timedOut {
                    try {
                        Render()
                    } catch (ex Exception) {
                        toast = "Render error: ${ex.Message}"
                    }
                    continue
                }
            } else {
                input = inputReader.Read()
            }
            if input == nil {
                return 0
            }
            var action = ShellAction.Continue
            try {
                if input.Key is {} key {
                    action = Dispatch(key)
                } else if input.Scroll is {} scroll {
                    DispatchScroll(scroll)
                }
            } catch (ex Exception) {
                toast = "Internal error: ${ex.Message}"
            }
            if action == ShellAction.Exit || exitRequested {
                return 0
            }
            try {
                Render()
            } catch (ex Exception) {
                toast = "Render error: ${ex.Message}"
            }
        }
    }

    /// Routes a mouse-wheel scroll to the active tab (three lines per notch).
    func DispatchScroll(direction ScrollDirection) {
        if activeModal != nil {
            return
        }
        tabs[activeTab].HandleScroll(direction, 3)
    }

    func Dispatch(key ConsoleKeyInfo) ShellAction {
        toast = nil
        if activeModal != nil {
            activeModal!!.HandleKey(key)
            if activeModal!!.IsComplete || key.Key == ConsoleKey.Escape {
                DismissModal()
            }
            return ShellAction.Continue
        }
        if tabs[activeTab].HandleKey(key) {
            return ShellAction.Continue
        }
        if key.KeyChar >= '1' && key.KeyChar <= '9' {
            let idx = key.KeyChar - '1'
            if idx < tabs.Count {
                activeTab = idx
                tabs[idx].OnActivated(this)
            }
            return ShellAction.Continue
        }
        switch key.Key {
            case ConsoleKey.Tab when(key.Modifiers & ConsoleModifiers.Shift) != 0 {
                activeTab = (activeTab - 1 + tabs.Count) % tabs.Count
                tabs[activeTab].OnActivated(this)
            }
            case ConsoleKey.Tab {
                activeTab = (activeTab + 1) % tabs.Count
                tabs[activeTab].OnActivated(this)
            }
            case ConsoleKey.Q when(key.Modifiers & ConsoleModifiers.Shift) != 0 {
                return ShellAction.Exit
            }
            default {
                let _ = 0
            }
        }
        return ShellAction.Continue
    }

    func Render() {
        let width = console.Profile.Width
        let height = Math.Max(10, console.Profile.Height)
        // Chrome is exactly two lines: a rule above the footer, and the footer itself.
        // The body fills the rest so the whole frame is exactly the terminal height (no
        // scrolling, so the body/sidebar/footer never scroll off).
        let bodyHeight = Math.Max(3, height - 2)
        let screen = tabs[activeTab]
        let useBuffer = !Console.IsOutputRedirected
        var sw StringWriter? = nil
        var target IAnsiConsole
        if useBuffer {
            sw = StringWriter{NewLine: "\n"}
            target = AnsiConsole.Create(
                AnsiConsoleSettings{
                    Ansi: AnsiSupport.Yes,
                    ColorSystem: ColorSystemSupport.TrueColor,
                    Out: AnsiConsoleOutput(sw),
                    Interactive: InteractionSupport.No
                }
            )
            target.Profile.Width = width
        } else {
            target = console
        }
        let ruleColor = Tokens.BorderNeutral.Value.ToMarkup()
        let rule = "[$ruleColor]${String('─', Math.Max(1, width))}[/]"
        // Header/rule/footer carry no background of their own, so paint them with the
        // theme's canvas color; otherwise they fall through to the terminal's own
        // background (usually black), clashing with the themed body underneath.
        let canvas = Tokens.Canvas
        let Chrome = func (line IRenderable) IRenderable {
            return Backdrop(line, canvas, padLeft: 0, padRight: 0)
        }
        // Render the body first: it pumps any pending evaluation to completion (see
        // ReplScreen.PumpPendingEvaluation), which can flip IsBusy/FooterOverride for this
        // very frame. Reading those *after* the body render (not before) is what lets the
        // footer catch up in the same frame the evaluation finishes, instead of one frame late.
        let body = screen.Render(width, bodyHeight)
        var footer IRenderable
        if toast != nil {
            footer = Markup("[${Tokens.StatusWarning.Value.ToMarkup()}] ! ${Markup.Escape(toast!!)}[/]")
        } else {
            let hintBar = screen.FooterOverride ?? BuildHintBar(screen).Render()
            let status string? = screen.Status
            if status == nil {
                footer = hintBar
            } else {
                // Right-align the status against the plain (tag-stripped) length of its markup.
                let statusWidth = Math.Min(width - 4, Math.Max(1, StripMarkupTags(status).Length))
                let hintWidth = Math.Max(1, width - statusWidth - 2)
                footer = SideBySide(hintBar, hintWidth, 2, Markup(status), statusWidth, canvas)
            }
        }
        // A single frame renderable whose line breaks fall only BETWEEN rows, so the total
        // line count is deterministic: bodyHeight + 1 + 1 == height.
        var frame IRenderable = Rows(body, Chrome(Markup(rule)), Chrome(footer))
        // The command palette floats as a centered modal over the frame; the surrounding
        // chrome stays visible behind it rather than being replaced.
        if activeModal != nil {
            let modalWidth = Math.Clamp(width - 8, 24, 72)
            frame = Overlay(frame, activeModal!!.Render(modalWidth, bodyHeight), modalWidth)
        }
        // Clamp to exactly the terminal height and strip any trailing line break so the
        // whole frame fits without scrolling (which would push the header off-screen).
        target.Write(FixedHeight(frame, height, Style(background: canvas)))
        if useBuffer && sw != nil {
            let frameText = AltScreen.InjectEraseBeforeNewlines(sw.ToString())
            realOut.Write(
                "${AltScreen.SyncStartSequence}\u001B[H$frameText\u001B[K\u001B[J${AltScreen.SyncEndSequence}"
            )
            realOut.Flush()
        }
    }

    private func BuildHintBar(screen ITabScreen) HintBar {
        return HintBar().Add("/", "commands").Add("Ctrl+Space", "complete").Add("Ctrl+K", "hover").Add("/exit", "quit")
    }

    shared {
        private let BusyPollInterval TimeSpan = TimeSpan.FromMilliseconds(80)
        private func StripMarkupTags(markup string) string -> Regex.Replace(markup, "\\[[^\\]]*\\]", string.Empty)
    }
}

enum ShellAction {
    Continue,
    Exit
}
