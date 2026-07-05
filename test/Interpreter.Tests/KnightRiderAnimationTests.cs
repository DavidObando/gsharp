// <copyright file="KnightRiderAnimationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using GSharp.Repl.Widgets;
using Spectre.Console;
using Xunit;

namespace GSharp.Interpreter.Tests;

public class KnightRiderAnimationTests
{
    [Fact]
    public void TotalFrames_MatchesBidirectionalSweepWithHolds()
    {
        var anim = new KnightRiderAnimation(width: 8, holdStart: 30, holdEnd: 9);

        // forward(8) + holdEnd(9) + backward(7) + holdStart(30) == 54.
        Assert.Equal(54, anim.TotalFrames);
    }

    [Fact]
    public void Render_ProducesOneGlyphPerCell_AndWrapsFrameIndex()
    {
        var anim = new KnightRiderAnimation(width: 8, style: KnightRiderStyle.Blocks, holdStart: 2, holdEnd: 2);
        var bg = new Color(0, 0, 0);

        var frame0 = RenderToText(anim.Render(0, bg));
        var wrapped = RenderToText(anim.Render(anim.TotalFrames, bg));

        // The active (head) position at frame 0 should render as the "on" glyph.
        Assert.Contains("■", frame0);

        // Frame N and frame 0 (mod TotalFrames) must render identically.
        Assert.Equal(frame0, wrapped);
    }

    [Fact]
    public void DeriveTrailColors_FadesHeadToTail()
    {
        var colors = KnightRiderAnimation.DeriveTrailColors(new Color(255, 0, 0), steps: 4);

        Assert.Equal(4, colors.Length);
        Assert.Equal(1.0, colors[0].Alpha);

        // Alpha should trend downward moving away from the head (after the bloom dot).
        Assert.True(colors[2].Alpha > colors[3].Alpha);
    }

    private static string RenderToText(Spectre.Console.Rendering.IRenderable renderable)
    {
        var sw = new StringWriter();
        var console = AnsiConsole.Create(new AnsiConsoleSettings
        {
            Ansi = AnsiSupport.No,
            ColorSystem = ColorSystemSupport.NoColors,
            Out = new AnsiConsoleOutput(sw),
        });
        console.Write(renderable);
        return sw.ToString();
    }
}
