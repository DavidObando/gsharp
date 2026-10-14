// <copyright file="ITabScreen.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Shell

import Spectre.Console.Rendering
import System
import System.Collections.Generic

/// A tab inside the (cref:AppShell).
interface ITabScreen {
    prop Title string {
        get;
    }

    prop NumberKey char {
        get;
    }

    func Render(width int32, height int32) IRenderable;

    func HandleKey(key ConsoleKeyInfo) bool;

    /// Handles a mouse-wheel scroll. Returns `true` if the event was consumed.
    func HandleScroll(direction ScrollDirection, lines int32) bool {
        return false
    }

    prop Hints IEnumerable[KeyValuePair[string, string?]] -> Array.Empty[KeyValuePair[string, string?]]()

    /// Optional right-aligned footer status markup (e.g. ready/error state). Null hides it.
    prop Status string? -> nil

    /// When set, replaces the left-hand hint bar in the footer (e.g. a busy spinner plus an
    /// interrupt hint). Null shows the default key-binding hints instead.
    prop FooterOverride IRenderable? -> nil

    /// Whether the screen is running a long operation (e.g. evaluating). Drives idle animation ticks.
    prop IsBusy bool -> false

    func OnActivated(navigator IAppShellNavigator) { }
}

/// Shell services exposed to screens.
interface IAppShellNavigator {
    func SwitchToTab(numberKey char);

    func ShowModal(modal IModal);

    func DismissModal();

    func ShowToast(message string);

    func RequestExit();
}

/// A modal overlay; receives keys until complete.
interface IModal {
    prop IsComplete bool {
        get;
    }

    func HandleKey(key ConsoleKeyInfo);

    func Render(width int32, height int32) IRenderable;
}
