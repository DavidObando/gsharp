package GSharp.Repl.Screens

import SharpTui

import GSharp.LanguageServer.Protocol
import GSharp.Repl.Engine
import GSharp.Repl.Themes

import System
import System.Collections.Generic
import System.Threading

public class PaletteVerb {
  public let Command string
  public let Help string

  public init(command string, help string) {
    Command = command
    Help = help
  }
}

public open class PalettePane : Column {
  private let input TextInput
  private let list ListView
  private let verbs List[PaletteVerb]
  private let run Func[string, bool]
  private let dismiss Action
  private var observed string

  public init(verbs List[PaletteVerb], run Func[string, bool], dismiss Action, palette ReplPalette) {
    GrowWeight = 1
    this.verbs = verbs
    this.run = run
    this.dismiss = dismiss
    observed = ""
    input = TextInput{ Placeholder: "command", GrowWeight: 0, Height: CellLength.Cells(1) }
    list = ListView{ GrowWeight: 1, SelectionMarker: "  ", SelectedStyle: palette.Selection }
    Children.Add(input)
    Children.Add(list)
    Rebuild()
    Focus(input)
  }

  public prop Input TextInput -> input

  public func CompleteSelection() {
    if list.SelectedIndex < 0 || list.SelectedIndex >= list.Items.Count { return }
    input.Text = list.Items[list.SelectedIndex].Id
    input.MoveCaretToEnd()
  }

  protected override func Render(screen Screen, bounds CellRect, style Style) {
    if input.Text != observed {
      observed = input.Text
      Rebuild()
    }
  }

  protected override func Accept(ev UiEvent) EventResult {
    if ev.Phase == KeyPhase.Release { return EventResult.Continue }
    if ev.Key == Key.Escape {
      dismiss()
      return EventResult.Handled
    }
    if ev.Key == Key.Up {
      list.SelectedIndex = Math.Max(0, list.SelectedIndex - 1)
      return EventResult.Handled
    }
    if ev.Key == Key.Down {
      list.SelectedIndex = list.Items.Count == 0 ? 0 : Math.Min(list.Items.Count - 1, list.SelectedIndex + 1)
      return EventResult.Handled
    }
    if ev.Key == Key.Tab {
      CompleteSelection()
      return EventResult.Handled
    }
    if ev.Key == Key.Enter {
      var command = input.Text.Trim()
      if list.SelectedIndex >= 0 && list.SelectedIndex < list.Items.Count {
        command = list.Items[list.SelectedIndex].Id
      }
      dismiss()
      return command != "" && run(command) ? EventResult.Exit : EventResult.Handled
    }
    return EventResult.Continue
  }

  private func Rebuild() {
    let items = List[ListItem]()
    let needle = input.Text.Trim()
    for verb in verbs {
      if needle != "" && !verb.Command.Contains(needle, StringComparison.OrdinalIgnoreCase) { continue }
      items.Add(ListItem{ Id: verb.Command, Text: verb.Command.PadRight(16) + verb.Help })
    }
    list.Items = items
    if items.Count > 0 { list.SelectedIndex = 0 }
  }
}

public open class SearchPane : Column {
  private let input TextInput
  private let list ListView
  private let engine ISessionEngine
  private let choose Action[int32]
  private let dismiss Action
  private var matches List[int32]
  private var observed string

  public init(engine ISessionEngine, choose Action[int32], dismiss Action, palette ReplPalette) {
    GrowWeight = 1
    this.engine = engine
    this.choose = choose
    this.dismiss = dismiss
    observed = ""
    matches = List[int32]()
    input = TextInput{ Placeholder: "search the session", GrowWeight: 0, Height: CellLength.Cells(1) }
    list = ListView{ GrowWeight: 1, SelectionMarker: "  ", SelectedStyle: palette.Selection }
    Children.Add(input)
    Children.Add(list)
    Rebuild()
    Focus(input)
  }

  public prop Input TextInput -> input

  protected override func Render(screen Screen, bounds CellRect, style Style) {
    if input.Text != observed {
      observed = input.Text
      Rebuild()
    }
  }

  protected override func Accept(ev UiEvent) EventResult {
    if ev.Phase == KeyPhase.Release { return EventResult.Continue }
    if ev.Key == Key.Escape {
      dismiss()
      return EventResult.Handled
    }
    if ev.Key == Key.Up {
      list.SelectedIndex = list.SelectedIndex <= 0 ? list.Items.Count - 1 : list.SelectedIndex - 1
      return EventResult.Handled
    }
    if ev.Key == Key.Down {
      list.SelectedIndex = list.Items.Count == 0 ? 0 : (list.SelectedIndex + 1) % list.Items.Count
      return EventResult.Handled
    }
    if ev.Key == Key.Enter {
      if list.SelectedIndex >= 0 && list.SelectedIndex < matches.Count {
        let selected = matches[list.SelectedIndex]
        dismiss()
        choose(selected)
      }
      return EventResult.Handled
    }
    return EventResult.Continue
  }

  private func Rebuild() {
    let items = List[ListItem]()
    matches = List[int32]()
    let needle = input.Text.Trim()
    var i = 0
    while i < engine.Cells.Count {
      let cell = engine.Cells[i]
      let haystack = cell.Input + "\n" + cell.Output + "\n" + cell.StandardError
      if needle == "" || haystack.Contains(needle, StringComparison.OrdinalIgnoreCase) {
        let first = EditorLineSource.TextLines(cell.Input)[0]
        items.Add(ListItem{ Id: cell.Index.ToString(), Text: "[" + cell.Index.ToString() + "] " + first })
        matches.Add(i)
      }
      i = i + 1
    }
    list.Items = items
    if items.Count > 0 { list.SelectedIndex = 0 }
  }
}

public open class CompletionPane : Column {
  private let list ListView
  private let items IReadOnlyList[CompletionItem]
  private let choose Action[int32]
  private let dismiss Action
  private let continueEditing Action[UiEvent]

  public init(items IReadOnlyList[CompletionItem], choose Action[int32], dismiss Action,
    continueEditing Action[UiEvent], palette ReplPalette) {
      GrowWeight = 1
      this.items = items
      this.choose = choose
      this.dismiss = dismiss
      this.continueEditing = continueEditing
      list = ListView{ GrowWeight: 1, SelectionMarker: "", SelectedStyle: palette.Selection }
      let rows = List[ListItem]()
      var i = 0
      while i < items.Count {
        let item = items[i]
        let detail = item.Detail == nil ? "" : "  " + item.Detail
        rows.Add(ListItem{ Id: i.ToString(), Text: item.Label + detail })
        i = i + 1
      }
      list.Items = rows
      if rows.Count > 0 { list.SelectedIndex = 0 }
      Children.Add(list)
      Focus(list)
    }

  public prop SelectedIndex int32 -> list.SelectedIndex

  public func AcceptSelected() {
    if list.SelectedIndex >= 0 && list.SelectedIndex < items.Count { choose(list.SelectedIndex) }
    dismiss()
  }

  protected override func Accept(ev UiEvent) EventResult {
    if ev.Phase == KeyPhase.Release { return EventResult.Continue }
    if ev.Kind == UiEventKind.TextInput || ev.Key == Key.Backspace || ev.Key == Key.Left || ev.Key == Key.Right {
      continueEditing(ev)
      return EventResult.Handled
    }
    if ev.Key == Key.Escape {
      dismiss()
      return EventResult.Handled
    }
    if ev.Key == Key.Enter || ev.Key == Key.Tab {
      AcceptSelected()
      return EventResult.Handled
    }
    return EventResult.Continue
  }
}

public open class DismissPane : Column {
  private let dismiss Action

  public init(text string, dismiss Action, palette ReplPalette) {
    GrowWeight = 1
    this.dismiss = dismiss
    Children.Add(TextBlock{ Text: text, Wrapping: TextWrapping.Word, GrowWeight: 1,
      Style: Style{ Foreground: palette.Text, Background: palette.Raised } })
  }

  protected override func Accept(ev UiEvent) EventResult {
    if ev.Phase != KeyPhase.Release && ev.Key == Key.Escape {
      dismiss()
      return EventResult.Handled
    }
    return EventResult.Continue
  }
}

public class InputRequest {
  public let Gate ManualResetEventSlim
  public var Value string?

  public init() {
    Gate = ManualResetEventSlim(false)
    Value = nil
  }

  public func Complete(value string?) {
    Value = value
    Gate.Set()
  }
}

public open class InputPane : Column {
  private let input TextInput
  private let request InputRequest
  private let dismiss Action

  public init(request InputRequest, dismiss Action, palette ReplPalette) {
    GrowWeight = 1
    this.request = request
    this.dismiss = dismiss
    input = TextInput{ Placeholder: "standard input", GrowWeight: 1 }
    Children.Add(Label{ Text: "The running cell requested one line of input." })
    Children.Add(input)
    Focus(input)
  }

  public prop Input TextInput -> input

  protected override func Accept(ev UiEvent) EventResult {
    if ev.Phase == KeyPhase.Release { return EventResult.Continue }
    if ev.Key == Key.Escape {
      request.Complete(nil)
      dismiss()
      return EventResult.Handled
    }
    if ev.Key == Key.Enter {
      request.Complete(input.Text)
      dismiss()
      return EventResult.Handled
    }
    return EventResult.Continue
  }
}
