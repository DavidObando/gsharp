// <copyright file="ReplScreen.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Screens

import GSharp.Core.CodeAnalysis
import GSharp.LanguageServer.Protocol
import GSharp.Repl
import GSharp.Repl.Engine
import GSharp.Repl.Shell
import GSharp.Repl.Themes
import GSharp.Repl.Tokens
import GSharp.Repl.Widgets
import Spectre.Console
import Spectre.Console.Rendering
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Threading
import System.Threading.Tasks

/// OpenCode-style single conversation view: scrolling transcript plus a pinned input box.
class ReplScreen : ITabScreen, IDisposable {
    private let engine ISessionEngine
    private let editor MultilineEditor = MultilineEditor()
    private let scroll ScrollState = ScrollState()
    private var navigator IAppShellNavigator?
    private var completions List[CompletionItem] = List[CompletionItem]()
    private var completionIndex int32
    private var completionTop int32
    private var hover string?
    private var evalCts CancellationTokenSource?
    private var pendingEval Task[GSharp.Repl.Engine.Cell]?
    private var evalFrame int32
    private var cancelRequested bool

    init(engine ISessionEngine) {
        this.engine = engine
        engine.CaptureConsole = true
        engine.InputProvider = InlinePrompt.ReadLine
    }

    prop Title string -> "REPL"
    prop NumberKey char -> '1'
    prop IsBusy bool -> pendingEval != nil
    prop Hints IEnumerable[KeyValuePair[string, string?]] -> []KeyValuePair[string, string?]{
        KeyValuePair[string, string?]("Enter", "run"),
        KeyValuePair[string, string?]("Ctrl+Space", "complete"),
        KeyValuePair[string, string?]("Ctrl+K", "hover"),
        KeyValuePair[string, string?]("/", "cmds")
    }

    prop FooterOverride IRenderable? {
        get {
            if pendingEval == nil {
                return nil
            }
            let brand = Tokens.Brand.Value
            let brandMarkup = brand.ToMarkup()
            let tertiary = Tokens.TextTertiary.Value.ToMarkup()
            // Themed on every read (not cached) so a theme switch mid-evaluation is picked up;
            // the spinner itself is cheap (a handful of Color structs) to rebuild per frame.
            let spinner = KnightRiderAnimation(
                width: 6,
                style: KnightRiderStyle.Blocks,
                holdStart: 6,
                holdEnd: 3,
                colors: KnightRiderAnimation.DeriveTrailColors(brand),
                defaultColor: KnightRiderAnimation.DeriveInactiveColor(brand, factor: 0.6),
                minAlpha: 0.3
            )
            let glyphs = spinner.RenderMarkup(evalFrame, Tokens.Canvas)
            // Cancellation can't interrupt a running evaluation (no cooperative cancellation in
            // the engine, see ISessionEngine.EvaluateAsync), so give immediate feedback that
            // Esc registered instead of leaving the hint unchanged until the eval happens to finish.
            let hint = if cancelRequested {
                "[$tertiary]cancelling…[/]"
            } else {
                "[$brandMarkup]Esc[/] [$tertiary]interrupt[/]"
            }
            return Markup("$glyphs  $hint")
        }
    }

    prop Status string {
        get {
            let tertiary = Tokens.TextTertiary.Value.ToMarkup()
            let diag = engine
                .Cells
                .SelectMany(
                func (c GSharp.Repl.Engine.Cell) IEnumerable[GSharp.Core.CodeAnalysis.Diagnostic] {
                    return c.Diagnostics
                }
            )
                .Count((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
            return if diag == 0 {
                "[${Tokens.StatusSuccess.Value.ToMarkup()}]●[/] gsharp [$tertiary]· ready[/]"
            } else {
                "[${Tokens.StatusError.Value.ToMarkup()}]●[/] gsharp [$tertiary]· $diag error(s)[/]"
            }
        }
    }

    func OnActivated(nav IAppShellNavigator) -> navigator = nav

    func Dispose() -> evalCts?.Dispose()

    func HandleScroll(direction ScrollDirection, lines int32) bool {
        if direction == ScrollDirection.Up {
            scroll.ScrollUp(lines)
        } else {
            scroll.ScrollDown(lines)
        }
        return true
    }

    func HandleKey(key ConsoleKeyInfo) bool {
        if pendingEval != nil && key.Key == ConsoleKey.Escape {
            if !cancelRequested {
                cancelRequested = true
                evalCts?.Cancel()
            }
            return true
        }
        if completions.Count > 0 {
            switch key.Key {
                case ConsoleKey.UpArrow {
                    Move(-1)
                    return true
                }
                case ConsoleKey.DownArrow {
                    Move(1)
                    return true
                }
                case ConsoleKey.Tab, ConsoleKey.Enter {
                    AcceptCompletion()
                    return true
                }
                case ConsoleKey.Escape {
                    completions = List[CompletionItem]()
                    return true
                }
                default {
                    let _ = 0
                }
            }
        }
        if hover != nil && key.Key == ConsoleKey.Escape {
            hover = nil
            return true
        }
        // Scroll the transcript viewport without disturbing the editor cursor or the pinned
        // input box. Page-sized on PageUp/PageDown, line-sized on Ctrl+Up/Ctrl+Down.
        let ctrl = (key.Modifiers & ConsoleModifiers.Control) != 0
        switch key.Key {
            case ConsoleKey.PageUp {
                scroll.ScrollUp(Math.Max(1, scroll.LastViewportHeight - 1))
                return true
            }
            case ConsoleKey.PageDown {
                scroll.ScrollDown(Math.Max(1, scroll.LastViewportHeight - 1))
                return true
            }
            case ConsoleKey.UpArrow when ctrl {
                scroll.ScrollUp(1)
                return true
            }
            case ConsoleKey.DownArrow when ctrl {
                scroll.ScrollDown(1)
                return true
            }
            default {
                let _ = 0
            }
        }
        if key.Key == ConsoleKey.Spacebar && (key.Modifiers & ConsoleModifiers.Control) != 0 {
            ShowCompletions()
            return true
        }
        // Ctrl+K, or F1, toggles hover; F1 works where the terminal eats Ctrl+K.
        if key.Key == ConsoleKey.F1 || (key.Key == ConsoleKey.K && (key.Modifiers & ConsoleModifiers.Control) != 0) {
            hover = AnalysisBridge.Hover(editor.Text, editor.Line, editor.Col) ?? "No symbol information."
            return true
        }
        if (key.KeyChar == '/' || key.KeyChar == ':') && editor.IsEmpty {
            navigator?.ShowModal(CommandPalette(Palette.Verbs, RunCommand))
            return true
        }
        switch key.Key {
            case ConsoleKey.Enter when(key.Modifiers & ConsoleModifiers.Shift) != 0 {
                editor.NewLine()
                return true
            }
            case ConsoleKey.Enter {
                if pendingEval != nil {
                    return true
                }
                if EmittedSessionEngine.IsComplete(editor.Text) && !editor.IsEmpty {
                    evalCts = CancellationTokenSource()
                    pendingEval = engine.EvaluateAsync(editor.Text, evalCts!!.Token)
                    editor.Clear()
                    hover = nil
                    scroll.ToBottom()
                } else if !editor.IsEmpty {
                    editor.NewLine()
                }
                return true
            }
            case ConsoleKey.Backspace {
                editor.Backspace()
                completions = List[CompletionItem]()
                return true
            }
            case ConsoleKey.LeftArrow {
                editor.Left()
                return true
            }
            case ConsoleKey.RightArrow {
                editor.Right()
                return true
            }
            case ConsoleKey.UpArrow {
                editor.Up()
                return true
            }
            case ConsoleKey.DownArrow {
                editor.Down()
                return true
            }
            default {
                if key.KeyChar >= ' ' && !char.IsControl(key.KeyChar) {
                    editor.Insert(key.KeyChar)
                    if completions.Count > 0 {
                        ShowCompletions()
                    }
                    return true
                }
                return false
            }
        }
    }

    private func PumpPendingEvaluation() {
        if pendingEval == nil {
            return
        }
        if !pendingEval!!.IsCompleted {
            evalFrame++
            return
        }
        if pendingEval!!.IsFaulted {
            // Observe the exception so it isn't reported as unobserved later; EvaluateCore
            // already funnels evaluation errors into the Cell's diagnostics, so a faulted
            // task here only happens for cancellation/engine bugs, not G# runtime errors.
            let _ = pendingEval!!.Exception
        }
        // A running submission can't be interrupted mid-run (see ISessionEngine.EvaluateAsync), so a
        // cancelled submission finishes normally and is just discarded with no result cell. Tell
        // the user it actually happened instead of leaving them wondering why nothing appeared.
        // (If Esc lost the race and the eval committed anyway, IsCompletedSuccessfully is true
        // and no toast is shown — there's a real result on screen instead.)
        if cancelRequested && !pendingEval!!.IsCompletedSuccessfully {
            navigator?.ShowToast("Evaluation cancelled.")
        }
        pendingEval = nil
        evalCts?.Dispose()
        evalCts = nil
        evalFrame = 0
        cancelRequested = false
    }

    func Render(width int32, height int32) IRenderable {
        PumpPendingEvaluation()
        let brand = Tokens.Brand.Value.ToMarkup()
        let primary = Tokens.TextPrimary.Value.ToMarkup()
        let secondary = Tokens.TextSecondary.Value.ToMarkup()
        let tertiary = Tokens.TextTertiary.Value.ToMarkup()
        // Reserve a right-hand column for the state sidebar on wide enough terminals.
        let sidebarWidth = if width >= 76 {
            Math.Clamp(width / 4, 26, 42)
        } else {
            0
        }
        let leftWidth = if sidebarWidth > 0 {
            width - sidebarWidth - 2
        } else {
            width - 1
        }
        let cellBg = Tokens.CellBackground.Value
        let transcript = List[IRenderable]()
        // The full history is handed to the Dock, which windows it into the scrollable
        // region; older cells scroll off the top rather than being dropped up front.
        for var ci = 0; ci < engine.Cells.Count; ci++ {
            let cell = engine.Cells[ci]
            let cellRows = List[IRenderable]{
                Markup("[$tertiary]${cell.Index}[/] [$brand]›[/] ${Highlight.Markup(cell.Input.Replace("\n", " "))}")
            }
            for d in cell.Diagnostics {
                let c = (
                    if d.IsError {
                        Tokens.StatusError
                    } else {
                        Tokens.StatusWarning
                    }
                )
                    .Value
                    .ToMarkup()
                cellRows.Add(Markup("    [$c]● ${Markup.Escape(d.Id)} ${Markup.Escape(d.Message)}[/]"))
            }
            for line in SplitOutput(cell.Output) {
                cellRows.Add(Markup("    [$secondary]${Markup.Escape(line)}[/]"))
            }
            for line in SplitOutput(cell.StandardError) {
                let c = Tokens.StatusError.Value.ToMarkup()
                cellRows.Add(Markup("    [$c]${Markup.Escape(line)}[/]"))
            }
            if !cell.HasError && cell.Value != nil {
                // ADR-0157: display-side pretty echo — never emitted semantics.
                cellRows.Add(Markup("    [$primary]${Markup.Escape(ReplValueFormatter.Format(cell.Value))}[/]"))
            }
            transcript.Add(Backdrop(Rows(cellRows), cellBg))
            if ci < engine.Cells.Count - 1 {
                transcript.Add(Text(string.Empty))
            }
        }
        let canvasColor = Tokens.Canvas
        let scrollable = Backdrop(Rows(transcript), canvasColor, padLeft: 1, padRight: 1)
        // Everything below the scrollable transcript stays pinned to the bottom, just above
        // the footer chrome, and grows upward as the input box gains lines. The Dock measures
        // this footer at render time and shrinks the transcript viewport to match.
        let footerRows = List[IRenderable]()
        if completions.Count > 0 {
            footerRows.Add(CompletionPanel())
        }
        if hover != nil {
            footerRows.Add(
                Panel(Markup("[$secondary]${Markup.Escape(hover!!)}[/]")){
                    Header = PanelHeader("[$tertiary] hover · Esc [/]"),
                    Border = BoxBorder.Rounded,
                    BorderStyle = Style(Tokens.BorderNeutral),
                    Expand = true
                }
            )
        }
        footerRows.Add(Backdrop(InputBox(brand, tertiary), canvasColor, padLeft: 1, padRight: 1))
        // Any blank fill (an empty transcript, the row under the input box, the sidebar
        // gap) is painted with the theme's canvas color instead of being left unstyled,
        // which would otherwise show through as the terminal's own (often black) background.
        let canvas = Style(background: canvasColor)
        let main = cast[IRenderable](Dock(scrollable, Rows(footerRows), height, scroll, canvas))
        if sidebarWidth == 0 {
            return main
        }
        return SideBySide(main, leftWidth, 2, FixedHeight(StateSidebar(height), height, canvas), sidebarWidth, canvas)
    }

    private func InputBox(brand string, tertiary string) IRenderable {
        let cursor = "${Tokens.TextPrimary.Value.ToMarkup()} invert"
        var rendered List[IRenderable]
        if editor.IsEmpty {
            rendered = List[IRenderable]{
                Markup(
                    "[$brand]›[/] [$cursor] [/] [$tertiary]Type a G# expression — Enter to run · Shift+Enter for newline[/]"
                )
            }
        } else {
            let lines = editor.RenderLines(cursor)
            rendered = lines.Select(
                (l string, i int32) -> cast[IRenderable](
                    Markup("[${(if i == 0 { brand } else { tertiary })}]${(if i == 0 { "›" } else { "·" })}[/] $l")
                )
            )
                .ToList()
        }
        // OpenCode/Copilot-CLI style: a filled input surface with a themed accent bar
        // down the left edge (the colour previously used for the wrap-around border).
        return Backdrop(
            Rows(rendered),
            Tokens.InputBackground.Value,
            accent: Tokens.Brand.Value,
            padLeft: 1,
            padRight: 1,
            padTop: 1,
            padBottom: 1
        )
    }

    private func StateSidebar(minHeight int32) IRenderable {
        let brand = Tokens.Brand.Value.ToMarkup()
        let primary = Tokens.TextPrimary.Value.ToMarkup()
        let secondary = Tokens.TextSecondary.Value.ToMarkup()
        let tertiary = Tokens.TextTertiary.Value.ToMarkup()
        let state = engine.Snapshot()
        let rows = List[IRenderable]{
            Markup("[$brand]STATE[/]"),
            Markup("[$tertiary]cells[/] [$primary]${engine.Cells.Count}[/]")
        }
        AddSection(rows, "imports", state.Imports, brand, secondary, tertiary)
        AddSection(rows, "functions", state.Functions, brand, primary, tertiary)
        AddSection(rows, "variables", state.Variables, brand, primary, tertiary)
        AddSection(rows, "types", state.Types, brand, primary, tertiary)
        if state.IsEmpty {
            rows.Add(Text(string.Empty))
            rows.Add(Markup("[$tertiary]No symbols defined yet.[/]"))
        }
        // Pin a footer line (version + theme) to the very bottom of the sidebar by
        // padding with blank rows up to the fixed height, then appending it last.
        let footer = Markup(
            "[$tertiary]gsharp[/] [$primary]${Markup.Escape(ReplHost.GetVersion())}[/] [$tertiary]| theme[/] [$primary]${Markup.Escape(Theme.Current.Name)}[/]"
        )
        let filler = minHeight - 2 - rows.Count - 1
        for var i = 0; i < filler; i++ {
            rows.Add(Text(string.Empty))
        }
        rows.Add(footer)
        // Same treatment as the input box: a filled surface with a themed left accent
        // bar, rather than an enclosed box.
        return Backdrop(
            Rows(rows),
            Tokens.InputBackground.Value,
            accent: Tokens.Brand.Value,
            padLeft: 1,
            padRight: 1,
            padTop: 1,
            padBottom: 1,
            minHeight: minHeight
        )
    }

    private func CompletionPanel() IRenderable {
        let brand = Tokens.Brand.Value.ToMarkup()
        let primary = Tokens.TextPrimary.Value.ToMarkup()
        let tertiary = Tokens.TextTertiary.Value.ToMarkup()
        let popup = List[IRenderable]()
        for var i = completionTop; i < Math.Min(completions.Count, completionTop + MaxPopup); i++ {
            let item = completions[i]
            let caret = if i == completionIndex {
                "[$brand]❯[/] "
            } else {
                "  "
            }
            let detail = if string.IsNullOrEmpty(item.Detail) {
                string.Empty
            } else {
                "  [$tertiary]${Markup.Escape(item.Detail)}[/]"
            }
            popup.Add(Markup("$caret[$primary]${Markup.Escape(item.Label)}[/]$detail"))
        }
        let header = "[$tertiary] completions ${completionIndex + 1}/${completions.Count} [/]"
        return Panel(Rows(popup)){
            Header = PanelHeader(header),
            Border = BoxBorder.Rounded,
            BorderStyle = Style(Tokens.BorderNeutral),
            Expand = true
        }
    }

    private func Move(delta int32) {
        let n = completions.Count
        completionIndex = (((completionIndex + delta) % n) + n) % n
        if completionIndex < completionTop {
            completionTop = completionIndex
        } else if completionIndex >= completionTop + MaxPopup {
            completionTop = completionIndex - MaxPopup + 1
        }
    }

    private func ShowCompletions() {
        completions = AnalysisBridge
            .Completions(editor.Text, editor.Line, editor.Col)
            .OrderBy((c CompletionItem) -> c.SortText ?? c.Label, StringComparer.Ordinal)
            .ToList()
        completionIndex = 0
        completionTop = 0
    }

    private func AcceptCompletion() {
        if completionIndex >= 0 && completionIndex < completions.Count {
            let insert = completions[completionIndex].InsertText ?? completions[completionIndex].Label
            for ch in insert {
                editor.Insert(ch)
            }
        }
        completions = List[CompletionItem]()
    }

    private func RunCommand(cmd string) {
        let parts = cmd.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries)
        let verb = if parts.Length > 0 {
            parts[0]
        } else {
            string.Empty
        }
        let arg = if parts.Length > 1 {
            parts[1].Trim()
        } else {
            string.Empty
        }
        switch verb {
            case "reset" {
                engine.Reset()
                editor.Clear()
                navigator?.ShowToast("Session reset.")
            }
            case "clear" {
                editor.Clear()
            }
            case "theme" {
                try {
                    if string.IsNullOrEmpty(arg) {
                        Theme.Cycle()
                    } else {
                        Theme.Use(arg)
                    }
                    navigator?.ShowToast("Theme: ${Theme.Current.Name}")
                } catch (ex ArgumentException) {
                    navigator?.ShowToast(ex.Message)
                }
            }
            case "load" {
                if File.Exists(arg) {
                    engine.Evaluate(File.ReadAllText(arg))
                    navigator?.ShowToast("Loaded $arg")
                } else {
                    navigator?.ShowToast("File not found: $arg")
                }
            }
            case "exit", "quit" {
                navigator?.RequestExit()
            }
            default {
                navigator?.ShowToast("Unknown command: $verb")
            }
        }
    }

    shared {
        private const MaxPopup int32 = 7

        private func AddSection(
            rows List[IRenderable],
            title string,
            items IReadOnlyList[ReplSymbol],
            headColor string,
            nameColor string,
            detailColor string
        ) {
            if items.Count == 0 {
                return
            }
            rows.Add(Text(string.Empty))
            rows.Add(Markup("[$headColor]${title.ToUpperInvariant()}[/] [$detailColor]${items.Count}[/]"))
            for item in items.Take(12) {
                rows.Add(Markup("[$nameColor]${Markup.Escape(item.Display)}[/]"))
            }
            if items.Count > 12 {
                rows.Add(Markup("[$detailColor]… +${items.Count - 12} more[/]"))
            }
        }

        private func SplitOutput(text string) sequence[string] {
            if string.IsNullOrEmpty(text) {
                yield break
            }
            let normalized = text.Replace("\r\n", "\n").Replace('\r', '\n').TrimEnd('\n')
            if normalized.Length == 0 {
                yield break
            }
            for line in normalized.Split('\n') {
                yield line
            }
        }
    }
}

internal shared class Palette {
    let Verbs[](string, string) = [](string, string){
        ("reset", "clear session state"),
        ("clear", "clear the editor"),
        ("theme", "switch theme: ${string.Join("|", Theme.AvailableNames())}"),
        ("load", "run a .gs file into session"),
        ("exit", "quit the REPL")
    }
}
