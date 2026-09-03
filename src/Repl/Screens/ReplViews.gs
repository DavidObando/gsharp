package GSharp.Repl.Screens

import SharpTui

import GSharp.Repl.Engine
import GSharp.Repl.Themes

import System
import System.Collections.Generic
import System.Text

public class EditorLineSource : RichLineSource {
  private let lines List[string]
  private let tokens Dictionary[int32, List[EditorToken]]
  private let diagnostics Dictionary[int32, List[EditorDiagnostic]]
  private let palette ReplPalette
  private let maximumWidth int32

  public init(text string, analysis EditorAnalysis, palette ReplPalette) {
    this.palette = palette
    lines = TextLines(text)
    tokens = Dictionary[int32, List[EditorToken]]()
    diagnostics = Dictionary[int32, List[EditorDiagnostic]]()
    for token in analysis.Tokens {
      if token.Line < 0 || token.Line >= lines.Count { continue }
      var existing List[EditorToken]
      if !tokens.TryGetValue(token.Line, out existing) {
        existing = List[EditorToken]()
        tokens.Add(token.Line, existing)
      }
      existing.Add(token)
    }
    for diagnostic in analysis.Diagnostics {
      var line = Math.Max(0, diagnostic.StartLine)
      let last = Math.Min(lines.Count - 1, Math.Max(line, diagnostic.EndLine))
      while line <= last {
        var existing List[EditorDiagnostic]
        if !diagnostics.TryGetValue(line, out existing) {
          existing = List[EditorDiagnostic]()
          diagnostics.Add(line, existing)
        }
        existing.Add(diagnostic)
        line = line + 1
      }
    }
    var width = 0
    for line in lines {
      let measured = CellText.MeasureWidth(line)
      if measured > width { width = measured }
    }
    maximumWidth = width
  }

  public func Count() int32 -> lines.Count

  public func MaximumLineWidth() int32 -> maximumWidth

  public func ItemAt(index int32) RichTextLine {
    let text = lines[index]
    let runs = List[TextRun]()
    if text.Length == 0 { return RichTextLine(runs) }
    var start = 0
    var kind = KindAt(index, 0)
    var marked = DiagnosticAt(index, 0)
    var i = 1
    while i <= text.Length {
      let nextKind = i < text.Length ? KindAt(index, i) : -2
      let nextMarked = i < text.Length && DiagnosticAt(index, i)
      if nextKind != kind || nextMarked != marked {
        runs.Add(TextRun(text.Substring(start, i - start), SegmentStyle(kind, marked)))
        start = i
        kind = nextKind
        marked = nextMarked
      }
      i = i + 1
    }
    return RichTextLine(runs)
  }

  private func KindAt(line int32, character int32) int32 {
    var lineTokens List[EditorToken]
    if !tokens.TryGetValue(line, out lineTokens) { return -1 }
    for token in lineTokens {
      if character >= token.StartCharacter && character < token.StartCharacter + token.Length {
        return token.Kind
      }
    }
    return -1
  }

  private func DiagnosticAt(line int32, character int32) bool {
    var lineDiagnostics List[EditorDiagnostic]
    if !diagnostics.TryGetValue(line, out lineDiagnostics) { return false }
    for diagnostic in lineDiagnostics {
      if diagnostic.StartLine == diagnostic.EndLine {
        var end = diagnostic.EndCharacter
        if end <= diagnostic.StartCharacter { end = diagnostic.StartCharacter + 1 }
        if character >= diagnostic.StartCharacter && character < end { return true }
        continue
      }
      if line == diagnostic.StartLine && character >= diagnostic.StartCharacter { return true }
      if line == diagnostic.EndLine && character < diagnostic.EndCharacter { return true }
      if line > diagnostic.StartLine && line < diagnostic.EndLine { return true }
    }
    return false
  }

  private func SegmentStyle(kind int32, marked bool) Style {
    var foreground = palette.Text
    if kind >= 0 && kind <= 6 { foreground = palette.TypeColor }
    else if kind == 7 || kind == 8 || kind == 9 { foreground = palette.VariableColor }
    else if kind == 10 || kind == 11 || kind == 17 { foreground = palette.FunctionColor }
    else if kind == 12 { foreground = palette.Keyword }
    else if kind == 13 { foreground = palette.StringLiteral }
    else if kind == 14 { foreground = palette.Number }
    else if kind == 15 { foreground = palette.Muted }
    else if kind == 16 { foreground = palette.Comment }
    let attributes = marked ? TextAttributes.Underline : TextAttributes.None
    return Style{ Foreground: foreground, Background: Color.Inherit, Attributes: attributes }
  }

  shared {
    public func TextLines(text string) List[string] {
      let result = List[string]()
      let normalized = text.Replace("\r\n", "\n").Replace(char(13), char(10))
      for line in normalized.Split(char(10)) { result.Add(line) }
      if result.Count == 0 { result.Add("") }
      return result
    }
  }
}

public class TranscriptSource : VirtualListSource {
  private let engine ISessionEngine
  private let collapsed HashSet[int32]
  private let analyses Dictionary[int32, EditorAnalysis]
  private let rendered Dictionary[string, List[List[TextRun]]]
  private var renderedWidth int32
  private var palette ReplPalette
  private var showTree bool
  private var showIl bool
  private var ascii bool

  public init(engine ISessionEngine, palette ReplPalette) {
    this.engine = engine
    this.palette = palette
    collapsed = HashSet[int32]()
    analyses = Dictionary[int32, EditorAnalysis]()
    rendered = Dictionary[string, List[List[TextRun]]]()
    renderedWidth = -1
    showTree = false
    showIl = false
    ascii = false
  }

  public prop ShowTree bool{
    get -> showTree
    set {
      if showTree != value {
        showTree = value
        rendered.Clear()
      }
    }
  }

  public prop ShowIl bool{
    get -> showIl
    set {
      if showIl != value {
        showIl = value
        rendered.Clear()
      }
    }
  }

  public prop Ascii bool{
    get -> ascii
    set {
      if ascii != value {
        ascii = value
        rendered.Clear()
      }
    }
  }

  public func UsePalette(value ReplPalette) {
    palette = value
    rendered.Clear()
  }

  public func Reset() {
    collapsed.Clear()
    analyses.Clear()
    rendered.Clear()
  }

  public func Count() int32 -> engine.Cells.Count

  public func KeyAt(index int32) string -> engine.Cells[index].Index.ToString()

  public func IndexOfKey(key string) int32 {
    var value = 0
    if !Int32.TryParse(key, out value) { return -1 }
    var i = 0
    while i < engine.Cells.Count {
      if engine.Cells[i].Index == value { return i }
      i = i + 1
    }
    return -1
  }

  public func IsSelectable(index int32) bool -> true

  public func HeightAt(index int32, width int32) int32 -> Lines(engine.Cells[index], width).Count + 1

  public func Toggle(index int32) {
    if index < 0 || index >= engine.Cells.Count { return }
    let id = engine.Cells[index].Index
    if collapsed.Contains(id) { collapsed.Remove(id) }
    else { collapsed.Add(id) }
    rendered.Clear()
  }

  public func Render(index int32, screen Screen, bounds CellRect, clipBounds CellRect,
    style Style, state VirtualListItemState) {
      screen.Fill(clipBounds, style)
      let lines = Lines(engine.Cells[index], bounds.WidthCells)
      var row = 0
      while row < lines.Count {
        let y = bounds.Row + row
        if y >= clipBounds.Row && y < clipBounds.Row + clipBounds.HeightRows {
          WriteRuns(screen, clipBounds, y - clipBounds.Row, lines[row], style)
        }
        row = row + 1
      }
    }

  private func Lines(cell Cell, width int32) List[List[TextRun]] {
    let available = Math.Max(1, width)
    if renderedWidth != available {
      rendered.Clear()
      renderedWidth = available
    }
    let options = showTree.ToString() + ":" + showIl.ToString() + ":" + ascii.ToString()
    let key = cell.Index.ToString() + ":" + options + ":" + palette.Name
    var existing List[List[TextRun]]
    if rendered.TryGetValue(key, out existing) { return existing }
    let result = List[List[TextRun]]()
    let isCollapsed = collapsed.Contains(cell.Index)
    let fold = isCollapsed
    ? (ascii ? "+" : "▸") : (ascii ? "-" : "▾")
    let prompt = ascii ? ">" : "»"
    let styledInput = EditorLineSource(cell.Input, AnalysisFor(cell), palette)
    var first = true
    var inputIndex = 0
    while inputIndex < styledInput.Count() {
      var prefix = "     "
      if first {
        prefix = fold + " [" + cell.Index.ToString() + "] " + prompt + " "
        first = false
      }
      let runs = List[TextRun]()
      runs.Add(TextRun(prefix, Style{ Foreground: palette.Accent }))
      for run in styledInput.ItemAt(inputIndex).Runs {
        runs.Add(TextRun(run.Text, Style{ Foreground: run.Style.Foreground }))
      }
      result.Add(runs)
      if isCollapsed {
        let wrapped = Wrap(result, available)
        rendered.Add(key, wrapped)
        return wrapped
      }
      inputIndex = inputIndex + 1
    }

    for diagnostic in cell.Diagnostics {
      let color = diagnostic.IsError ? palette.Error : palette.Warning
      AddLine(result, "     " + (ascii ? "! " : "╰─ ") + diagnostic.Id + " " + diagnostic.Message, color)
    }
    AddOutput(result, cell.Output, palette.Muted)
    AddOutput(result, cell.StandardError, palette.Error)
    if !cell.HasError && cell.Value != nil {
      AddLine(result, "     = " + ReplValueFormatter.Format(cell.Value), palette.Good)
    }
    if showTree {
      AddLine(result, "     syntax tree", palette.Accent)
      let tree = cell.SyntaxTree != "" ? cell.SyntaxTree : AnalysisBridge.SyntaxTree(cell.Input)
      AddOutput(result, tree, palette.Faint)
    }
    if showIl {
      AddLine(result, "     intermediate language", palette.Accent)
      AddOutput(result, cell.IntermediateLanguage != "" ? cell.IntermediateLanguage : "IL capture was not enabled for this cell.", palette.Faint)
    }
    let wrapped = Wrap(result, available)
    rendered.Add(key, wrapped)
    return wrapped
  }

  private func Wrap(lines List[List[TextRun]], width int32) List[List[TextRun]] {
    let wrapped = List[List[TextRun]]()
    let available = Math.Max(1, width)
    for line in lines {
      var row = List[TextRun]()
      var used = 0
      for run in line {
        let piece = StringBuilder()
        for grapheme in CellText.Graphemes(run.Text) {
          let measured = Math.Max(1, CellText.MeasureWidth(grapheme))
          if used > 0 && used + measured > available {
            AddPiece(row, piece, run)
            wrapped.Add(row)
            row = List[TextRun]()
            used = 0
          }
          piece.Append(grapheme)
          used = used + measured
          if used >= available {
            AddPiece(row, piece, run)
            wrapped.Add(row)
            row = List[TextRun]()
            used = 0
          }
        }
        AddPiece(row, piece, run)
      }
      if row.Count > 0 || line.Count == 0 { wrapped.Add(row) }
    }
    return wrapped
  }

  private func AddPiece(row List[TextRun], piece StringBuilder, run TextRun) {
    if piece.Length == 0 { return }
    row.Add(TextRun(piece.ToString(), run.Style, run.Hyperlink))
    piece.Clear()
  }

  private func AnalysisFor(cell Cell) EditorAnalysis {
    var existing EditorAnalysis
    if analyses.TryGetValue(cell.Index, out existing) { return existing }
    let created = AnalysisBridge.Analyze(cell.Input)
    analyses.Add(cell.Index, created)
    return created
  }

  private func AddOutput(lines List[List[TextRun]], text string, color Color) {
    if text == "" { return }
    for line in EditorLineSource.TextLines(text.TrimEnd(char(10), char(13))) {
      AddLine(lines, "     " + line, color)
    }
  }

  private func AddLine(lines List[List[TextRun]], text string, color Color) {
    lines.Add(List[TextRun]{ TextRun(text, Style{ Foreground: color }) })
  }

  private func WriteRuns(screen Screen, clip CellRect, row int32, runs List[TextRun], inherited Style) {
    var column = 0
    for run in runs {
      let foreground = run.Style.Foreground.IsInherited ? inherited.Foreground : run.Style.Foreground
      let background = run.Style.Background.IsInherited ? inherited.Background : run.Style.Background
      let attributes = TextAttributes(int32(inherited.Attributes) | int32(run.Style.Attributes))
      screen.WriteClipped(clip, column, row, TextRun(run.Text,
        Style{ Foreground: foreground, Background: background, Attributes: attributes }, run.Hyperlink))
      column = column + CellText.MeasureWidth(run.Text)
    }
  }
}
