// <copyright file="EditorConfigSeverityReader.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Gsharp.NET.Sdk.Tools;

/// <summary>
/// Lowers <c>.editorconfig</c> diagnostic-severity configuration to gsc's
/// <c>/gsdiag:</c> switch (ADR-0169). Reads
/// <c>dotnet_diagnostic.&lt;ID&gt;.severity = &lt;value&gt;</c> entries from the
/// <c>.editorconfig</c> chain above the project directory — root-first, so a
/// deeper file overrides its ancestors, matching editorconfig semantics — and
/// maps Roslyn severity names onto gsc's (<c>suggestion</c> → <c>info</c>,
/// <c>silent</c> → <c>hidden</c>). Only sections that can apply to <c>.gs</c>
/// files are honored: <c>[*]</c>, <c>[*.gs]</c>, and brace lists mentioning
/// <c>gs</c>. gsc stays editorconfig-unaware by design.
/// </summary>
internal static class EditorConfigSeverityReader
{
    /// <summary>
    /// Reads the effective <c>dotnet_diagnostic</c> severities for
    /// <paramref name="projectDirectory"/>.
    /// </summary>
    /// <param name="projectDirectory">The project directory the chain starts from.</param>
    /// <returns>Diagnostic ID → gsc severity (<c>none|hidden|info|warning|error</c>), in override order.</returns>
    public static IReadOnlyDictionary<string, string> ReadSeverities(string projectDirectory)
    {
        var chain = new List<string>();
        var directory = new DirectoryInfo(Path.GetFullPath(projectDirectory));
        while (directory is not null)
        {
            var candidate = Path.Combine(directory.FullName, ".editorconfig");
            if (File.Exists(candidate))
            {
                chain.Add(candidate);
                if (IsRoot(candidate))
                {
                    break;
                }
            }

            directory = directory.Parent;
        }

        // Apply root-first so nearer files override.
        chain.Reverse();

        var severities = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in chain)
        {
            ParseFile(file, severities);
        }

        return severities;
    }

    private static bool IsRoot(string editorConfigPath)
    {
        try
        {
            foreach (var raw in File.ReadLines(editorConfigPath))
            {
                var line = StripComment(raw);
                if (line.StartsWith("[", StringComparison.Ordinal))
                {
                    break;
                }

                var (key, value) = SplitKeyValue(line);
                if (string.Equals(key, "root", StringComparison.OrdinalIgnoreCase))
                {
                    return string.Equals(value, "true", StringComparison.OrdinalIgnoreCase);
                }
            }
        }
        catch (IOException)
        {
        }

        return false;
    }

    private static void ParseFile(string editorConfigPath, Dictionary<string, string> severities)
    {
        string[] lines;
        try
        {
            lines = File.ReadAllLines(editorConfigPath);
        }
        catch (IOException)
        {
            return;
        }

        var sectionAppliesToGs = false;
        foreach (var raw in lines)
        {
            var line = StripComment(raw);
            if (line.Length == 0)
            {
                continue;
            }

            if (line.StartsWith("[", StringComparison.Ordinal) && line.EndsWith("]", StringComparison.Ordinal))
            {
                sectionAppliesToGs = SectionAppliesToGs(line.Substring(1, line.Length - 2));
                continue;
            }

            if (!sectionAppliesToGs)
            {
                continue;
            }

            var (key, value) = SplitKeyValue(line);
            if (key is null || value is null
                || !key.StartsWith("dotnet_diagnostic.", StringComparison.OrdinalIgnoreCase)
                || !key.EndsWith(".severity", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var id = key.Substring("dotnet_diagnostic.".Length, key.Length - "dotnet_diagnostic.".Length - ".severity".Length).Trim();
            if (id.Length == 0)
            {
                continue;
            }

            var severity = MapSeverity(value);
            if (severity is not null)
            {
                severities[id] = severity;
            }
        }
    }

    private static bool SectionAppliesToGs(string pattern)
    {
        pattern = pattern.Trim();
        if (pattern == "*" || pattern == "**" || pattern == "**/*")
        {
            return true;
        }

        // "*.gs", "**/*.gs", "*.{gs,cs}", "*.{cs, gs}" — anything whose
        // extension list mentions gs.
        var brace = pattern.IndexOf('{');
        if (brace >= 0 && pattern.EndsWith("}", StringComparison.Ordinal))
        {
            return pattern.Substring(brace + 1, pattern.Length - brace - 2)
                .Split(',')
                .Any(ext => string.Equals(ext.Trim(), "gs", StringComparison.OrdinalIgnoreCase));
        }

        return pattern.EndsWith(".gs", StringComparison.OrdinalIgnoreCase);
    }

    private static string? MapSeverity(string value) => value.Trim().ToLowerInvariant() switch
    {
        "none" => "none",
        "silent" => "hidden",
        "suggestion" => "info",
        "warning" => "warning",
        "error" => "error",
        _ => null,
    };

    private static string StripComment(string line)
    {
        var comment = line.IndexOfAny(new[] { '#', ';' });
        return (comment >= 0 ? line.Substring(0, comment) : line).Trim();
    }

    private static (string? Key, string? Value) SplitKeyValue(string line)
    {
        var equals = line.IndexOf('=');
        if (equals <= 0)
        {
            return (null, null);
        }

        return (line.Substring(0, equals).Trim(), line.Substring(equals + 1).Trim());
    }
}
