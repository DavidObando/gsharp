// <copyright file="SharpTuiReplTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.LanguageServer.Protocol
import GSharp.Repl
import GSharp.Repl.Engine
import GSharp.Repl.Screens
import GSharp.Repl.Shell
import GSharp.Repl.Themes
import GSharp.Repl.Widgets
import SharpTui
import Spectre.Console
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Text
import System.Threading
import TuiColor = SharpTui.Color
import Xunit

open class SharpTuiReplTests {
    @Theory
    @InlineData(nil, true, ReplUiKind.SharpTui)
    @InlineData("", true, ReplUiKind.SharpTui)
    @InlineData("sharptui", true, ReplUiKind.SharpTui)
    @InlineData("SharpTUI", true, ReplUiKind.SharpTui)
    @InlineData("spectre", true, ReplUiKind.Spectre)
    @InlineData("SPECTRE", true, ReplUiKind.Spectre)
    @InlineData("curses", false, ReplUiKind.SharpTui)
    func TryParseUiChoice_ResolvesDefaultAndExplicitModes(choice string?, expectedValid bool, expectedKind ReplUiKind) {
        let valid = Program.TryParseUiChoice(choice, out var resolved)
        Assert.Equal(expectedValid, valid)
        if expectedValid {
            Assert.Equal(expectedKind, resolved)
        } else {
            let message = Program.UnknownUiMessage(choice)
            Assert.Contains("sharptui", message, StringComparison.Ordinal)
            Assert.Contains("spectre", message, StringComparison.Ordinal)
        }
    }

    @Theory
    @InlineData(int32(120), int32(32))
    @InlineData(int32(80), int32(24))
    @InlineData(int32(48), int32(18))
    func RetainedTreeRendersAllChromeAtSupportedSizes(width int32, height int32) {
        using let engine = EmittedSessionEngine()
        let (root, driver) = Create(engine, width, height)

        driver.Draw()
        let frame = driver.FrameText()

        Assert.Contains("gsharp", frame, StringComparison.Ordinal)
        Assert.Contains("1 REPL", frame, StringComparison.Ordinal)
        Assert.Contains(
            if width < 60 {
                "6S"
            } else {
                "6 "
            },
            frame,
            StringComparison.Ordinal
        )
        Assert.Contains("session transcript", frame, StringComparison.Ordinal)
        Assert.Contains("editor [focus]", frame, StringComparison.Ordinal)
        Assert.Contains("focus: editor", frame, StringComparison.Ordinal)
        Assert.Same(root.Editor, driver.FocusedElement)

        if width == 48 {
            Text(driver, ":")
            driver.Draw()
            let paletteFrame = driver.FrameText()
            Assert.Contains("command palette", paletteFrame, StringComparison.Ordinal)
            Assert.Contains("reset", paletteFrame, StringComparison.Ordinal)
            Assert.Contains("ui", paletteFrame, StringComparison.Ordinal)
            Assert.Contains("exit", paletteFrame, StringComparison.Ordinal)
        }
    }

    @Fact
    func EditorAnalysisSuppliesSemanticRunsAndDiagnosticUnderline() {
        let source = "let = 1"
        let analysis = AnalysisBridge.Analyze(source)
        let lines = EditorLineSource(source, analysis, ReplTheme.Current)
        let rendered = lines.ItemAt(0)

        Assert.NotEmpty(analysis.Tokens)
        Assert.NotEmpty(analysis.Diagnostics)
        Assert.True(rendered.Runs.Count > 1)
        Assert.Contains(
            rendered.Runs,
            (run TextRun) -> (int32(run.Style.Attributes) & int32(TextAttributes.Underline)) != 0
        )
    }

    @Fact
    func LiveEditorAnalysisDebouncesAndUsesOnlyInlineUnderline() {
        using let engine = EmittedSessionEngine()
        let (root, driver) = Create(engine, 100, 26)

        Type(driver, "let = 1")
        Assert.Empty(root.Editor.StyleSource!!.ItemAt(0).Runs)

        Tick(driver)
        Tick(driver)
        Assert.Empty(root.Editor.StyleSource!!.ItemAt(0).Runs)

        Tick(driver)
        driver.Draw()
        let rendered = root.Editor.StyleSource!!.ItemAt(0)
        Assert.Contains(
            rendered.Runs,
            (run TextRun) -> (int32(run.Style.Attributes) & int32(TextAttributes.Underline)) != 0
        )
        Assert.DoesNotContain("Unexpected", driver.FrameText(), StringComparison.Ordinal)
    }

    @Fact
    func SessionSymbolsDriveCompletionHoverAndStructuredRows() {
        using let engine = EmittedSessionEngine()
        let _ = engine.Evaluate(
            "import System.Text\nfunc Greet() string { return \"hi\" }\nlet answer = 123\nlet empty string? = nil\nlet sb = StringBuilder()\nstruct Thing {}\nclass Widget {}"
        )
        let state = engine.Snapshot()

        Assert.Contains(state.Imports, (symbol ReplSymbol) -> symbol.Name == "System.Text" && symbol.Kind == "import")
        Assert.Contains(state.Functions, (symbol ReplSymbol) -> symbol.Name == "Greet" && symbol.Kind == "func")
        Assert.Contains(state.Variables, (symbol ReplSymbol) -> symbol.Name == "answer" && symbol.Value == "123")
        Assert.Contains(state.Variables, (symbol ReplSymbol) -> symbol.Name == "empty" && symbol.Value == "nil")
        Assert.Contains(state.Types, (symbol ReplSymbol) -> symbol.Name == "Thing" && symbol.Kind == "struct")
        Assert.Contains(state.Types, (symbol ReplSymbol) -> symbol.Name == "Widget" && symbol.Kind == "class")
        Assert.Contains(AnalysisBridge.Completions("ans", 0, 3, state), (item CompletionItem) -> item.Label == "answer")
        Assert.Contains("answer", AnalysisBridge.Hover("answer", 0, 3, state) ?? string.Empty, StringComparison.Ordinal)
        Assert.Contains(engine.Completions("sb.", 0, 3), (item CompletionItem) -> item.Label == "Length")
        Assert.Contains("Length", engine.Hover("sb.Length", 0, 5) ?? string.Empty, StringComparison.Ordinal)
        Assert.Empty(engine.AnalyzeEditor("answer + 1").Diagnostics)
        Assert.NotEmpty(engine.AnalyzeEditor("missingName + 1").Diagnostics)

        let (root, driver) = Create(engine, 120, 32)
        let _ = Control(driver, "3")
        Assert.Equal(2, root.ActiveTab)
        driver.Draw()
        let frame = driver.FrameText()
        Assert.Contains("session symbols", frame, StringComparison.Ordinal)
        Assert.Contains("Greet", frame, StringComparison.Ordinal)
        Assert.Contains("answer", frame, StringComparison.Ordinal)
        Assert.Contains("Thing", frame, StringComparison.Ordinal)
    }

    @Fact
    func TypeSubmitPumpRendersTranscriptCell() {
        using let engine = EmittedSessionEngine()
        let (root, driver) = Create(engine, 100, 26)

        Type(driver, "1+2")
        Assert.Equal(EventResult.Handled, SendKey(driver, Key.Enter))
        PumpUntilIdle(root, driver)
        driver.Draw()

        let cell = Assert.Single(engine.Cells)
        Assert.Equal(3, cell.Value)
        Assert.Contains("1+2", driver.FrameText(), StringComparison.Ordinal)
        Assert.Contains("= 3", driver.FrameText(), StringComparison.Ordinal)
    }

    @Fact
    func SharpTuiCommandSwitchesToSpectreAndPreservesSession() {
        using let engine = EmittedSessionEngine()
        let _ = engine.Evaluate("let persisted = 42")
        let (root, driver) = Create(engine, 100, 26)

        Assert.Null(root.RequestedUi)
        let _ = Control(driver, "p")
        Type(driver, "ui spectre")
        driver.Draw()
        let result = SendKey(driver, Key.Enter)

        Assert.Equal(EventResult.Exit, result)
        Assert.Equal(ReplUiKind.Spectre, root.RequestedUi)

        // Launch Spectre UI on the same engine and verify the cell and symbol survive,
        // then request switching back to SharpTUI.
        using let spectreScreen = ReplScreen(engine)
        let console = AnsiConsole.Create(AnsiConsoleSettings{Out: AnsiConsoleOutput(StringWriter())})
        let shell = AppShell(console, List[ITabScreen]{spectreScreen})
        spectreScreen.OnActivated(shell)
        Assert.NotNull(spectreScreen.Render(100, 24))
        Assert.Single(engine.Cells)
        Assert.Contains(engine.Snapshot().Variables, (v ReplSymbol) -> v.Name == "persisted")

        // Open Spectre command palette with ':' and enter 'ui sharptui'.
        let _ = shell.Dispatch(ConsoleKeyInfo(':', ConsoleKey.NoName, false, false, false))
        for ch in "ui sharptui" {
            let _ = shell.Dispatch(ConsoleKeyInfo(ch, ConsoleKey.NoName, false, false, false))
        }
        let _ = shell.Dispatch(ConsoleKeyInfo('\r', ConsoleKey.Enter, false, false, false))

        Assert.Equal(ReplUiKind.SharpTui, shell.RequestedUi)
        Assert.Single(engine.Cells)
    }

    @Fact
    func SharpTuiSettingsTabSwitchesToSpectre() {
        using let engine = EmittedSessionEngine()
        let (root, driver) = Create(engine, 100, 26)

        let _ = Control(driver, "6")
        Assert.Equal(5, root.ActiveTab)
        driver.Draw()
        Assert.Contains("UI mode", driver.FrameText(), StringComparison.Ordinal)

        // Move selection to index 4 (UI mode) and press Enter.
        for var i = 0; i < 4; i++ {
            let _ = SendKey(driver, Key.Down)
        }
        let result = SendKey(driver, Key.Enter)
        Assert.Equal(EventResult.Exit, result)
        Assert.Equal(ReplUiKind.Spectre, root.RequestedUi)
    }

    @Fact
    func SharpTuiRefusesUiSwitchWhileEvaluationIsBusy() {
        using let engine = EmittedSessionEngine()
        let (root, driver) = Create(engine, 100, 26)
        root.Editor.Text = "import System.Threading\nThread.Sleep(500)\n1"
        let _ = SendKey(driver, Key.Enter)
        Assert.True(root.IsBusy)

        let _ = Control(driver, "p")
        Type(driver, "ui spectre")
        driver.Draw()
        let result = SendKey(driver, Key.Enter)

        Assert.NotEqual(EventResult.Exit, result)
        Assert.Null(root.RequestedUi)
        driver.Draw()
        Assert.Contains("cancel the running evaluation", driver.FrameText(), StringComparison.Ordinal)
        PumpUntilIdle(root, driver)
    }

    @Fact
    func TreeAndIlCaptureUseEmittedCellArtifacts() {
        using let engine = EmittedSessionEngine(){CaptureSyntaxTree = true, CaptureIntermediateLanguage = true}

        let cell = engine.Evaluate("1+2")

        Assert.Contains("CompilationUnit", cell.SyntaxTree, StringComparison.Ordinal)
        Assert.Contains("method", cell.IntermediateLanguage, StringComparison.Ordinal)
        Assert.Contains("IL_", cell.IntermediateLanguage, StringComparison.Ordinal)
    }

    @Fact
    func SharpTuiLoadPreservesByteLiteralSourceEncoding() {
        let path = Path.Combine(Environment.CurrentDirectory, "sharptui-load-" + Guid.NewGuid().ToString("N") + ".gs")
        let prefix = Encoding.UTF8.GetBytes("b\"")
        let payload = []uint8{0xFF}
        let suffix = Encoding.UTF8.GetBytes("\".Length")
        File.WriteAllBytes(path, prefix.Concat(payload).Concat(suffix).ToArray())
        try {
            using let engine = EmittedSessionEngine()
            let (root, driver) = Create(engine, 120, 30)
            let _ = Control(driver, "p")
            Type(driver, "load " + path)
            driver.Draw()
            let _ = SendKey(driver, Key.Enter)
            PumpUntilIdle(root, driver)

            let cell = Assert.Single(engine.Cells)
            Assert.True(cell.HasError)
            let diagnostic = Assert.Single(cell.Diagnostics)
            Assert.Equal("GS0628", diagnostic.Id)
            Assert.Equal(path, diagnostic.Location.FileName)
        } finally {
            File.Delete(path)
        }
    }

    @Fact
    func SharpTuiKnightRiderMatchesSpectreAnimationPerFrame() {
        ReplTheme.Use("default")
        let palette = ReplTheme.Current
        let accent = Spectre.Console.Color(
            uint8((palette.AccentRgb >> 16) & 0xFF),
            uint8((palette.AccentRgb >> 8) & 0xFF),
            uint8(palette.AccentRgb & 0xFF)
        )
        let surface = Spectre.Console.Color(
            uint8((palette.SurfaceRgb >> 16) & 0xFF),
            uint8((palette.SurfaceRgb >> 8) & 0xFF),
            uint8(palette.SurfaceRgb & 0xFF)
        )
        let spectre = KnightRiderAnimation(
            width: 6,
            style: KnightRiderStyle.Blocks,
            holdStart: 6,
            holdEnd: 3,
            colors: KnightRiderAnimation.DeriveTrailColors(accent),
            defaultColor: KnightRiderAnimation.DeriveInactiveColor(accent, factor: 0.6),
            minAlpha: 0.3
        )
        Assert.Equal(20, spectre.TotalFrames)
        for var frame = 0; frame < spectre.TotalFrames; frame++ {
            let runs = ReplApp.BuildBusyScannerRuns(frame, palette, false)
            Assert.Equal(6, runs.Count)
            let sb = StringBuilder()
            for run in runs {
                let packed = cast[int32](packedField.GetValue(run.Style.Foreground)!!)
                let c = Spectre.Console.Color(
                    uint8((packed >> 16) & 0xFF),
                    uint8((packed >> 8) & 0xFF),
                    uint8(packed & 0xFF)
                )
                sb.Append('[').Append(c.ToMarkup()).Append(']').Append(run.Text).Append("[/]")
            }
            Assert.Equal(spectre.RenderMarkup(frame, surface), sb.ToString())
        }

        // Mono + ASCII fallback uses TerminalDefault and ASCII glyphs.
        ReplTheme.Use("mono")
        let monoRuns = ReplApp.BuildBusyScannerRuns(0, ReplTheme.Current, true)
        Assert.Equal("#", monoRuns[0].Text)
        Assert.Equal(".", monoRuns[1].Text)
        for run in monoRuns {
            Assert.Equal(TuiColor.TerminalDefault, run.Style.Foreground)
        }
        ReplTheme.Reset()
    }

    @Fact
    func MemberAndInitializerCompletionsDoNotAppendGlobalSessionSymbols() {
        using let engine = EmittedSessionEngine()
        let _ = engine.Evaluate(
            "import System.Text\nlet answer = 123\nlet sb = StringBuilder()\nclass Thing { prop Count int32\ninit() { } }"
        )

        let memberItems = engine.Completions("sb.", 0, 3)
        Assert.Contains(memberItems, (item CompletionItem) -> item.Label == "Length")
        Assert.DoesNotContain(memberItems, (item CompletionItem) -> item.Label == "answer")
        Assert.DoesNotContain(memberItems, (item CompletionItem) -> item.Label == "Thing")

        let initItems = engine.Completions("let t = Thing() {  }", 0, 18)
        Assert.Contains(initItems, (item CompletionItem) -> item.Label == "Count")
        Assert.DoesNotContain(initItems, (item CompletionItem) -> item.Label == "answer")

        let unqualified = engine.Completions("ans", 0, 3)
        Assert.Contains(unqualified, (item CompletionItem) -> item.Label == "answer")
    }

    @Fact
    func LiveEditorSemanticTokensHighlightPriorSessionSymbols() {
        ReplTheme.Reset()
        using let engine = EmittedSessionEngine()
        let _ = engine.Evaluate("let answer = 123")

        let analysis = engine.AnalyzeEditor("answer + 1")
        Assert.Empty(analysis.Diagnostics)
        Assert.Contains(
            analysis.Tokens,
            (token EditorToken) -> token.Line == 0 && token.StartCharacter == 0 && token.Length == 6
        )

        let line = EditorLineSource("answer + 1", analysis, ReplTheme.Current).ItemAt(0)
        Assert.Contains(
            line.Runs,
            (run TextRun) -> run.Text == "answer" && run.Style.Foreground.Equals(ReplTheme.Current.VariableColor)
        )
    }

    @Fact
    func StandardInputOverlayStaysModalAgainstOtherOverlaysAndTabSwitches() {
        using let engine = EmittedSessionEngine()
        let (root, driver) = Create(engine, 100, 30)

        Type(driver, "Console.ReadLine()")
        let _ = SendKey(driver, Key.Enter)
        let deadline = DateTime.UtcNow.AddSeconds(5.0)
        var frame = string.Empty
        while !frame.Contains("standard input", StringComparison.Ordinal) && DateTime.UtcNow < deadline {
            Thread.Sleep(5)
            driver.Pump()
            driver.Draw()
            frame = driver.FrameText()
        }
        Assert.Contains("standard input", frame, StringComparison.Ordinal)

        // Attempt to open other overlays and switch tabs while stdin is waiting.
        let _ = Control(driver, "p")
        let _ = Control(driver, "l")
        let _ = SendKey(driver, Key.F1)
        let _ = Control(driver, "2")
        let _ = SendKey(driver, Key.Tab)
        driver.Draw()
        frame = driver.FrameText()
        Assert.Contains("standard input", frame, StringComparison.Ordinal)
        Assert.DoesNotContain("command palette", frame, StringComparison.Ordinal)
        Assert.DoesNotContain("captured output", frame, StringComparison.Ordinal)
        Assert.Equal(0, root.ActiveTab)

        Type(driver, "ok")
        let _ = SendKey(driver, Key.Enter)
        PumpUntilIdle(root, driver)
        Assert.Equal("ok", Assert.Single(engine.Cells).Value)
    }

    @Fact
    func PaletteTabBeforeLayoutCompletesFilteredCommandNotReset() {
        using let engine = EmittedSessionEngine()
        let (root, driver) = Create(engine, 100, 26)
        let _ = engine.Evaluate("let keep = 7")

        let _ = Control(driver, "p")
        Type(driver, "ui")
        // Deliberately press Tab before driver.Draw() triggers PrepareLayout().
        let _ = SendKey(driver, Key.Tab)
        let result = SendKey(driver, Key.Enter)

        Assert.Equal(EventResult.Exit, result)
        Assert.Equal(ReplUiKind.Spectre, root.RequestedUi)
        Assert.Single(engine.Cells)
    }

    @Fact
    func ConcurrentAnalysisDuringEvaluationKeepsCacheConsistent() {
        using let engine = EmittedSessionEngine()
        using let cts = CancellationTokenSource()
        let reader = System
            .Threading
            .Tasks
            .Task
            .Run(
            () -> {
                while !cts.IsCancellationRequested {
                    let _ = engine.AnalyzeEditor("v3 + 1")
                    let _ = engine.Completions("v", 0, 1)
                    let _ = engine.Hover("v3", 0, 1)
                    let _ = engine.Snapshot()
                }
            }
        )
        try {
            for var i = 0; i < 4; i++ {
                let cell = engine.Evaluate("let v$i = $i")
                Assert.False(cell.HasError)
            }
        } finally {
            cts.Cancel()
            reader.GetAwaiter().GetResult()
        }

        let finalAnalysis = engine.AnalyzeEditor("v3 + 1")
        Assert.Empty(finalAnalysis.Diagnostics)
        Assert.Contains(engine.Completions("v", 0, 1), (item CompletionItem) -> item.Label == "v3")
    }

    @Fact
    func FormatCommandUsesCanonicalFormatter() {
        let formatted = AnalysisBridge.Format("func   F( x  int32 )   int32  { return  x+1 }")
        Assert.Contains("func F(x int32) int32", formatted, StringComparison.Ordinal)
    }

    @Fact
    func AllSharpTuiThemesMeetContrastThresholds() {
        for palette in ReplTheme.Available {
            if palette.Name == "mono" {
                Assert.Equal(TuiColor.TerminalDefault, palette.Text)
                Assert.Equal(TuiColor.TerminalDefault, palette.Canvas)
                Assert.Equal(TextAttributes.Reverse, palette.Selection.Attributes)
                Assert.Equal(TextAttributes.Reverse, palette.TranscriptSelection.Attributes)
                continue
            }
            let minTextContrast = if palette.Name == "high-contrast" {
                7.0
            } else if palette.Name == "colorblind" {
                5.0
            } else {
                4.5
            }
            Assert.True(
                ContrastRatio(palette.SelectionForeground, palette.SelectionBackground) >= 7.0,
                "Theme ${palette.Name} Selection contrast too low"
            )
            let backgrounds = []TuiColor{
                palette.Canvas,
                palette.Surface,
                palette.Raised,
                palette.TranscriptSelectionBackground
            }
            let foregrounds = []TuiColor{
                palette.Text,
                palette.Muted,
                palette.Faint,
                palette.Accent,
                palette.Good,
                palette.Warning,
                palette.Error,
                palette.Keyword,
                palette.StringLiteral,
                palette.Number,
                palette.Comment,
                palette.TypeColor,
                palette.FunctionColor,
                palette.VariableColor
            }
            for bg in backgrounds {
                for fg in foregrounds {
                    let ratio = ContrastRatio(fg, bg)
                    Assert.True(
                        ratio >= minTextContrast,
                        "Theme ${palette.Name} contrast $ratio below $minTextContrast"
                    )
                }
            }
        }
    }

    shared {
        private func Create(engine EmittedSessionEngine, width int32, height int32)(ReplApp, TestDriver) {
            let root = ReplApp(engine)
            let driver = TestDriver(root, width, height)
            root.Configure(driver.App)
            return (root, driver)
        }

        private func Type(driver TestDriver, text string) {
            for ch in text {
                let _ = Text(driver, ch.ToString())
            }
        }

        private func Text(driver TestDriver, text string) EventResult -> driver.Send(
            UiEvent{Kind: UiEventKind.TextInput, Key: Key.Character, Text: text}
        )

        private func SendKey(driver TestDriver, key Key) EventResult -> driver.Send(
            UiEvent{Kind: UiEventKind.Key, Key: key, Phase: KeyPhase.Press}
        )

        private func Control(driver TestDriver, text string) EventResult -> driver.Send(
            UiEvent{
                Kind: UiEventKind.Key,
                Key: Key.Character,
                Text: text,
                Modifiers: KeyModifiers.Ctrl,
                Phase: KeyPhase.Press
            }
        )

        private func Tick(driver TestDriver) {
            let _ = driver.Send(UiEvent{Kind: UiEventKind.Tick})
        }

        private func PumpUntilIdle(root ReplApp, driver TestDriver) {
            let deadline = DateTime.UtcNow.AddSeconds(10.0)
            while root.IsBusy && DateTime.UtcNow < deadline {
                Thread.Sleep(5)
                driver.Pump()
            }
            driver.Pump()
            Assert.False(root.IsBusy)
        }

        private let packedField FieldInfo = typeof(TuiColor).GetField(
            "packed",
            BindingFlags.Instance | BindingFlags.NonPublic
        )!!

        private func ContrastRatio(a TuiColor, b TuiColor) float64 {
            let la = RelativeLuminance(a)
            let lb = RelativeLuminance(b)
            let lighter = Math.Max(la, lb)
            let darker = Math.Min(la, lb)
            return (lighter + 0.05) / (darker + 0.05)
        }

        private func RelativeLuminance(color TuiColor) float64 {
            let packed = cast[int32](packedField.GetValue(color)!!)
            let r = LinearChannel(float64((packed >> 16) & 0xFF) / 255.0)
            let g = LinearChannel(float64((packed >> 8) & 0xFF) / 255.0)
            let b = LinearChannel(float64(packed & 0xFF) / 255.0)
            return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }

        private func LinearChannel(value float64) float64 -> if value <= 0.03928 {
            value / 12.92
        } else {
            Math.Pow((value + 0.055) / 1.055, 2.4)
        }
    }
}
