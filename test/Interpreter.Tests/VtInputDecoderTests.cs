// <copyright file="VtInputDecoderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text;
using GSharp.Repl.Shell;
using Xunit;

namespace GSharp.Interpreter.Tests;

public class VtInputDecoderTests
{
    private static VtInputDecoder ForBytes(params byte[] bytes)
    {
        var queue = new Queue<byte>(bytes);
        int ReadByte() => queue.Count > 0 ? queue.Dequeue() : -1;
        bool HasInput(int _) => queue.Count > 0;
        return new VtInputDecoder(ReadByte, HasInput);
    }

    private static VtInputDecoder ForText(string ascii) => ForBytes(Encoding.ASCII.GetBytes(ascii));

    [Fact]
    public void DecodesEnter()
    {
        var e = ForBytes(0x0d).Next();
        Assert.Equal(ConsoleKey.Enter, e!.Value.Key!.Value.Key);
    }

    [Fact]
    public void DecodesLineFeedAsEnter()
    {
        var e = ForBytes(0x0a).Next();
        Assert.Equal(ConsoleKey.Enter, e!.Value.Key!.Value.Key);
    }

    [Fact]
    public void DecodesTab()
    {
        var e = ForBytes(0x09).Next();
        Assert.Equal(ConsoleKey.Tab, e!.Value.Key!.Value.Key);
    }

    [Fact]
    public void DecodesBackspaceDel()
    {
        Assert.Equal(ConsoleKey.Backspace, ForBytes(0x7f).Next()!.Value.Key!.Value.Key);
        Assert.Equal(ConsoleKey.Backspace, ForBytes(0x08).Next()!.Value.Key!.Value.Key);
    }

    [Fact]
    public void DecodesLoneEscapeWhenNoFollowup()
    {
        var e = ForBytes(0x1b).Next();
        Assert.Equal(ConsoleKey.Escape, e!.Value.Key!.Value.Key);
    }

    [Theory]
    [InlineData('A', ConsoleKey.UpArrow)]
    [InlineData('B', ConsoleKey.DownArrow)]
    [InlineData('C', ConsoleKey.RightArrow)]
    [InlineData('D', ConsoleKey.LeftArrow)]
    [InlineData('H', ConsoleKey.Home)]
    [InlineData('F', ConsoleKey.End)]
    public void DecodesArrows(char final, ConsoleKey expected)
    {
        var e = ForBytes(0x1b, (byte)'[', (byte)final).Next();
        Assert.Equal(expected, e!.Value.Key!.Value.Key);
    }

    [Fact]
    public void DecodesShiftTab()
    {
        var e = ForBytes(0x1b, (byte)'[', (byte)'Z').Next();
        Assert.Equal(ConsoleKey.Tab, e!.Value.Key!.Value.Key);
        Assert.True(e.Value.Key!.Value.Modifiers.HasFlag(ConsoleModifiers.Shift));
    }

    [Fact]
    public void DecodesCtrlUpWithModifier()
    {
        // ESC [ 1 ; 5 A  => Ctrl+Up
        var e = ForText("\u001b[1;5A").Next();
        Assert.Equal(ConsoleKey.UpArrow, e!.Value.Key!.Value.Key);
        Assert.True(e.Value.Key!.Value.Modifiers.HasFlag(ConsoleModifiers.Control));
    }

    [Fact]
    public void DecodesPageUpAndPageDown()
    {
        Assert.Equal(ConsoleKey.PageUp, ForText("\u001b[5~").Next()!.Value.Key!.Value.Key);
        Assert.Equal(ConsoleKey.PageDown, ForText("\u001b[6~").Next()!.Value.Key!.Value.Key);
    }

    [Fact]
    public void DecodesF1ViaSs3()
    {
        var e = ForText("\u001bOP").Next();
        Assert.Equal(ConsoleKey.F1, e!.Value.Key!.Value.Key);
    }

    [Fact]
    public void DecodesCtrlK()
    {
        var e = ForBytes(0x0b).Next();
        Assert.Equal(ConsoleKey.K, e!.Value.Key!.Value.Key);
        Assert.True(e.Value.Key!.Value.Modifiers.HasFlag(ConsoleModifiers.Control));
    }

    [Fact]
    public void DecodesCtrlC()
    {
        var e = ForBytes(0x03).Next();
        Assert.Equal(ConsoleKey.C, e!.Value.Key!.Value.Key);
        Assert.True(e.Value.Key!.Value.Modifiers.HasFlag(ConsoleModifiers.Control));
    }

    [Fact]
    public void DecodesCtrlSpace()
    {
        var e = ForBytes(0x00).Next();
        Assert.Equal(ConsoleKey.Spacebar, e!.Value.Key!.Value.Key);
        Assert.True(e.Value.Key!.Value.Modifiers.HasFlag(ConsoleModifiers.Control));
    }

    [Fact]
    public void DecodesLowercaseLetter()
    {
        var e = ForText("a").Next();
        Assert.Equal(ConsoleKey.A, e!.Value.Key!.Value.Key);
        Assert.Equal('a', e.Value.Key!.Value.KeyChar);
        Assert.False(e.Value.Key!.Value.Modifiers.HasFlag(ConsoleModifiers.Shift));
    }

    [Fact]
    public void DecodesUppercaseLetterWithShift()
    {
        var e = ForText("Q").Next();
        Assert.Equal(ConsoleKey.Q, e!.Value.Key!.Value.Key);
        Assert.Equal('Q', e.Value.Key!.Value.KeyChar);
        Assert.True(e.Value.Key!.Value.Modifiers.HasFlag(ConsoleModifiers.Shift));
    }

    [Fact]
    public void DecodesDigitAndSlash()
    {
        Assert.Equal('5', ForText("5").Next()!.Value.Key!.Value.KeyChar);
        Assert.Equal('/', ForText("/").Next()!.Value.Key!.Value.KeyChar);
    }

    [Fact]
    public void DecodesUtf8MultibyteChar()
    {
        // 'é' == U+00E9 == 0xC3 0xA9
        var e = ForBytes(0xc3, 0xa9).Next();
        Assert.Equal('é', e!.Value.Key!.Value.KeyChar);
    }

    [Fact]
    public void DecodesSgrWheelUp()
    {
        var e = ForText("\u001b[<64;10;5M").Next();
        Assert.NotNull(e!.Value.Scroll);
        Assert.Equal(ScrollDirection.Up, e.Value.Scroll!.Value);
    }

    [Fact]
    public void DecodesSgrWheelDown()
    {
        var e = ForText("\u001b[<65;10;5M").Next();
        Assert.NotNull(e!.Value.Scroll);
        Assert.Equal(ScrollDirection.Down, e.Value.Scroll!.Value);
    }

    [Fact]
    public void SkipsNonWheelSgrMouseThenDecodesKey()
    {
        // A left-button press (button 0, no wheel bit) followed by 'a'.
        var e = ForText("\u001b[<0;10;5Ma").Next();
        Assert.Equal(ConsoleKey.A, e!.Value.Key!.Value.Key);
    }

    [Fact]
    public void DecodesLegacyWheelUp()
    {
        // ESC [ M, then button (64+32=96), col, row.
        var e = ForBytes(0x1b, (byte)'[', (byte)'M', 96, 33, 33).Next();
        Assert.Equal(ScrollDirection.Up, e!.Value.Scroll!.Value);
    }

    [Fact]
    public void ReturnsNullAtEndOfInput()
    {
        Assert.Null(ForBytes().Next());
    }
}
