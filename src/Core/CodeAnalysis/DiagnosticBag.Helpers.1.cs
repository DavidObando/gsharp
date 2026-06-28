// <copyright file="DiagnosticBag.Helpers.1.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis;

/// <summary>
/// Represents a collection of code analysis diagnostics information.
/// </summary>

public sealed partial class DiagnosticBag : IEnumerable<Diagnostic>
{


    /// <summary>
    /// Removes every diagnostic added after the bag reached <paramref name="count"/>
    /// entries, restoring it to an earlier marked state. Used to roll back the
    /// speculative diagnostics produced while eagerly binding an expression that
    /// will be re-bound against a now-known target type.
    /// </summary>
    /// <param name="count">The diagnostic count to truncate back to. Values
    /// outside the current range are clamped.</param>
    public void TruncateTo(int count)
    {
        if (count < 0)
        {
            count = 0;
        }

        if (count < diagnostics.Count)
        {
            diagnostics.RemoveRange(count, diagnostics.Count - count);
        }
    }

    /// <summary>
    /// Adds a sequence of already-constructed diagnostics into this instance.
    /// Used to surface inner diagnostics (e.g. an interpolation hole's syntax
    /// errors) whose locations have already been mapped to the outer file.
    /// </summary>
    /// <param name="diagnostics">The diagnostics to copy in.</param>
    public void AddRange(IEnumerable<Diagnostic> diagnostics)
    {
        this.diagnostics.AddRange(diagnostics);
    }

    private static string FormatMissingNames(IEnumerable<string> missingNames)
    {
        var displayed = new List<string>();
        var count = 0;
        foreach (var name in missingNames)
        {
            if (count < 3)
            {
                displayed.Add($"'{name}'");
            }

            count++;
        }

        if (count > 3)
        {
            displayed.Add("…");
        }

        return string.Join(", ", displayed);
    }
}
