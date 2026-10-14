// <copyright file="HintBar.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Repl.Widgets

import GSharp.Repl.Tokens
import Spectre.Console
import Spectre.Console.Rendering
import System
import System.Collections.Generic
import System.Text

/// The pinned footer that shows contextual key bindings.
class HintBar {
    init() {
        Separator = "·"
    }

    private let hints List[(Key string, Action string)] = List[(Key string, Action string)]()

    prop Separator string {
        get;
        init;
    }

    func Add(key string, action string?) HintBar {
        if !string.IsNullOrWhiteSpace(action) {
            hints.Add((key, action))
        }
        return this
    }

    func AddRange(source IEnumerable[KeyValuePair[string, string?]]) HintBar {
        ArgumentNullException.ThrowIfNull(source, paramName: "source")
        for kv in source {
            Add(kv.Key, kv.Value)
        }
        return this
    }

    func Render() IRenderable {
        if hints.Count == 0 {
            return Markup(string.Empty)
        }
        let sb = StringBuilder()
        for var i = 0; i < hints.Count; i++ {
            if i > 0 {
                sb
                    .Append(' ')
                    .Append('[')
                    .Append(Tokens.TextTertiary.Value.ToMarkup())
                    .Append(']')
                    .Append(Markup.Escape(Separator))
                    .Append("[/] ")
            }
            sb
                .Append('[')
                .Append(Tokens.Brand.Value.ToMarkup())
                .Append(']')
                .Append(Markup.Escape(hints[i].Key))
                .Append("[/] ")
                .Append('[')
                .Append(Tokens.TextSecondary.Value.ToMarkup())
                .Append(']')
                .Append(Markup.Escape(hints[i].Action))
                .Append("[/]")
        }
        return Markup(sb.ToString())
    }
}
