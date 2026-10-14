// <copyright file="InputReader.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Shell

import System

/// Direction of a mouse-wheel scroll.
enum ScrollDirection {
    Up,
    Down
}

/// A single terminal input event: either a key press or a mouse-wheel scroll. Exactly one of
/// (cref:Key) or (cref:Scroll) is set.
struct InputEvent {
    private init(key ConsoleKeyInfo?, scroll ScrollDirection?) {
        this.Key = key
        this.Scroll = scroll
    }

    /// Gets the key press, if this event is a key.
    prop Key ConsoleKeyInfo? {
        get;
    }

    /// Gets the scroll direction, if this event is a mouse-wheel scroll.
    prop Scroll ScrollDirection? {
        get;
    }

    shared {
        func FromKey(key ConsoleKeyInfo) InputEvent -> InputEvent(key, nil)

        func FromScroll(direction ScrollDirection) InputEvent -> InputEvent(nil, direction)
    }
}

/// Blocking source of terminal input events (keys and mouse wheel).
interface IInputReader {
    /// Blocks until the next input event, or returns `null` when input ends.
    func Read() InputEvent?;

    /// Blocks until the next input event, end of input, or [`timeout`](paramref) elapses.
    /// Set [`timedOut`](paramref) to distinguish a timeout (no event, input still open —
    /// used to drive idle animation ticks such as the eval spinner) from end of input.
    func Read(timeout TimeSpan, out timedOut bool) InputEvent? {
        timedOut = false
        return Read()
    }
}
