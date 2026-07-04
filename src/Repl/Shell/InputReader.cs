// <copyright file="InputReader.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Repl.Shell;

/// <summary>Direction of a mouse-wheel scroll.</summary>
public enum ScrollDirection
{
    Up,
    Down,
}

/// <summary>
/// A single terminal input event: either a key press or a mouse-wheel scroll. Exactly one of
/// <see cref="Key"/> or <see cref="Scroll"/> is set.
/// </summary>
public readonly struct InputEvent
{
    private InputEvent(ConsoleKeyInfo? key, ScrollDirection? scroll)
    {
        this.Key = key;
        this.Scroll = scroll;
    }

    /// <summary>Gets the key press, if this event is a key.</summary>
    public ConsoleKeyInfo? Key { get; }

    /// <summary>Gets the scroll direction, if this event is a mouse-wheel scroll.</summary>
    public ScrollDirection? Scroll { get; }

    public static InputEvent FromKey(ConsoleKeyInfo key) => new(key, null);

    public static InputEvent FromScroll(ScrollDirection direction) => new(null, direction);
}

/// <summary>Blocking source of terminal input events (keys and mouse wheel).</summary>
public interface IInputReader
{
    /// <summary>Blocks until the next input event, or returns <c>null</c> when input ends.</summary>
    InputEvent? Read();
}
