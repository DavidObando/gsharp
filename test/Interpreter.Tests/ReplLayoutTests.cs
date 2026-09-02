// <copyright file="ReplLayoutTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Threading;
using GSharp.Repl.Engine;
using GSharp.Repl.Screens;
using GSharp.Repl.Themes;
using SharpTui;
using Xunit;

namespace GSharp.Interpreter.Tests;

public sealed class ReplLayoutTests
{
    [Theory]
    [InlineData(120, 32)]
    [InlineData(80, 24)]
    [InlineData(48, 18)]
    public void RetainedTreeRendersAllChromeAtSupportedSizes(int width, int height)
    {
        using var engine = new EmittedSessionEngine();
        var (root, driver) = Create(engine, width, height);

        driver.Draw();
        var frame = driver.FrameText();

        Assert.Contains("gsharp", frame, StringComparison.Ordinal);
        Assert.Contains("1 REPL", frame, StringComparison.Ordinal);
        Assert.Contains(width < 60 ? "6S" : "6 ", frame, StringComparison.Ordinal);
        Assert.Contains("session transcript", frame, StringComparison.Ordinal);
        Assert.Contains("editor [focus]", frame, StringComparison.Ordinal);
        Assert.Contains("focus: editor", frame, StringComparison.Ordinal);
        Assert.DoesNotContain(" cells ", frame, StringComparison.Ordinal);
        Assert.DoesNotContain("idle", frame, StringComparison.Ordinal);
        Assert.Same(root.Editor, driver.FocusedElement);

        if (width == 48)
        {
            Text(driver, ":");
            driver.Draw();
            frame = driver.FrameText();
            Assert.Contains("command palette", frame, StringComparison.Ordinal);
            Assert.Contains("reset", frame, StringComparison.Ordinal);
            Assert.Contains("exit", frame, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void EditorAnalysisSuppliesSemanticRunsAndDiagnosticUnderline()
    {
        const string source = "let = 1";
        var analysis = AnalysisBridge.Analyze(source);
        var lines = new EditorLineSource(source, analysis, ReplTheme.Current);
        var rendered = lines.ItemAt(0);

        Assert.NotEmpty(analysis.Tokens);
        Assert.NotEmpty(analysis.Diagnostics);
        Assert.True(rendered.Runs.Count > 1);
        Assert.Contains(rendered.Runs, run => (run.Style.Attributes & TextAttributes.Underline) != 0);
    }

    [Fact]
    public void EditorAnalysisColorsInterpolatedStringHoleSeparately()
    {
        const string source = "\"Hello ${1}\"";
        var analysis = AnalysisBridge.Analyze(source);
        var rendered = new EditorLineSource(source, analysis, ReplTheme.Current).ItemAt(0);

        Assert.Contains(rendered.Runs, run => run.Text.Contains("Hello", StringComparison.Ordinal)
            && run.Style.Foreground.Equals(ReplTheme.Current.StringLiteral));
        Assert.Contains(rendered.Runs, run => run.Text.Contains("1", StringComparison.Ordinal)
            && run.Style.Foreground.Equals(ReplTheme.Current.Number));
    }

    [Fact]
    public void LiveEditorAnalysisDebouncesAndUsesOnlyInlineUnderline()
    {
        using var engine = new EmittedSessionEngine();
        var (root, driver) = Create(engine, 100, 26);

        Type(driver, "let = 1");
        Assert.Empty(root.Editor.StyleSource.ItemAt(0).Runs);

        Tick(driver);
        Tick(driver);
        Assert.Empty(root.Editor.StyleSource.ItemAt(0).Runs);

        Tick(driver);
        driver.Draw();
        var rendered = root.Editor.StyleSource.ItemAt(0);
        Assert.Contains(rendered.Runs, run => (run.Style.Attributes & TextAttributes.Underline) != 0);
        Assert.DoesNotContain("Unexpected", driver.FrameText(), StringComparison.Ordinal);
    }

    [Fact]
    public void TypeSubmitPumpRendersTranscriptCell()
    {
        using var engine = new EmittedSessionEngine();
        var (root, driver) = Create(engine, 100, 26);

        Type(driver, "1+2");
        Assert.Equal(EventResult.Handled, SendKey(driver, Key.Enter));
        PumpUntilIdle(root, driver);
        driver.Draw();

        var cell = Assert.Single(engine.Cells);
        Assert.Equal(3, cell.Value);
        Assert.Contains("1+2", driver.FrameText(), StringComparison.Ordinal);
        Assert.Contains("= 3", driver.FrameText(), StringComparison.Ordinal);
    }

    [Fact]
    public void TabExpandsCompletionAndPaletteDoesNotStealColon()
    {
        using var engine = new EmittedSessionEngine();
        var (root, driver) = Create(engine, 100, 26);

        root.Editor.Text = "func Greet() string { return \"hi\" }\nGre";
        root.Editor.Caret = new TextPosition { LineIndex = 1, GraphemeIndex = 3 };
        SendKey(driver, Key.Tab);
        Assert.Equal("func Greet() string { return \"hi\" }\nGreet", root.Editor.Text);

        root.Editor.Text = "let value";
        root.Editor.Caret = new TextPosition { LineIndex = 0, GraphemeIndex = 9 };
        Text(driver, ":");
        driver.Draw();
        Assert.Equal("let value:", root.Editor.Text);
        Assert.DoesNotContain("command palette", driver.FrameText(), StringComparison.Ordinal);

        Control(driver, "p");
        driver.Draw();
        Assert.Contains("command palette", driver.FrameText(), StringComparison.Ordinal);
        Type(driver, "show t");
        driver.Draw();
        SendKey(driver, Key.Tab);
        driver.Draw();
        Assert.Contains("show tree", driver.FrameText(), StringComparison.Ordinal);
    }

    [Fact]
    public void TypingWhileCompletionIsOpenContinuesEditingAndRefilters()
    {
        using var engine = new EmittedSessionEngine();
        var (root, driver) = Create(engine, 100, 26);

        Type(driver, "Con");
        Control(driver, " ");
        driver.Draw();
        Assert.Contains("completions", driver.FrameText(), StringComparison.Ordinal);

        Text(driver, "t");
        Assert.Equal("Cont", root.Editor.Text);
        driver.Draw();
        Assert.Contains("continue", driver.FrameText(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void PageUpFromEditorScrollsTranscriptAndKeepsEditorFocus()
    {
        using var engine = new EmittedSessionEngine();
        for (var i = 0; i < 12; i++)
        {
            engine.Evaluate(i.ToString());
        }

        var (root, driver) = Create(engine, 70, 18);
        driver.Draw();
        var before = root.Transcript.FirstVisibleRowOffset;

        SendKey(driver, Key.PageUp);
        driver.Draw();

        Assert.True(root.Transcript.FirstVisibleRowOffset < before);
        Assert.Same(root.Editor, driver.FocusedElement);
        var afterPageUp = root.Transcript.FirstVisibleRowOffset;

        SendKey(driver, Key.PageDown);
        driver.Draw();
        Assert.True(root.Transcript.FirstVisibleRowOffset > afterPageUp);
        Assert.True(root.Transcript.FollowTail);
        Assert.Contains("[12]", driver.FrameText(), StringComparison.Ordinal);
    }

    [Fact]
    public void ProgressiveControlCClearsThenExits()
    {
        using var engine = new EmittedSessionEngine();
        var (root, driver) = Create(engine, 80, 24);

        Type(driver, "discard me");
        Assert.Equal(EventResult.Handled, Control(driver, "c"));
        Assert.Equal(string.Empty, root.Editor.Text);
        Assert.Equal(EventResult.Handled, Control(driver, "c"));
        Assert.Equal(EventResult.Exit, Control(driver, "c"));
    }

    [Fact]
    public void BusyEvaluationRendersAnimatedScannerAndInterruptHint()
    {
        using var engine = new EmittedSessionEngine();
        var (root, driver) = Create(engine, 80, 24);
        root.Editor.Text = "import System.Threading\nThread.Sleep(750)\n1";

        SendKey(driver, Key.Enter);
        Assert.True(root.IsBusy);
        driver.Draw();
        var first = driver.FrameText();

        Assert.Contains("■", first, StringComparison.Ordinal);
        Assert.Contains("⬝", first, StringComparison.Ordinal);
        Assert.Contains("Esc interrupt", first, StringComparison.Ordinal);

        Tick(driver);
        driver.Draw();
        var second = driver.FrameText();

        Assert.NotEqual(first, second);
        PumpUntilIdle(root, driver);
    }

    [Fact]
    public void EmptyEditorTabPreservesKeyboardFocusTraversal()
    {
        using var engine = new EmittedSessionEngine();
        var (root, driver) = Create(engine, 80, 24);

        SendKey(driver, Key.Tab);
        Assert.NotSame(root.Editor, driver.FocusedElement);
        driver.Draw();
        Assert.Contains("focus:", driver.FrameText(), StringComparison.Ordinal);
        Assert.DoesNotContain("editor [focus]", driver.FrameText(), StringComparison.Ordinal);
        SendKey(driver, Key.BackTab);
        Assert.Same(root.Editor, driver.FocusedElement);
        driver.Draw();
        Assert.Contains("editor [focus]", driver.FrameText(), StringComparison.Ordinal);
    }

    [Fact]
    public void ChangingFocusedTabKeepsTabFocusUntilPanelTraversal()
    {
        using var engine = new EmittedSessionEngine();
        var (root, driver) = Create(engine, 80, 24);

        SendKey(driver, Key.Tab);
        Assert.Same(root.TabStrip, driver.FocusedElement);
        driver.Draw();
        Assert.Contains("[1 REPL]", driver.FrameText(), StringComparison.Ordinal);

        SendKey(driver, Key.Right);
        Assert.Equal(1, root.ActiveTab);
        Assert.Same(root.TabStrip, driver.FocusedElement);
        driver.Draw();
        Assert.Contains("[2 Hist]", driver.FrameText(), StringComparison.Ordinal);
        Assert.DoesNotContain("[1 REPL]", driver.FrameText(), StringComparison.Ordinal);

        SendKey(driver, Key.Right);
        Assert.Equal(2, root.ActiveTab);
        Assert.Same(root.TabStrip, driver.FocusedElement);

        driver.Draw();
        Assert.Contains("[3 Vars]", driver.FrameText(), StringComparison.Ordinal);
        Assert.Contains("live variables", driver.FrameText(), StringComparison.Ordinal);
        Assert.Contains("focus: tabs", driver.FrameText(), StringComparison.Ordinal);
        Assert.DoesNotContain("live variables [focus]", driver.FrameText(), StringComparison.Ordinal);

        SendKey(driver, Key.Tab);
        Assert.IsType<TableView>(driver.FocusedElement);

        driver.Draw();
        Assert.DoesNotContain("[3 Vars]", driver.FrameText(), StringComparison.Ordinal);
        Assert.Contains("live variables [focus]", driver.FrameText(), StringComparison.Ordinal);
        Assert.Contains("focus: variables", driver.FrameText(), StringComparison.Ordinal);
    }

    [Fact]
    public void HoverShortcutExplainsItsEditorCaretRequirement()
    {
        using var engine = new EmittedSessionEngine();
        var (root, driver) = Create(engine, 100, 26);

        Control(driver, "k");
        driver.Draw();

        var frame = driver.FrameText();
        Assert.Contains("hover help", frame, StringComparison.Ordinal);
        Assert.Contains("place the caret on a symbol", frame, StringComparison.Ordinal);
        Assert.Contains("focus: hover", frame, StringComparison.Ordinal);

        SendKey(driver, Key.Escape);
        root.Editor.Text = "func Greet() string { return \"hi\" }";
        root.Editor.Caret = new TextPosition { LineIndex = 0, GraphemeIndex = 5 };
        Control(driver, "k");
        driver.Draw();

        frame = driver.FrameText();
        Assert.Contains("hover at editor caret", frame, StringComparison.Ordinal);
        Assert.Contains("Greet", frame, StringComparison.Ordinal);
    }

    [Fact]
    public void StandardInputRequestUsesModalAndCompletesCell()
    {
        using var engine = new EmittedSessionEngine();
        var (root, driver) = Create(engine, 100, 30);

        Type(driver, "Console.ReadLine()");
        SendKey(driver, Key.Enter);
        var deadline = DateTime.UtcNow.AddSeconds(5);
        var frame = string.Empty;
        while (!frame.Contains("standard input", StringComparison.Ordinal) && DateTime.UtcNow < deadline)
        {
            Thread.Sleep(5);
            driver.Pump();
            driver.Draw();
            frame = driver.FrameText();
        }

        Assert.Contains("standard input", frame, StringComparison.Ordinal);
        Type(driver, "hello");
        SendKey(driver, Key.Enter);
        PumpUntilIdle(root, driver);
        Assert.Equal("hello", Assert.Single(engine.Cells).Value);
    }

    [Fact]
    public void TreeAndIlCaptureUseEmittedCellArtifacts()
    {
        using var engine = new EmittedSessionEngine
        {
            CaptureSyntaxTree = true,
            CaptureIntermediateLanguage = true,
        };

        var cell = engine.Evaluate("1+2");

        Assert.Contains("CompilationUnit", cell.SyntaxTree, StringComparison.Ordinal);
        Assert.Contains("method", cell.IntermediateLanguage, StringComparison.Ordinal);
        Assert.Contains("IL_", cell.IntermediateLanguage, StringComparison.Ordinal);
    }

    private static (ReplApp Root, TestDriver Driver) Create(EmittedSessionEngine engine, int width, int height)
    {
        var root = new ReplApp(engine);
        var driver = new TestDriver(root, width, height);
        root.Configure(driver.App);
        return (root, driver);
    }

    private static void PumpUntilIdle(ReplApp root, TestDriver driver)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (root.IsBusy && DateTime.UtcNow < deadline)
        {
            Thread.Sleep(5);
            driver.Pump();
        }

        Assert.False(root.IsBusy);
    }

    private static void Type(TestDriver driver, string text)
    {
        foreach (var value in text)
        {
            Text(driver, value.ToString());
        }
    }

    private static EventResult Text(TestDriver driver, string text)
        => driver.Send(new UiEvent
        {
            Kind = UiEventKind.TextInput,
            Key = Key.Character,
            Phase = KeyPhase.Press,
            Text = text,
        });

    private static EventResult SendKey(TestDriver driver, Key key)
        => driver.Send(new UiEvent
        {
            Kind = UiEventKind.Key,
            Key = key,
            Phase = KeyPhase.Press,
        });

    private static EventResult Control(TestDriver driver, string text)
        => driver.Send(new UiEvent
        {
            Kind = UiEventKind.Key,
            Key = Key.Character,
            Phase = KeyPhase.Press,
            Modifiers = KeyModifiers.Ctrl,
            Text = text,
        });

    private static EventResult Tick(TestDriver driver)
        => driver.Send(new UiEvent
        {
            Kind = UiEventKind.Tick,
            Phase = KeyPhase.Press,
        });
}
