// <copyright file="KnightRiderAnimationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl.Widgets
import Spectre.Console
import Spectre.Console.Rendering
import System.IO
import Xunit

open class KnightRiderAnimationTests {
    @Fact
    func TotalFrames_MatchesBidirectionalSweepWithHolds() {
        let anim = KnightRiderAnimation(width: 8, holdStart: 30, holdEnd: 9)
        // forward(8) + holdEnd(9) + backward(7) + holdStart(30) == 54.
        Assert.Equal(54, anim.TotalFrames)
    }

    @Fact
    func Render_ProducesOneGlyphPerCell_AndWrapsFrameIndex() {
        let anim = KnightRiderAnimation(width: 8, style: KnightRiderStyle.Blocks, holdStart: 2, holdEnd: 2)
        let bg = Color(0, 0, 0)
        let frame0 = RenderToText(anim.Render(0, bg))
        let wrapped = RenderToText(anim.Render(anim.TotalFrames, bg))
        // The active (head) position at frame 0 should render as the "on" glyph.
        Assert.Contains("■", frame0)
        // Frame N and frame 0 (mod TotalFrames) must render identically.
        Assert.Equal(frame0, wrapped)
    }

    @Fact
    func DeriveTrailColors_FadesHeadToTail() {
        let colors = KnightRiderAnimation.DeriveTrailColors(Color(255, 0, 0), steps: 4)
        Assert.Equal(4, colors.Length)
        Assert.Equal(1.0, colors[0].Alpha)
        // Alpha should trend downward moving away from the head (after the bloom dot).
        Assert.True(colors[2].Alpha > colors[3].Alpha)
    }

    shared {
        private func RenderToText(renderable IRenderable) string {
            let sw = StringWriter()
            let console = AnsiConsole.Create(
                AnsiConsoleSettings{
                    Ansi: AnsiSupport.No,
                    ColorSystem: ColorSystemSupport.NoColors,
                    Out: AnsiConsoleOutput(sw)
                }
            )
            console.Write(renderable)
            return sw.ToString()
        }
    }
}
