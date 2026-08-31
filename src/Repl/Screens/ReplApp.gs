package GSharp.Repl.Screens

import SharpTui

import GSharp.LanguageServer.Protocol
import GSharp.Repl.Engine
import GSharp.Repl.Themes

import System
import System.Collections.Generic
import System.IO
import System.Threading

public open class ReplApp : Column {
  private let engine ISessionEngine
  private var application App?
  private let header StatusBar
  private let tabs Tabs
  private let body Box
  private let footer StatusBar
  private let replScreen Column
  private let historyScreen Box
  private let variablesScreen Box
  private let diagnosticsScreen Box
  private let helpScreen Box
  private let settingsScreen Box
  private let transcriptSource TranscriptSource
  private let transcript VirtualListView
  private let transcriptBox Box
  private let editor TextArea
  private let editorBox Box
  private let history ListView
  private let variables TableView
  private let diagnostics TableView
  private let help ListView
  private let settings ListView
  private let overlays List[Overlay]
  private let paletteOverlay Overlay
  private let searchOverlay Overlay
  private let completionOverlay Overlay
  private let hoverOverlay Overlay
  private let logsOverlay Overlay
  private let inputOverlay Overlay
  private let ghost Label
  private var completionItems IReadOnlyList[CompletionItem]
  private var completionPane CompletionPane?
  private var palettePane PalettePane?
  private var diagnosticCells List[int32]
  private var worker Worker?
  private var activeTab int32
  private var analysis EditorAnalysis
  private var pendingAnalysis string?
  private var analysisTicks int32
  private var busyFrame int32
  private var message string
  private var lastInterrupt int64
  private var inputRequest InputRequest?

  public init(engine ISessionEngine) {
    this.engine = engine
    ReplTheme.ConfigureFromEnvironment()
    let palette = ReplTheme.Current
    application = nil
    activeTab = 0
    analysis = EditorAnalysis.Empty
    pendingAnalysis = nil
    analysisTicks = 0
    busyFrame = 0
    message = "press ? for help"
    lastInterrupt = -1
    worker = nil
    inputRequest = nil
    completionItems = List[CompletionItem]()
    completionPane = nil
    palettePane = nil
    diagnosticCells = List[int32]()

    header = StatusBar{ Height: CellLength.Cells(1) }
    tabs = Tabs{ Height: CellLength.Cells(1), Titles: TabTitles(120, false, 0), SelectedIndex: 0 }
    body = Box{ GrowWeight: 1 }
    footer = StatusBar{ Height: CellLength.Cells(1) }

    transcriptSource = TranscriptSource(engine, palette)
    transcript = VirtualListView{ Source: transcriptSource, GrowWeight: 1, FollowTail: true,
      SelectedStyle: palette.Selection }
    transcriptBox = Box{ GrowWeight: 1, ShowBorder: true, ShowScrollbar: true,
      Title: "session transcript", Children: { transcript } }
    editor = TextArea{ GrowWeight: 1, ShowLineNumbers: true, Wrapping: TextWrapping.Word,
      EnterBehavior: TextAreaEnterBehavior.SubmitOnPlainEnter }
    editorBox = Box{ Height: CellLength.Cells(7), ShowBorder: true, Title: "editor",
      Children: { editor } }
    replScreen = Column{ GrowWeight: 1, Children: {
      transcriptBox,
      editorBox,
    } }

    history = ListView{ GrowWeight: 1, SelectionMarker: "", SelectedStyle: palette.Selection }
    historyScreen = Box{ GrowWeight: 1, ShowBorder: true, ShowScrollbar: true, Title: "history", Children: { history } }

    variables = TableView{ GrowWeight: 1, SelectedRowStyle: palette.Selection }
    variables.Columns.Add(TableColumn{ Header: "name", ColumnWidth: ColumnWidth.Cells(24) })
    variables.Columns.Add(TableColumn{ Header: "type", ColumnWidth: ColumnWidth.Cells(28) })
    variables.Columns.Add(TableColumn{ Header: "value", ColumnWidth: ColumnWidth.Share(1) })
    variablesScreen = Box{ GrowWeight: 1, ShowBorder: true, ShowScrollbar: true, Title: "live variables", Children: { variables } }

    diagnostics = TableView{ GrowWeight: 1, SelectedRowStyle: palette.Selection }
    diagnostics.Columns.Add(TableColumn{ Header: "cell", ColumnWidth: ColumnWidth.Cells(6) })
    diagnostics.Columns.Add(TableColumn{ Header: "code", ColumnWidth: ColumnWidth.Cells(10) })
    diagnostics.Columns.Add(TableColumn{ Header: "message", ColumnWidth: ColumnWidth.Share(1) })
    diagnosticsScreen = Box{ GrowWeight: 1, ShowBorder: true, ShowScrollbar: true, Title: "diagnostics", Children: { diagnostics } }

    help = ListView{ GrowWeight: 1, SelectionMarker: "", CanFocus: true }
    helpScreen = Box{ GrowWeight: 1, ShowBorder: true, ShowScrollbar: true, Title: "help", Children: { help } }
    settings = ListView{ GrowWeight: 1, SelectionMarker: "", SelectedStyle: palette.Selection }
    settingsScreen = Box{ GrowWeight: 1, ShowBorder: true, ShowScrollbar: true, Title: "settings", Children: { settings } }

    body.Children.Add(replScreen)
    body.Children.Add(historyScreen)
    body.Children.Add(variablesScreen)
    body.Children.Add(diagnosticsScreen)
    body.Children.Add(helpScreen)
    body.Children.Add(settingsScreen)

    paletteOverlay = MakeOverlay("command palette", 72, 12)
    searchOverlay = MakeOverlay("session search", 72, 14)
    completionOverlay = MakeOverlay("completions", 56, 9)
    hoverOverlay = MakeOverlay("hover", 64, 10)
    logsOverlay = MakeOverlay("captured output", 76, 18)
    inputOverlay = MakeOverlay("standard input", 64, 5)
    overlays = List[Overlay]{ paletteOverlay, searchOverlay, completionOverlay, hoverOverlay, logsOverlay, inputOverlay }
    ghost = Label{ IsVisible: false, Height: CellLength.Cells(1), Placement: Placement.At(CellPoint{}),
      Style: Style{ Foreground: palette.Faint, Background: palette.Surface } }

    Children.Add(header)
    Children.Add(tabs)
    Children.Add(body)
    Children.Add(footer)
    Children.Add(ghost)
    for overlay in overlays { Children.Add(overlay) }

    editor.OnChanged = (text string) -> ScheduleAnalysis(text)
    editor.OnSubmit = (text string) -> Submit(text)
    engine.CaptureConsole = true
    BuildHelp()
    RebuildSessionViews()
    Activate(0)
    ApplyTheme()
    Focus(editor)
  }

  public prop Editor TextArea -> editor

  public prop Transcript VirtualListView -> transcript

  public prop TabStrip Tabs -> tabs

  public prop ActiveTab int32 -> activeTab

  public prop IsBusy bool -> worker != nil

  public func Configure(app App) {
    application = app
    app.QuitGestures.Clear()
    app.TickInterval = TimeSpan.FromMilliseconds(80.0)
    app.DefaultStyle = Style{ Foreground: ReplTheme.Current.Text, Background: ReplTheme.Current.Canvas }
    app.Keys.Add(KeyGesture.Character(":"), BindingPhase.BeforeWidgets, () -> SpecialCharacter(":", () -> OpenPalette()))
    app.Keys.Add(KeyGesture.Character("/"), BindingPhase.BeforeWidgets, () -> SpecialCharacter("/", () -> OpenSearch()))
    app.Keys.Add(KeyGesture.Character("?"), BindingPhase.BeforeWidgets, () -> SpecialCharacter("?", () -> Activate(4)))
    app.Keys.Add(KeyGesture{ Key: Key.Tab }, BindingPhase.BeforeWidgets, () -> CompleteWithTab())
    app.Keys.Add(KeyGesture{ Key: Key.Left }, BindingPhase.BeforeWidgets, () -> TabArrow(Key.Left, -1))
    app.Keys.Add(KeyGesture{ Key: Key.Right }, BindingPhase.BeforeWidgets, () -> TabArrow(Key.Right, 1))
    var i = 0
    while i < 6 {
      let tab = i
      let key = (i + 1).ToString()
      app.Keys.Add(KeyGesture.Character(key), BindingPhase.BeforeWidgets, () -> TabCharacter(key, tab))
      i = i + 1
    }
    engine.InputProvider = () -> ReadInput()
  }

  public func CancelPendingInput() {
    if let pending = inputRequest { pending.Complete(nil) }
    inputRequest = nil
  }

  protected override func Render(screen Screen, bounds CellRect, style Style) {
    let tabChange = tabs.ConsumeSelectionChange()
    if tabChange != nil && tabs.SelectedIndex != activeTab { Activate(tabs.SelectedIndex, false) }
    let desired = TabTitles(bounds.WidthCells, tabs.IsFocused, tabs.SelectedIndex)
    if !SameTitles(tabs.Titles, desired) { tabs.Titles = desired }
    editorBox.Height = CellLength.Cells(bounds.HeightRows < 22 ? 5 : 7)
    let errors = ErrorCount()
    UpdateFocusChrome()
    header.LeftText = " gsharp"
    header.CenterText = ""
    header.RightText = "v" + ReplHost.GetVersion() + " "
    footer.LeftText = " focus: " + FocusName() + " · " + StatusText(errors) + " · " + message
    footer.CenterText = ""
    footer.RightText = FooterHints() + " "
    FitOverlays(bounds)
    PositionCompletion(bounds)
  }

  protected override func Accept(ev UiEvent) EventResult {
    if ev.Phase == KeyPhase.Release { return EventResult.Continue }
    if ev.Kind == UiEventKind.Tick {
      let analyzed = PumpAnalysis()
      if worker != nil { busyFrame = busyFrame + 1 }
      return worker != nil || analyzed ? EventResult.Handled : EventResult.Continue
    }
    if worker != nil && ev.Key == Key.Escape {
      if let running = worker { running.Cancel() }
      message = "cancelling evaluation"
      return EventResult.Handled
    }
    if IsCtrl(ev, "c") { return Interrupt() }
    if IsCtrl(ev, "q") { return EventResult.Exit }
    if IsCtrl(ev, "p") {
      OpenPalette()
      return EventResult.Handled
    }
    if IsCtrl(ev, " ") || (ev.Key == Key.Character && ev.Text == " " && Has(ev.Modifiers, KeyModifiers.Ctrl)) {
      OpenCompletions()
      return EventResult.Handled
    }
    if IsCtrl(ev, "k") || ev.Key == Key.F1 {
      OpenHover()
      return EventResult.Handled
    }
    if IsCtrl(ev, "l") {
      OpenLogs()
      return EventResult.Handled
    }
    if activeTab == 0 && editor.IsFocused && !AnyOverlay() {
      if ev.Key == Key.PageUp { return ScrollTranscript(-TranscriptPage()) }
      if ev.Key == Key.PageDown { return ScrollTranscript(TranscriptPage()) }
      if ev.Key == Key.Up && Has(ev.Modifiers, KeyModifiers.Ctrl) { return ScrollTranscript(-1) }
      if ev.Key == Key.Down && Has(ev.Modifiers, KeyModifiers.Ctrl) { return ScrollTranscript(1) }
    }
    if ev.Key == Key.Character && ev.Text.Equals("f", StringComparison.OrdinalIgnoreCase)
      && Has(ev.Modifiers, KeyModifiers.Shift) && Has(ev.Modifiers, KeyModifiers.Alt) {
        FormatEditor()
        return EventResult.Handled
      }
    if ev.Key == Key.Character && ev.Text.Length == 1
      && ev.Text[0] >= char(49) && ev.Text[0] <= char(54)
      && (Has(ev.Modifiers, KeyModifiers.Ctrl) || Has(ev.Modifiers, KeyModifiers.Alt)) {
        Activate(int32(ev.Text[0]) - int32(char(49)))
        return EventResult.Handled
      }
    if activeTab == 0 && transcript.IsFocused && ev.Key == Key.Enter {
      transcriptSource.Toggle(transcript.SelectedIndex)
      transcript.Refresh()
      return EventResult.Handled
    }
    if activeTab == 1 && history.IsFocused && ev.Key == Key.Enter {
      LoadHistory(history.SelectedIndex)
      return EventResult.Handled
    }
    if activeTab == 3 && diagnostics.IsFocused && ev.Key == Key.Enter {
      JumpDiagnostic(diagnostics.SelectedRowIndex)
      return EventResult.Handled
    }
    if activeTab == 5 && settings.IsFocused && ev.Key == Key.Enter {
      RunSetting(settings.SelectedIndex)
      return EventResult.Handled
    }
    return EventResult.Continue
  }

  private func MakeOverlay(title string, width int32, height int32) Overlay {
    let palette = ReplTheme.Current
    return Overlay{ IsVisible: false, DimBackground: true, Width: CellLength.Cells(width),
      Height: CellLength.Cells(height), Placement: Placement.Centered,
      Style: Style{ Foreground: palette.Text, Background: palette.Raised },
      Content: Box{ ShowBorder: true, Title: title, GrowWeight: 1,
        Style: Style{ Foreground: palette.Accent, Background: palette.Raised } } }
  }

  private func FitOverlays(bounds CellRect) {
    FitOverlay(paletteOverlay, bounds, 72, 12)
    FitOverlay(searchOverlay, bounds, 72, 14)
    FitOverlay(completionOverlay, bounds, 56, 9)
    FitOverlay(hoverOverlay, bounds, 64, 10)
    FitOverlay(logsOverlay, bounds, 76, 18)
    FitOverlay(inputOverlay, bounds, 64, 5)
  }

  private func FitOverlay(overlay Overlay, bounds CellRect, width int32, height int32) {
    overlay.Width = CellLength.Cells(Math.Max(1, Math.Min(width, bounds.WidthCells - 2)))
    overlay.Height = CellLength.Cells(Math.Max(1, Math.Min(height, bounds.HeightRows - 2)))
  }

  private func SpecialCharacter(text string, activate Action) {
    if AnyOverlay() {
      Handle(UiEvent{ Kind: UiEventKind.TextInput, Key: Key.Character, Text: text })
      return
    }
    if editor.IsFocused && editor.Text != "" {
      editor.Handle(UiEvent{ Kind: UiEventKind.TextInput, Key: Key.Character, Text: text })
      return
    }
    activate()
  }

  private func TabCharacter(text string, tab int32) {
    if AnyOverlay() || editor.IsFocused {
      let target Box = AnyOverlay() ? this : editor
      target.Handle(UiEvent{ Kind: UiEventKind.TextInput, Key: Key.Character, Text: text })
      return
    }
    Activate(tab)
  }

  private func TabArrow(key Key, delta int32) {
    if tabs.IsFocused {
      let next = Math.Clamp(tabs.SelectedIndex + delta, 0, tabs.Titles.Count - 1)
      if next != tabs.SelectedIndex { Activate(next, false) }
      return
    }
    Handle(UiEvent{ Kind: UiEventKind.Key, Key: key, Phase: KeyPhase.Press })
  }

  private func AnyOverlay() bool {
    for overlay in overlays { if overlay.IsVisible { return true } }
    return false
  }

  private func Activate(index int32) {
    Activate(index, true)
  }

  private func Activate(index int32, focusContent bool) {
    if index < 0 || index > 5 { return }
    activeTab = index
    tabs.SelectedIndex = index
    var i = 0
    while i < body.Children.Count {
      body.Children[i].IsVisible = i == index
      i = i + 1
    }
    if index == 1 { RebuildHistory() }
    else if index == 2 { RebuildVariables() }
    else if index == 3 { RebuildDiagnostics() }
    else if index == 5 { RebuildSettings() }
    if !focusContent { return }
    if index == 0 { Focus(editor) }
    else if index == 1 { Focus(history) }
    else if index == 2 { Focus(variables) }
    else if index == 3 { Focus(diagnostics) }
    else if index == 4 { Focus(help) }
    else { Focus(settings) }
  }

  private func Submit(text string) {
    if worker != nil || text.Trim() == "" { return }
    if !EmittedSessionEngine.IsComplete(text) {
      editor.Text = text + "\n"
      let lines = EditorLineSource.TextLines(editor.Text)
      editor.Caret = TextPosition{ LineIndex: lines.Count - 1, GraphemeIndex: 0 }
      AnalyzeNow(editor.Text)
      message = "continuation"
      return
    }
    guard let app = application else { return }
    editor.Text = ""
    AnalyzeNow("")
    CloseAllOverlays()
    busyFrame = 0
    message = "Esc interrupts"
    transcript.FollowTail = true
    worker = app.StartWorker(
      (ct CancellationToken) -> engine.EvaluateAsync(text, ct).GetAwaiter().GetResult(),
      (cell Cell) -> EvaluationCompleted(cell),
      (error Exception) -> EvaluationFailed(error),
      () -> EvaluationCancelled())
  }

  private func EvaluationCompleted(cell Cell) {
    worker = nil
    busyFrame = 0
    message = cell.HasError ? "cell " + cell.Index.ToString() + " failed" : "cell " + cell.Index.ToString() + " complete"
    RebuildSessionViews()
    transcript.FollowTail = true
    transcript.Refresh()
    Focus(editor)
  }

  private func EvaluationFailed(error Exception) {
    worker = nil
    busyFrame = 0
    message = "evaluation failed: " + error.Message
    RebuildSessionViews()
    Focus(editor)
  }

  private func EvaluationCancelled() {
    worker = nil
    busyFrame = 0
    message = "evaluation cancelled"
    RebuildSessionViews()
    Focus(editor)
  }

  private func Interrupt() EventResult {
    if let request = inputRequest {
      request.Complete(nil)
      CloseInput()
      if let running = worker { running.Cancel() }
      message = "cancelling input and evaluation"
      lastInterrupt = -1
      return EventResult.Handled
    }
    if let running = worker {
      running.Cancel()
      message = "cancelling evaluation"
      lastInterrupt = -1
      return EventResult.Handled
    }
    if editor.IsFocused && editor.Text != "" {
      editor.Text = ""
      AnalyzeNow("")
      message = "editor cleared"
      lastInterrupt = -1
      return EventResult.Handled
    }
    let now = Environment.TickCount64
    if lastInterrupt >= 0 && now - lastInterrupt <= 1500 { return EventResult.Exit }
    lastInterrupt = now
    message = "press Ctrl+C again to quit"
    return EventResult.Handled
  }

  private func ScheduleAnalysis(text string) {
    if text == "" {
      AnalyzeNow("")
      return
    }
    pendingAnalysis = text
    analysisTicks = 3
  }

  private func PumpAnalysis() bool {
    if pendingAnalysis == nil { return false }
    analysisTicks = analysisTicks - 1
    if analysisTicks > 0 { return false }
    guard let text = pendingAnalysis else { return false }
    AnalyzeNow(text)
    return true
  }

  private func AnalyzeNow(text string) {
    pendingAnalysis = nil
    analysisTicks = 0
    analysis = AnalysisBridge.Analyze(text)
    editor.StyleSource = EditorLineSource(text, analysis, ReplTheme.Current)
  }

  private func FormatEditor() {
    if editor.Text == "" { return }
    let formatted = AnalysisBridge.Format(editor.Text)
    editor.Text = formatted
    let lines = EditorLineSource.TextLines(formatted)
    let last = lines.Count - 1
    editor.Caret = TextPosition{ LineIndex: last, GraphemeIndex: CellText.Graphemes(lines[last]).Count }
    AnalyzeNow(formatted)
    message = "formatted"
  }

  private func OpenCompletions() {
    if !editor.IsFocused || editor.Text == "" { return }
    let at = CaretCharacter()
    completionItems = MatchingCompletions(
      AnalysisBridge.Completions(editor.Text, editor.Caret.LineIndex, at), CurrentPrefix())
    if completionItems.Count == 0 {
      message = "no completions"
      return
    }
    ShowCompletionPane()
  }

  private func CompleteWithTab() {
    if completionOverlay.IsVisible {
      if let pane = completionPane {
        pane.AcceptSelected()
        return
      }
    }
    if paletteOverlay.IsVisible {
      if let pane = palettePane {
        pane.CompleteSelection()
        return
      }
    }
    if editor.IsFocused && editor.Text != "" {
      CompletePrefix()
      return
    }
    Handle(UiEvent{ Kind: UiEventKind.Key, Key: Key.Tab, Phase: KeyPhase.Press })
  }

  private func CompletePrefix() {
    if editor.Text == "" { return }
    let at = CaretCharacter()
    let items = MatchingCompletions(
      AnalysisBridge.Completions(editor.Text, editor.Caret.LineIndex, at), CurrentPrefix())
    if items.Count == 0 {
      message = "no completions"
      return
    }
    let prefix = CurrentPrefix()
    var common = items[0].Label ?? ""
    var i = 1
    while i < items.Count {
      let label = items[i].Label ?? ""
      var length = 0
      let limit = Math.Min(common.Length, label.Length)
      while length < limit && Char.ToUpperInvariant(common[length]) == Char.ToUpperInvariant(label[length]) {
        length = length + 1
      }
      common = common.Substring(0, length)
      i = i + 1
    }
    if common.Length > prefix.Length && common.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) {
      ReplacePrefix(common)
      message = "completion expanded"
      return
    }
    completionItems = items
    ShowCompletionPane()
  }

  private func MatchingCompletions(items IReadOnlyList[CompletionItem], prefix string) IReadOnlyList[CompletionItem] {
    if prefix == "" { return items }
    let matches = List[CompletionItem]()
    for item in items {
      let label = item.Label ?? ""
      if label.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) { matches.Add(item) }
    }
    return matches
  }

  private func ShowCompletionPane() {
    let items = completionItems
    CloseAllOverlays()
    completionItems = items
    let pane = CompletionPane(completionItems, (index int32) -> AcceptCompletion(index),
      () -> CloseOverlay(completionOverlay), (ev UiEvent) -> ContinueCompletion(ev), ReplTheme.Current)
    completionPane = pane
    completionOverlay.Content = Box{ GrowWeight: 1, ShowBorder: true, Title: "completions", Children: { pane } }
    completionOverlay.Height = CellLength.Cells(Math.Min(9, completionItems.Count + 2))
    completionOverlay.IsVisible = true
    Focus(pane)
    PositionCompletion(Bounds)
  }

  private func ReplacePrefix(replacement string) {
    let lines = EditorLineSource.TextLines(editor.Text)
    let lineIndex = editor.Caret.LineIndex
    if lineIndex < 0 || lineIndex >= lines.Count { return }
    let line = lines[lineIndex]
    let at = CaretCharacter()
    let start = PrefixStart(line, at)
    lines[lineIndex] = line.Substring(0, start) + replacement + line.Substring(at)
    editor.Text = String.Join("\n", lines)
    editor.Caret = TextPosition{ LineIndex: lineIndex,
      GraphemeIndex: CellText.Graphemes(line.Substring(0, start) + replacement).Count }
    AnalyzeNow(editor.Text)
  }

  private func ContinueCompletion(ev UiEvent) {
    CloseOverlay(completionOverlay)
    editor.Handle(ev)
    if ev.Kind == UiEventKind.TextInput || ev.Key == Key.Left || ev.Key == Key.Right { OpenCompletions() }
  }

  private func AcceptCompletion(index int32) {
    if index < 0 || index >= completionItems.Count { return }
    let lines = EditorLineSource.TextLines(editor.Text)
    let lineIndex = editor.Caret.LineIndex
    if lineIndex < 0 || lineIndex >= lines.Count { return }
    let line = lines[lineIndex]
    let at = CaretCharacter()
    let edit = AnalysisBridge.CompletionEdit(completionItems[index], lineIndex, at, PrefixStart(line, at))
    if edit.StartLine < 0 || edit.StartLine >= lines.Count || edit.EndLine < edit.StartLine
      || edit.EndLine >= lines.Count || edit.StartCharacter < 0 || edit.EndCharacter < 0
      || edit.StartCharacter > lines[edit.StartLine].Length || edit.EndCharacter > lines[edit.EndLine].Length{ return }
    let replacementLines = EditorLineSource.TextLines(edit.NewText)
    let rebuilt = List[string]()
    var i = 0
    while i < edit.StartLine {
      rebuilt.Add(lines[i])
      i = i + 1
    }
    let before = lines[edit.StartLine].Substring(0, edit.StartCharacter)
    let after = lines[edit.EndLine].Substring(edit.EndCharacter)
    if replacementLines.Count == 1 {
      rebuilt.Add(before + replacementLines[0] + after)
    } else {
      rebuilt.Add(before + replacementLines[0])
      i = 1
      while i < replacementLines.Count - 1 {
        rebuilt.Add(replacementLines[i])
        i = i + 1
      }
      rebuilt.Add(replacementLines[replacementLines.Count - 1] + after)
    }
    i = edit.EndLine + 1
    while i < lines.Count {
      rebuilt.Add(lines[i])
      i = i + 1
    }
    editor.Text = String.Join("\n", rebuilt)
    let caretLine = edit.StartLine + replacementLines.Count - 1
    let caretText = replacementLines.Count == 1 ? before + replacementLines[0] : replacementLines[replacementLines.Count - 1]
    editor.Caret = TextPosition{ LineIndex: caretLine, GraphemeIndex: CellText.Graphemes(caretText).Count }
    AnalyzeNow(editor.Text)
    message = "completion accepted"
  }

  private func PositionCompletion(bounds CellRect) {
    if !completionOverlay.IsVisible {
      ghost.IsVisible = false
      return
    }
    guard let point = editor.CaretScreenPosition, let pane = completionPane else {
      ghost.IsVisible = false
      return
    }
    var column = point.Column
    var row = point.Row + 1
    let width = completionOverlay.Width.CellCount
    if column + width > bounds.WidthCells { column = Math.Max(0, bounds.WidthCells - width) }
    let height = completionOverlay.Height.CellCount
    if row + height > bounds.HeightRows { row = Math.Max(0, point.Row - height) }
    completionOverlay.Placement = Placement.At(CellPoint{ Column: column, Row: row })
    let selected = pane.SelectedIndex
    if selected < 0 || selected >= completionItems.Count {
      ghost.IsVisible = false
      return
    }
    let prefix = CurrentPrefix()
    let label = completionItems[selected].Label ?? ""
    if prefix == "" || !label.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || label.Length <= prefix.Length {
      ghost.IsVisible = false
      return
    }
    ghost.Text = label.Substring(prefix.Length)
    ghost.Width = CellLength.Cells(Math.Max(1, CellText.MeasureWidth(ghost.Text)))
    ghost.Placement = Placement.At(point)
    ghost.IsVisible = true
  }

  private func OpenHover() {
    if !editor.IsFocused {
      message = "hover needs editor focus"
      OpenTextOverlay(hoverOverlay, "hover help",
        "Hover reads the symbol under the editor caret. Press Esc, focus the editor, place the caret on a symbol, then press Ctrl+K or F1.")
      return
    }
    if editor.Text.Trim() == "" {
      message = "hover needs code at the editor caret"
      OpenTextOverlay(hoverOverlay, "hover help",
        "Type code, place the caret on a symbol, then press Ctrl+K or F1 to show its type and symbol information.")
      return
    }
    let text = AnalysisBridge.Hover(editor.Text, editor.Caret.LineIndex, CaretCharacter())
    OpenTextOverlay(hoverOverlay, "hover at editor caret", text ?? "No symbol information at the editor caret.")
  }

  private func OpenLogs() {
    var text = ""
    for cell in engine.Cells {
      if cell.Output != "" { text = text + "[" + cell.Index.ToString() + "] stdout\n" + cell.Output + "\n" }
      if cell.StandardError != "" { text = text + "[" + cell.Index.ToString() + "] stderr\n" + cell.StandardError + "\n" }
    }
    if text == "" { text = "No captured output." }
    OpenTextOverlay(logsOverlay, "captured output", text)
  }

  private func OpenTextOverlay(overlay Overlay, title string, text string) {
    CloseAllOverlays()
    let pane = DismissPane(text, () -> CloseOverlay(overlay), ReplTheme.Current)
    overlay.Content = Box{ GrowWeight: 1, ShowBorder: true, ShowScrollbar: true, Title: title, Children: { pane } }
    overlay.IsVisible = true
    Focus(pane)
  }

  private func OpenPalette() {
    CloseAllOverlays()
    let pane = PalettePane(PaletteVerbs(), (command string) -> RunCommand(command),
      () -> CloseOverlay(paletteOverlay), ReplTheme.Current)
    palettePane = pane
    paletteOverlay.Content = Box{ GrowWeight: 1, ShowBorder: true, Title: "command palette", Children: { pane } }
    paletteOverlay.IsVisible = true
    Focus(pane.Input)
  }

  private func OpenSearch() {
    CloseAllOverlays()
    let pane = SearchPane(engine, (index int32) -> JumpCell(index),
      () -> CloseOverlay(searchOverlay), ReplTheme.Current)
    searchOverlay.Content = Box{ GrowWeight: 1, ShowBorder: true, Title: "session search", Children: { pane } }
    searchOverlay.IsVisible = true
    Focus(pane.Input)
  }

  private func RunCommand(command string) bool {
    let normalized = command.Trim()
    if normalized == "reset" {
      if let running = worker { running.Cancel() }
      engine.Reset()
      transcriptSource.Reset()
      editor.Text = ""
      AnalyzeNow("")
      RebuildSessionViews()
      message = "session reset"
      return false
    }
    if normalized == "clear" {
      editor.Text = ""
      AnalyzeNow("")
      Focus(editor)
      message = "editor cleared"
      return false
    }
    if normalized == "show tree" {
      transcriptSource.ShowTree = !transcriptSource.ShowTree
      engine.CaptureSyntaxTree = transcriptSource.ShowTree
      transcript.Refresh()
      RebuildSettings()
      message = "syntax tree " + OnOff(transcriptSource.ShowTree)
      return false
    }
    if normalized == "show il" {
      transcriptSource.ShowIl = !transcriptSource.ShowIl
      engine.CaptureIntermediateLanguage = transcriptSource.ShowIl
      transcript.Refresh()
      RebuildSettings()
      message = "IL " + OnOff(transcriptSource.ShowIl)
      return false
    }
    if normalized == "theme" {
      ReplTheme.Cycle()
      ApplyTheme()
      message = "theme " + ReplTheme.Current.Name
      return false
    }
    if normalized.StartsWith("theme ", StringComparison.OrdinalIgnoreCase) {
      let name = normalized.Substring(6).Trim()
      if ReplTheme.Use(name) {
        ApplyTheme()
        message = "theme " + name
      }
      else { message = "unknown theme " + name }
      return false
    }
    if normalized.StartsWith("load ", StringComparison.OrdinalIgnoreCase) {
      let path = normalized.Substring(5).Trim()
      if !File.Exists(path) {
        message = "file not found: " + path
        return false
      }
      Submit(File.ReadAllText(path))
      return false
    }
    if normalized == "exit" || normalized == "quit" { return true }
    message = "unknown command: " + normalized
    return false
  }

  private func OpenInput(request InputRequest) {
    inputRequest = request
    CloseAllOverlays()
    let pane = InputPane(request, () -> CloseInput(), ReplTheme.Current)
    inputOverlay.Content = Box{ GrowWeight: 1, ShowBorder: true, Title: "standard input", Children: { pane } }
    inputOverlay.IsVisible = true
    Focus(pane.Input)
  }

  private func ReadInput() string? {
    guard let app = application else { return nil }
    let request = InputRequest()
    app.Post(() -> OpenInput(request))
    request.Gate.Wait()
    return request.Value
  }

  private func CloseInput() {
    inputOverlay.IsVisible = false
    inputRequest = nil
    Focus(editor)
  }

  private func CloseOverlay(overlay Overlay) {
    overlay.IsVisible = false
    if Object.ReferenceEquals(overlay, paletteOverlay) { palettePane = nil }
    if Object.ReferenceEquals(overlay, completionOverlay) {
      completionPane = nil
      completionItems = List[CompletionItem]()
      ghost.IsVisible = false
    }
    FocusForActiveTab()
  }

  private func CloseAllOverlays() {
    for overlay in overlays { overlay.IsVisible = false }
    completionPane = nil
    palettePane = nil
    completionItems = List[CompletionItem]()
    ghost.IsVisible = false
  }

  private func FocusForActiveTab() {
    if activeTab == 0 { Focus(editor) }
    else if activeTab == 1 { Focus(history) }
    else if activeTab == 2 { Focus(variables) }
    else if activeTab == 3 { Focus(diagnostics) }
    else if activeTab == 4 { Focus(help) }
    else { Focus(settings) }
  }

  private func RebuildSessionViews() {
    transcript.Refresh()
    RebuildHistory()
    RebuildVariables()
    RebuildDiagnostics()
    RebuildSettings()
  }

  private func RebuildHistory() {
    let items = List[ListItem]()
    for cell in engine.Cells {
      items.Add(ListItem{ Id: cell.Index.ToString(), Text: "[" + cell.Index.ToString() + "] " + EditorLineSource.TextLines(cell.Input)[0] })
    }
    history.Items = items
  }

  private func RebuildVariables() {
    let rows = List[TableRow]()
    for symbol in engine.Snapshot().Variables {
      let display = symbol.Display
      var before = display
      var value = ""
      let equals = display.IndexOf(" = ", StringComparison.Ordinal)
      if equals >= 0 {
        before = display.Substring(0, equals)
        value = display.Substring(equals + 3)
      }
      var name = before
      var typeText = ""
      let space = before.IndexOf(char(32))
      if space > 0 {
        name = before.Substring(0, space)
        typeText = before.Substring(space + 1)
      }
      let row = TableRow{ Id: name }
      row.Cells.Add(TableCell(name))
      row.Cells.Add(TableCell(typeText))
      row.Cells.Add(TableCell(value))
      rows.Add(row)
    }
    variables.Rows = rows
  }

  private func RebuildDiagnostics() {
    let rows = List[TableRow]()
    diagnosticCells = List[int32]()
    var cellIndex = 0
    while cellIndex < engine.Cells.Count {
      let cell = engine.Cells[cellIndex]
      for diagnostic in cell.Diagnostics {
        let row = TableRow{ Id: cell.Index.ToString() + ":" + rows.Count.ToString() }
        row.Cells.Add(TableCell(cell.Index.ToString()))
        row.Cells.Add(TableCell(diagnostic.Id))
        row.Cells.Add(TableCell(diagnostic.Message))
        rows.Add(row)
        diagnosticCells.Add(cellIndex)
      }
      cellIndex = cellIndex + 1
    }
    diagnostics.Rows = rows
  }

  private func RebuildSettings() {
    settings.Items = List[ListItem]{
      ListItem{ Id: "theme", Text: "theme                 " + ReplTheme.Current.Name },
      ListItem{ Id: "tree", Text: "show syntax tree      " + OnOff(transcriptSource.ShowTree) },
      ListItem{ Id: "il", Text: "show IL               " + OnOff(transcriptSource.ShowIl) },
      ListItem{ Id: "ascii", Text: "ASCII fallback        " + OnOff(transcriptSource.Ascii) },
    }
  }

  private func BuildHelp() {
    let entries = List[string]{
      "1-6                 switch tabs outside the editor",
      "Ctrl+1-6            switch tabs from anywhere",
      "Ctrl+P               open the command palette from anywhere",
      ":                    open the palette only when the editor is empty",
      "/                    search the session from an empty editor",
      "?                    open help from an empty editor",
      "Enter                run a complete submission",
      "Shift+Enter          insert a newline",
      "Tab                  complete, or move focus from an empty editor",
      "Ctrl+Space           show completions",
      "Ctrl+K or F1         show information for the symbol at the editor caret",
      "Shift+Alt+F          format the editor",
      "Ctrl+L               show captured output",
      "PageUp/PageDown      scroll the focused view",
      "Enter on a cell      collapse or expand it",
      "Ctrl+C               cancel or clear, then press twice to quit",
      "Ctrl+Q or :exit      quit",
      ":reset               clear session state",
      ":clear               clear the editor",
      ":show tree           toggle parse-tree dumps",
      ":show il             toggle IL dumps",
      ":load <file.gs>      run a file in the session",
      ":theme [name]        cycle or select a theme",
    }
    let items = List[ListItem]()
    for entry in entries { items.Add(ListItem{ Text: entry, IsSelectable: false }) }
    help.Items = items
  }

  private func LoadHistory(index int32) {
    if index < 0 || index >= engine.Cells.Count { return }
    editor.Text = engine.Cells[index].Input
    AnalyzeNow(editor.Text)
    Activate(0)
    message = "loaded cell " + engine.Cells[index].Index.ToString()
  }

  private func JumpDiagnostic(index int32) {
    if index < 0 || index >= diagnosticCells.Count { return }
    JumpCell(diagnosticCells[index])
  }

  private func JumpCell(index int32) {
    if index < 0 || index >= engine.Cells.Count { return }
    Activate(0)
    transcript.FollowTail = false
    transcript.SelectedIndex = index
    transcript.Refresh()
    Focus(transcript)
    message = "cell " + engine.Cells[index].Index.ToString()
  }

  private func RunSetting(index int32) {
    if index == 0 {
      ReplTheme.Cycle()
      ApplyTheme()
      message = "theme " + ReplTheme.Current.Name
    } else if index == 1 {
      RunCommand("show tree")
    } else if index == 2 {
      RunCommand("show il")
    } else if index == 3 {
      transcriptSource.Ascii = !transcriptSource.Ascii
      transcript.Refresh()
      RebuildSettings()
      message = "ASCII fallback " + OnOff(transcriptSource.Ascii)
    }
  }

  private func ApplyTheme() {
    let palette = ReplTheme.Current
    Style = Style{ Foreground: palette.Text, Background: palette.Canvas }
    header.Style = Style{ Foreground: palette.Text, Background: palette.Surface }
    footer.Style = Style{ Foreground: palette.Muted, Background: palette.Surface }
    tabs.Style = Style{ Foreground: palette.Muted, Background: palette.Canvas }
    tabs.SelectedStyle = Style{ Foreground: palette.Accent, Background: palette.Canvas, Attributes: TextAttributes.Bold }
    transcript.SelectedStyle = palette.Selection
    editor.Style = Style{ Foreground: palette.Text, Background: palette.Surface }
    editor.FocusedStyle = Style{ Foreground: palette.Text, Background: palette.Raised }
    editor.GutterStyle = Style{ Foreground: palette.Faint, Background: palette.Surface }
    editor.SelectedTextStyle = Style{ Foreground: palette.Canvas, Background: palette.Accent }
    history.SelectedStyle = palette.Selection
    variables.HeaderStyle = Style{ Foreground: palette.Accent, Background: palette.Surface }
    variables.SelectedRowStyle = palette.Selection
    diagnostics.HeaderStyle = Style{ Foreground: palette.Accent, Background: palette.Surface }
    diagnostics.SelectedRowStyle = palette.Selection
    settings.SelectedStyle = palette.Selection
    ghost.Style = Style{ Foreground: palette.Faint, Background: palette.Surface }
    transcriptSource.UsePalette(palette)
    for overlay in overlays { overlay.Style = Style{ Foreground: palette.Text, Background: palette.Raised } }
    if let app = application { app.DefaultStyle = Style{ Foreground: palette.Text, Background: palette.Canvas } }
    AnalyzeNow(editor.Text)
    transcript.Refresh()
    RebuildSettings()
  }

  private func CaretCharacter() int32 {
    let lines = EditorLineSource.TextLines(editor.Text)
    if editor.Caret.LineIndex < 0 || editor.Caret.LineIndex >= lines.Count { return 0 }
    let clusters = CellText.Graphemes(lines[editor.Caret.LineIndex])
    var count = 0
    var i = 0
    while i < editor.Caret.GraphemeIndex && i < clusters.Count {
      count = count + clusters[i].Length
      i = i + 1
    }
    return count
  }

  private func CurrentPrefix() string {
    let lines = EditorLineSource.TextLines(editor.Text)
    let lineIndex = editor.Caret.LineIndex
    if lineIndex < 0 || lineIndex >= lines.Count { return "" }
    let line = lines[lineIndex]
    let at = CaretCharacter()
    let start = PrefixStart(line, at)
    return line.Substring(start, at - start)
  }

  private func PrefixStart(line string, at int32) int32 {
    var start = at
    while start > 0 {
      let c = line[start - 1]
      if !Char.IsLetterOrDigit(c) && c != char(95) { break }
      start = start - 1
    }
    return start
  }

  private func ErrorCount() int32 {
    var count = 0
    for cell in engine.Cells { for diagnostic in cell.Diagnostics { if diagnostic.IsError { count = count + 1 } } }
    return count
  }

  private func TranscriptPage() int32 -> Math.Max(1, transcript.ContentBounds.HeightRows - 1)

  private func ScrollTranscript(delta int32) EventResult {
    var total = 0
    var i = 0
    let width = Math.Max(1, transcript.ContentBounds.WidthCells)
    while i < transcriptSource.Count() {
      total = total + transcriptSource.HeightAt(i, width)
      i = i + 1
    }
    let maximum = Math.Max(0, total - transcript.ContentBounds.HeightRows)
    let next = Math.Clamp(transcript.FirstVisibleRowOffset + delta, 0, maximum)
    transcript.FirstVisibleRowOffset = next
    transcript.FollowTail = next >= maximum
    return EventResult.Handled
  }

  private func StatusText(errors int32) string {
    if worker != nil {
      let phase = busyFrame % 4
      if phase == 1 { return "running." }
      if phase == 2 { return "running.." }
      if phase == 3 { return "running..." }
      return "running"
    }
    if errors > 0 { return errors.ToString() + " errors" }
    return "ready"
  }

  private func FooterHints() string {
    if tabs.IsFocused { return "Left/Right select · Tab enter" }
    if activeTab == 0 {
      if worker != nil { return "Esc interrupt · Ctrl+C cancel" }
      return "Ctrl+K hover at caret · Ctrl+P palette · : when empty"
    }
    if activeTab == 1 { return "Enter load · / search · Ctrl+1 REPL" }
    if activeTab == 2 { return "live session state · Ctrl+1 REPL" }
    if activeTab == 3 { return "Enter jump · Ctrl+1 REPL" }
    if activeTab == 4 { return "Tab focus · Ctrl+1 REPL" }
    return "Enter change · Ctrl+1 REPL"
  }

  private func UpdateFocusChrome() {
    transcriptBox.Title = FocusTitle("session transcript", transcript.IsFocused)
    editorBox.Title = FocusTitle("editor", editor.IsFocused)
    historyScreen.Title = FocusTitle("history", history.IsFocused)
    variablesScreen.Title = FocusTitle("live variables", variables.IsFocused)
    diagnosticsScreen.Title = FocusTitle("diagnostics", diagnostics.IsFocused)
    helpScreen.Title = FocusTitle("help", help.IsFocused)
    settingsScreen.Title = FocusTitle("settings", settings.IsFocused)
  }

  private func FocusName() string {
    if inputOverlay.IsVisible { return "standard input" }
    if paletteOverlay.IsVisible { return "command palette" }
    if searchOverlay.IsVisible { return "session search" }
    if completionOverlay.IsVisible { return "completions" }
    if hoverOverlay.IsVisible { return "hover" }
    if logsOverlay.IsVisible { return "captured output" }
    if tabs.IsFocused { return "tabs" }
    if transcript.IsFocused { return "transcript" }
    if editor.IsFocused { return "editor" }
    if history.IsFocused { return "history" }
    if variables.IsFocused { return "variables" }
    if diagnostics.IsFocused { return "diagnostics" }
    if help.IsFocused { return "help" }
    if settings.IsFocused { return "settings" }
    return "none"
  }

  private func FocusTitle(title string, focused bool) string -> focused ? title + " [focus]" : title

  private func PaletteVerbs() List[PaletteVerb] -> List[PaletteVerb] {
    PaletteVerb("reset", "clear session state"),
    PaletteVerb("clear", "clear the editor"),
    PaletteVerb("show tree", "toggle parse-tree dumps"),
    PaletteVerb("show il", "toggle emitted IL dumps"),
    PaletteVerb("load ", "run a .gs file into the session"),
    PaletteVerb("theme", "cycle the active theme"),
    PaletteVerb("exit", "quit the REPL"),
  }

  private func TabTitles(width int32, focused bool, selected int32) List[string] {
    var result = List[string]()
    if width < 60 { result = List[string]{ "1 REPL", "2H", "3V", "4D", "5?", "6S" } }
    else if width < 92 { result = List[string]{ "1 REPL", "2 Hist", "3 Vars", "4 Diag", "5 Help", "6 Set" } }
    else { result = List[string]{ "1 REPL", "2 History", "3 Variables", "4 Diagnostics", "5 Help", "6 Settings" } }
    if focused && selected >= 0 && selected < result.Count { result[selected] = "[" + result[selected] + "]" }
    return result
  }

  private func SameTitles(left List[string], right List[string]) bool {
    if left.Count != right.Count { return false }
    var i = 0
    while i < left.Count {
      if left[i] != right[i] { return false }
      i = i + 1
    }
    return true
  }

  private func OnOff(value bool) string -> value ? "on" : "off"

  private func Has(value KeyModifiers, flag KeyModifiers) bool -> (int32(value) & int32(flag)) != 0

  private func IsCtrl(ev UiEvent, text string) bool -> ev.Key == Key.Character
    && ev.Text.Equals(text, StringComparison.OrdinalIgnoreCase) && Has(ev.Modifiers, KeyModifiers.Ctrl)
}
