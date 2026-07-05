// <copyright file="KnightRiderAnimation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Text;
using Spectre.Console;
using Spectre.Console.Rendering;

namespace GSharp.Repl.Widgets;

/// <summary>Glyph set used to render the scanner's dots.</summary>
public enum KnightRiderStyle
{
    Blocks,
    Diamonds,
}

/// <summary>An RGB color paired with an alpha (0-1) used for terminal-side blending.</summary>
public readonly record struct AlphaColor(Color Color, double Alpha)
{
    public static AlphaColor Opaque(Color color) => new(color, 1.0);
}

/// <summary>
/// C# port of the OpenCode TUI "Knight Rider" scanner spinner
/// (https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/ui/spinner.ts).
/// The original renders true RGBA over a GPU-composited terminal; Spectre.Console cells
/// have no alpha channel, so <see cref="Render"/> blends each dot's alpha against a
/// caller-supplied background color once per frame instead.
/// </summary>
public sealed class KnightRiderAnimation
{
    private static readonly AlphaColor[] DefaultTrail =
    {
        AlphaColor.Opaque(new Color(0xff, 0x00, 0x00)), // brightest red (center)
        AlphaColor.Opaque(new Color(0xff, 0x55, 0x55)), // glare/bloom
        AlphaColor.Opaque(new Color(0xdd, 0x00, 0x00)), // trail 1
        AlphaColor.Opaque(new Color(0xaa, 0x00, 0x00)), // trail 2
        AlphaColor.Opaque(new Color(0x77, 0x00, 0x00)), // trail 3
        AlphaColor.Opaque(new Color(0x44, 0x00, 0x00)), // trail 4
    };

    private static readonly AlphaColor DefaultInactive = AlphaColor.Opaque(new Color(0x33, 0x00, 0x00));

    private static readonly char[] DiamondShapes = { '⬥', '◆', '⬩', '⬪' };

    private readonly int width;
    private readonly KnightRiderStyle style;
    private readonly int holdStart;
    private readonly int holdEnd;
    private readonly AlphaColor[] trail;
    private readonly AlphaColor inactive;
    private readonly bool enableFading;
    private readonly double minAlpha;

    public KnightRiderAnimation(
        int width = 8,
        KnightRiderStyle style = KnightRiderStyle.Diamonds,
        int holdStart = 30,
        int holdEnd = 9,
        AlphaColor[]? colors = null,
        AlphaColor? defaultColor = null,
        bool enableFading = true,
        double minAlpha = 0)
    {
        this.width = Math.Max(1, width);
        this.style = style;
        this.holdStart = Math.Max(0, holdStart);
        this.holdEnd = Math.Max(0, holdEnd);
        trail = colors is { Length: > 0 } ? colors : DefaultTrail;
        inactive = defaultColor ?? DefaultInactive;
        this.enableFading = enableFading;
        this.minAlpha = Math.Clamp(minAlpha, 0, 1);

        // Bidirectional cycle: forward (width) + hold-end + backward (width-1) + hold-start.
        TotalFrames = this.width + this.holdEnd + (this.width - 1) + this.holdStart;
    }

    /// <summary>Total frames in one full sweep (there and back), including hold pauses.</summary>
    public int TotalFrames { get; }

    /// <summary>
    /// Derives a fading trail of alpha colors from a single bright color, matching
    /// <c>deriveTrailColors</c> in the original: full brightness at the head, a slight
    /// bloom on the second dot, then exponential alpha decay behind it.
    /// </summary>
    public static AlphaColor[] DeriveTrailColors(Color brightColor, int steps = 6)
    {
        var colors = new AlphaColor[Math.Max(1, steps)];
        for (var i = 0; i < colors.Length; i++)
        {
            double alpha;
            double brightness;
            if (i == 0)
            {
                alpha = 1.0;
                brightness = 1.0;
            }
            else if (i == 1)
            {
                alpha = 0.9;
                brightness = 1.15;
            }
            else
            {
                alpha = Math.Pow(0.65, i - 1);
                brightness = 1.0;
            }

            colors[i] = new AlphaColor(Scale(brightColor, brightness), alpha);
        }

        return colors;
    }

    /// <summary>Derives the inactive/off-dot color from a bright color via alpha, matching <c>deriveInactiveColor</c>.</summary>
    public static AlphaColor DeriveInactiveColor(Color brightColor, double factor = 0.2)
        => new(brightColor, Math.Clamp(factor, 0, 1));

    /// <summary>
    /// Renders one animation frame as a single line of colored glyphs, blended against
    /// <paramref name="background"/>. <paramref name="frameIndex"/> wraps modulo
    /// <see cref="TotalFrames"/>, so callers can pass an ever-incrementing tick counter.
    /// </summary>
    public IRenderable Render(int frameIndex, Color background)
        => new Markup(RenderMarkup(frameIndex, background));

    /// <summary>Same as <see cref="Render"/>, but returns the raw markup string for composing into a larger line.</summary>
    public string RenderMarkup(int frameIndex, Color background)
    {
        var frame = ((frameIndex % TotalFrames) + TotalFrames) % TotalFrames;
        var state = GetScannerState(frame);
        var fade = ComputeFade(state);

        var sb = new StringBuilder();
        for (var charIndex = 0; charIndex < width; charIndex++)
        {
            var colorIndex = CalculateColorIndex(charIndex, state);
            char glyph;
            Color color;
            if (colorIndex >= 0 && colorIndex < trail.Length)
            {
                var dot = trail[colorIndex];
                color = Blend(dot.Color, background, dot.Alpha);
                glyph = style == KnightRiderStyle.Diamonds
                    ? DiamondShapes[Math.Min(colorIndex, DiamondShapes.Length - 1)]
                    : '■';
            }
            else
            {
                color = Blend(inactive.Color, background, inactive.Alpha * fade);
                glyph = style == KnightRiderStyle.Diamonds ? '·' : '⬝';
            }

            sb.Append('[').Append(color.ToMarkup()).Append(']').Append(glyph).Append("[/]");
        }

        return sb.ToString();
    }

    /// <summary>Bidirectional scanner state at a given frame: where the head is, and whether it's holding at an end.</summary>
    private readonly record struct ScannerState(
        int ActivePosition,
        bool IsHolding,
        int HoldProgress,
        int HoldTotal,
        int MovementProgress,
        int MovementTotal,
        bool IsMovingForward);

    private ScannerState GetScannerState(int frameIndex)
    {
        var forwardFrames = width;
        var backwardFrames = width - 1;

        if (frameIndex < forwardFrames)
        {
            return new ScannerState(frameIndex, false, 0, 0, frameIndex, forwardFrames, true);
        }

        if (frameIndex < forwardFrames + holdEnd)
        {
            return new ScannerState(width - 1, true, frameIndex - forwardFrames, holdEnd, 0, 0, true);
        }

        if (frameIndex < forwardFrames + holdEnd + backwardFrames)
        {
            var backwardIndex = frameIndex - forwardFrames - holdEnd;
            return new ScannerState(width - 2 - backwardIndex, false, 0, 0, backwardIndex, backwardFrames, false);
        }

        return new ScannerState(
            0,
            true,
            frameIndex - forwardFrames - holdEnd - backwardFrames,
            holdStart,
            0,
            0,
            false);
    }

    private int CalculateColorIndex(int charIndex, ScannerState state)
    {
        var directionalDistance = state.IsMovingForward
            ? state.ActivePosition - charIndex
            : charIndex - state.ActivePosition;

        if (state.IsHolding)
        {
            return directionalDistance + state.HoldProgress;
        }

        if (directionalDistance > 0 && directionalDistance < trail.Length)
        {
            return directionalDistance;
        }

        if (directionalDistance == 0)
        {
            return 0;
        }

        return -1;
    }

    private double ComputeFade(ScannerState state)
    {
        if (!enableFading)
        {
            return 1.0;
        }

        if (state.IsHolding && state.HoldTotal > 0)
        {
            var progress = Math.Min((double)state.HoldProgress / state.HoldTotal, 1);
            return Math.Max(minAlpha, 1 - (progress * (1 - minAlpha)));
        }

        if (!state.IsHolding && state.MovementTotal > 0)
        {
            var progress = Math.Min(state.MovementProgress / (double)Math.Max(1, state.MovementTotal - 1), 1);
            return minAlpha + (progress * (1 - minAlpha));
        }

        return 1.0;
    }

    private static Color Scale(Color c, double factor)
        => new(
            (byte)Math.Min(255, c.R * factor),
            (byte)Math.Min(255, c.G * factor),
            (byte)Math.Min(255, c.B * factor));

    private static Color Blend(Color fg, Color bg, double alpha)
    {
        alpha = Math.Clamp(alpha, 0, 1);
        return new Color(
            (byte)((fg.R * alpha) + (bg.R * (1 - alpha))),
            (byte)((fg.G * alpha) + (bg.G * (1 - alpha))),
            (byte)((fg.B * alpha) + (bg.B * (1 - alpha))));
    }
}
