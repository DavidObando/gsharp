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
    internal let AccentRgb int32
    internal let SurfaceRgb int32
    public let Border Color
    public let SelectionForeground Color
    public let SelectionBackground Color
    public let TranscriptSelectionBackground Color
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
    ? Style{Attributes: TextAttributes.Reverse} : Style{
        Foreground: SelectionForeground,
        Background: SelectionBackground,
        Attributes: TextAttributes.Bold
    }

    public prop TranscriptSelection Style -> Name == "mono"
    ? Style{Attributes: TextAttributes.Reverse} : Style{Foreground: Text, Background: TranscriptSelectionBackground}

    internal func BlendAccentOverSurface(alpha float64, brightness float64 = 1.0) Color {
        if AccentRgb < 0 || SurfaceRgb < 0 {
            return Color.TerminalDefault
        }
        let clampedAlpha = Math.Clamp(alpha, 0.0, 1.0)
        let ar = float64(uint8(Math.Min(255.0, float64((AccentRgb >> 16) & 0xFF) * brightness)))
        let ag = float64(uint8(Math.Min(255.0, float64((AccentRgb >> 8) & 0xFF) * brightness)))
        let ab = float64(uint8(Math.Min(255.0, float64(AccentRgb & 0xFF) * brightness)))
        let sr = float64((SurfaceRgb >> 16) & 0xFF)
        let sg = float64((SurfaceRgb >> 8) & 0xFF)
        let sb = float64(SurfaceRgb & 0xFF)
        let r = int32(uint8((ar * clampedAlpha) + (sr * (1.0 - clampedAlpha))))
        let g = int32(uint8((ag * clampedAlpha) + (sg * (1.0 - clampedAlpha))))
        let b = int32(uint8((ab * clampedAlpha) + (sb * (1.0 - clampedAlpha))))
        return Color.Rgb(r, g, b)
    }

    public init(
        name string,
        text Color,
        muted Color,
        faint Color,
        accent Color,
        canvas Color,
        surface Color,
        raised Color,
        border Color,
        selectionForeground Color,
        selectionBackground Color,
        transcriptSelectionBackground Color,
        good Color,
        warning Color,
        error Color,
        keyword Color,
        stringLiteral Color,
        number Color,
        comment Color,
        typeColor Color,
        functionColor Color,
        variableColor Color,
        accentRgb int32 = -1,
        surfaceRgb int32 = -1
    ) {
        Name = name
        Text = text
        Muted = muted
        Faint = faint
        Accent = accent
        Canvas = canvas
        Surface = surface
        Raised = raised
        Border = border
        SelectionForeground = selectionForeground
        SelectionBackground = selectionBackground
        TranscriptSelectionBackground = transcriptSelectionBackground
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
        AccentRgb = accentRgb
        SurfaceRgb = surfaceRgb
    }
}

public class ReplTheme {
    shared {
        private let palettes List[ReplPalette] = Build()
        private var selected int32 = 0
        public prop Current ReplPalette -> palettes[selected]

        public prop Available IReadOnlyList[ReplPalette] -> palettes

        public func ConfigureFromEnvironment() {
            if !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("NO_COLOR"))
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
            list.Add(
                ReplPalette(
                    "default",
                    Color.Rgb("E6EDF3"),
                    Color.Rgb("B1BAC4"),
                    Color.Rgb("8E98A4"),
                    Color.Rgb("79B8FF"),
                    Color.Rgb("0D1117"),
                    Color.Rgb("161B22"),
                    Color.Rgb("1F2630"),
                    Color.Rgb("485464"),
                    Color.Rgb("F0F6FC"),
                    Color.Rgb("1F3A5F"),
                    Color.Rgb("182433"),
                    Color.Rgb("56D364"),
                    Color.Rgb("E3B341"),
                    Color.Rgb("FF7B72"),
                    Color.Rgb("D2A8FF"),
                    Color.Rgb("F0C674"),
                    Color.Rgb("FFA657"),
                    Color.Rgb("8CC278"),
                    Color.Rgb("79C0FF"),
                    Color.Rgb("A5D6FF"),
                    Color.Rgb("B5E890"),
                    0x79B8FF,
                    0x161B22
                )
            )
            list.Add(
                ReplPalette(
                    "mono",
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault,
                    Color.TerminalDefault
                )
            )
            list.Add(
                ReplPalette(
                    "high-contrast",
                    Color.Rgb("FFFFFF"),
                    Color.Rgb("E6E6E6"),
                    Color.Rgb("C8C8C8"),
                    Color.Rgb("66F2FF"),
                    Color.Rgb("000000"),
                    Color.Rgb("0A0A0A"),
                    Color.Rgb("141414"),
                    Color.Rgb("FFFFFF"),
                    Color.Rgb("FFFFFF"),
                    Color.Rgb("004C7A"),
                    Color.Rgb("12263A"),
                    Color.Rgb("5CFFAD"),
                    Color.Rgb("FFF066"),
                    Color.Rgb("FF8FA0"),
                    Color.Rgb("70F0FF"),
                    Color.Rgb("FFE082"),
                    Color.Rgb("FFB74D"),
                    Color.Rgb("C8C8C8"),
                    Color.Rgb("99FAFF"),
                    Color.Rgb("FF99EC"),
                    Color.Rgb("B9FF99"),
                    0x66F2FF,
                    0x0A0A0A
                )
            )
            list.Add(
                ReplPalette(
                    "colorblind",
                    Color.Rgb("F2F5F8"),
                    Color.Rgb("C2CBD3"),
                    Color.Rgb("9AA6B2"),
                    Color.Rgb("6EC6FF"),
                    Color.Rgb("0E1318"),
                    Color.Rgb("151C23"),
                    Color.Rgb("1D2630"),
                    Color.Rgb("4C5C68"),
                    Color.Rgb("FFFFFF"),
                    Color.Rgb("1B4965"),
                    Color.Rgb("162736"),
                    Color.Rgb("3AD6A8"),
                    Color.Rgb("F5B841"),
                    Color.Rgb("FF8A5B"),
                    Color.Rgb("6EC6FF"),
                    Color.Rgb("F7E869"),
                    Color.Rgb("F5B841"),
                    Color.Rgb("9AA6B2"),
                    Color.Rgb("E89CC8"),
                    Color.Rgb("91D5FF"),
                    Color.Rgb("4CE0B3"),
                    0x6EC6FF,
                    0x151C23
                )
            )
            return list
        }
    }
}
