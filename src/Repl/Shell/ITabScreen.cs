// <copyright file="ITabScreen.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using Spectre.Console.Rendering;

namespace GSharp.Repl.Shell;

/// <summary>A tab inside the <see cref="AppShell"/>.</summary>
public interface ITabScreen
{
    string Title { get; }

    char NumberKey { get; }

    IRenderable Render(int width, int height);

    bool HandleKey(ConsoleKeyInfo key);

    /// <summary>Handles a mouse-wheel scroll. Returns <c>true</c> if the event was consumed.</summary>
    bool HandleScroll(ScrollDirection direction, int lines) => false;

    IEnumerable<KeyValuePair<string, string?>> Hints => Array.Empty<KeyValuePair<string, string?>>();

    void OnActivated(IAppShellNavigator navigator)
    {
    }
}

/// <summary>Shell services exposed to screens.</summary>
public interface IAppShellNavigator
{
    void SwitchToTab(char numberKey);

    void ShowModal(IModal modal);

    void DismissModal();

    void ShowToast(string message);

    void RequestExit();
}

/// <summary>A modal overlay; receives keys until complete.</summary>
public interface IModal
{
    bool IsComplete { get; }

    void HandleKey(ConsoleKeyInfo key);

    IRenderable Render(int width, int height);
}
