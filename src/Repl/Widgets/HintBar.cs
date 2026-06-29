// <copyright file="HintBar.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Text;
using Spectre.Console;
using Spectre.Console.Rendering;

namespace GSharp.Repl.Widgets;

/// <summary>The pinned footer that shows contextual key bindings.</summary>
public sealed class HintBar
{
    private readonly List<(string Key, string Action)> hints = new();

    public string Separator { get; init; } = "·";

    public HintBar Add(string key, string? action)
    {
        if (!string.IsNullOrWhiteSpace(action))
        {
            hints.Add((key, action!));
        }

        return this;
    }

    public HintBar AddRange(IEnumerable<KeyValuePair<string, string?>> source)
    {
        ArgumentNullException.ThrowIfNull(source);
        foreach (var kv in source)
        {
            Add(kv.Key, kv.Value);
        }

        return this;
    }

    public IRenderable Render()
    {
        if (hints.Count == 0)
        {
            return new Markup(string.Empty);
        }

        var sb = new StringBuilder();
        for (var i = 0; i < hints.Count; i++)
        {
            if (i > 0)
            {
                sb.Append(' ').Append('[').Append(Tokens.Tokens.TextTertiary.Value.ToMarkup()).Append(']')
                  .Append(Markup.Escape(Separator)).Append("[/] ");
            }

            sb.Append('[').Append(Tokens.Tokens.Brand.Value.ToMarkup()).Append(']').Append(Markup.Escape(hints[i].Key)).Append("[/] ")
              .Append('[').Append(Tokens.Tokens.TextSecondary.Value.ToMarkup()).Append(']').Append(Markup.Escape(hints[i].Action)).Append("[/]");
        }

        return new Markup(sb.ToString());
    }
}
