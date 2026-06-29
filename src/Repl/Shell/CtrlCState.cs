// <copyright file="CtrlCState.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Repl.Shell;

/// <summary>Progressive Ctrl+C: first press prompts, second within the window quits.</summary>
public sealed class CtrlCState
{
    public TimeSpan ExitWindow { get; init; } = TimeSpan.FromSeconds(2);

    private readonly Func<DateTimeOffset> clock;
    private DateTimeOffset? promptShownAt;

    public CtrlCState(Func<DateTimeOffset>? clock = null)
    {
        this.clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    public bool ToastActive => promptShownAt is { } at && clock() - at <= ExitWindow;

    public CtrlCAction OnPress()
    {
        var now = clock();
        if (promptShownAt is { } at && now - at <= ExitWindow)
        {
            promptShownAt = null;
            return CtrlCAction.Exit;
        }

        promptShownAt = now;
        return CtrlCAction.PromptToExit;
    }

    public void Reset() => promptShownAt = null;
}

public enum CtrlCAction
{
    PromptToExit,
    Exit,
}
