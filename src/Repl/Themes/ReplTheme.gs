package GSharp.Repl.Themes

import SharpTui

import System
import System.Collections.Generic

public class ReplPalette {
  public let Name string
  public let Text Color
  public let Muted Color
  public let Faint Color
  public let Accent Color
  public let Canvas Color
  public let Surface Color
  public let Raised Color
  public let Border Color
  public let Good Color
  public let Warning Color
  public let Error Color
  public let Keyword Color
  public let StringLiteral Color
  public let Number Color
  public let Comment Color
  public let TypeColor Color
  public let FunctionColor Color
  public let VariableColor Color

  public prop Selection Style -> Name == "mono"
  ? Style{ Attributes: TextAttributes.Reverse } : Style{ Foreground: Canvas, Background: Accent, Attributes: TextAttributes.Bold }

  public init(name string, text Color, muted Color, faint Color, accent Color,
    canvas Color, surface Color, raised Color, border Color, good Color,
    warning Color, error Color, keyword Color, stringLiteral Color,
    number Color, comment Color, typeColor Color, functionColor Color, variableColor Color) {
      Name = name
      Text = text
      Muted = muted
      Faint = faint
      Accent = accent
      Canvas = canvas
      Surface = surface
      Raised = raised
      Border = border
      Good = good
      Warning = warning
      Error = error
      Keyword = keyword
      StringLiteral = stringLiteral
      Number = number
      Comment = comment
      TypeColor = typeColor
      FunctionColor = functionColor
      VariableColor = variableColor
    }
}

public class ReplTheme {
  shared {
    private let palettes List[ReplPalette] = Build()
    private var selected int32 = 0
    public prop Current ReplPalette -> palettes[selected]

    public prop Available IReadOnlyList[ReplPalette] -> palettes

    public func ConfigureFromEnvironment() {
      if Environment.GetEnvironmentVariable("NO_COLOR") != nil
        || Environment.GetEnvironmentVariable("GSI_SCREEN_READER") == "1" {
          Use("mono")
        }
    }

    public func Use(name string) bool {
      var i = 0
      while i < palettes.Count {
        if String.Equals(palettes[i].Name, name, StringComparison.OrdinalIgnoreCase) {
          selected = i
          return true
        }
        i = i + 1
      }
      return false
    }

    public func Cycle() ReplPalette {
      selected = (selected + 1) % palettes.Count
      return Current
    }

    public func Reset() {
      selected = 0
    }

    private func Build() List[ReplPalette] {
      let list = List[ReplPalette]()
      list.Add(ReplPalette(
        "default",
        Color.Rgb("E6E8ED"), Color.Rgb("A5ACB8"), Color.Rgb("6E7684"), Color.Rgb("78A9FF"),
        Color.Rgb("0D1117"), Color.Rgb("151B23"), Color.Rgb("1D2530"), Color.Rgb("303A48"),
        Color.Rgb("57D69A"), Color.Rgb("EBCB6B"), Color.Rgb("FF6B7A"), Color.Rgb("C792EA"),
        Color.Rgb("ECC48D"), Color.Rgb("F78C6C"), Color.Rgb("6A9955"), Color.Rgb("82AAFF"),
        Color.Rgb("89DDFF"), Color.Rgb("C3E88D")))
      list.Add(ReplPalette(
        "mono",
        Color.TerminalDefault, Color.TerminalDefault, Color.TerminalDefault,
        Color.TerminalDefault, Color.TerminalDefault, Color.TerminalDefault, Color.TerminalDefault,
        Color.TerminalDefault, Color.TerminalDefault, Color.TerminalDefault,
        Color.TerminalDefault, Color.TerminalDefault, Color.TerminalDefault, Color.TerminalDefault,
        Color.TerminalDefault, Color.TerminalDefault, Color.TerminalDefault,
        Color.TerminalDefault))
      list.Add(ReplPalette(
        "high-contrast",
        Color.Rgb("FFFFFF"), Color.Rgb("D8D8D8"), Color.Rgb("B0B0B0"), Color.Rgb("00E5FF"),
        Color.Rgb("000000"), Color.Rgb("080808"), Color.Rgb("141414"), Color.Rgb("FFFFFF"),
        Color.Rgb("00FF85"), Color.Rgb("FFE600"), Color.Rgb("FF4055"), Color.Rgb("00E5FF"),
        Color.Rgb("FFD166"), Color.Rgb("FF9F1C"), Color.Rgb("B0B0B0"), Color.Rgb("7DF9FF"),
        Color.Rgb("FF7CE5"), Color.Rgb("A7FF83")))
      list.Add(ReplPalette(
        "colorblind",
        Color.Rgb("F2F2F2"), Color.Rgb("B9C0C7"), Color.Rgb("7D8790"), Color.Rgb("56B4E9"),
        Color.Rgb("101418"), Color.Rgb("171D22"), Color.Rgb("202930"), Color.Rgb("3B4852"),
        Color.Rgb("009E73"), Color.Rgb("E69F00"), Color.Rgb("D55E00"), Color.Rgb("56B4E9"),
        Color.Rgb("F0E442"), Color.Rgb("E69F00"), Color.Rgb("7D8790"), Color.Rgb("CC79A7"),
        Color.Rgb("0072B2"), Color.Rgb("009E73")))
      return list
    }
  }
}
