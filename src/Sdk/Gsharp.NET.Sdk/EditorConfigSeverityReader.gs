// <copyright file="EditorConfigSeverityReader.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.NET.Sdk.Tools

import System
import System.Collections.Generic
import System.IO
import System.Linq

/// Lowers `.editorconfig` diagnostic-severity configuration to gsc's
/// `/gsdiag:` switch (ADR-0169). Reads
/// `dotnet_diagnostic.<ID>.severity = <value>` entries from the
/// `.editorconfig` chain above the project directory — root-first, so a
/// deeper file overrides its ancestors, matching editorconfig semantics — and
/// maps Roslyn severity names onto gsc's (`suggestion` → `info`,
/// `silent` → `hidden`). Only sections that can apply to `.gs`
/// files are honored: `[*]`, `[*.gs]`, and brace lists mentioning
/// `gs`. gsc stays editorconfig-unaware by design.
internal shared class EditorConfigSeverityReader {
    /// Reads the effective `dotnet_diagnostic` severities for
    /// [`projectDirectory`](paramref).
    /// @param projectDirectory The project directory the chain starts from.
    /// @returns Diagnostic ID → gsc severity (`none|hidden|info|warning|error`), in override order.
    func ReadSeverities(projectDirectory string) IReadOnlyDictionary[string, string] {
        let chain = List[string]()
        var directory DirectoryInfo? = DirectoryInfo(Path.GetFullPath(projectDirectory))
        while directory != nil {
            let candidate = Path.Combine(directory.FullName, ".editorconfig")
            if File.Exists(candidate) {
                chain.Add(candidate!!)
                if IsRoot(candidate!!) {
                    break
                }
            }
            directory = directory.Parent
        }
        // Apply root-first so nearer files override.
        chain.Reverse()
        let severities = Dictionary[string, string](StringComparer.OrdinalIgnoreCase)
        for file in chain {
            ParseFile(file, severities)
        }
        return severities
    }

    private func IsRoot(editorConfigPath string) bool {
        try {
            for raw in File.ReadLines(editorConfigPath)!! {
                let line = StripComment(RequireLine(editorConfigPath, raw))
                if line.StartsWith("[", StringComparison.Ordinal) {
                    break
                }
                let (key, value) = SplitKeyValue(line)
                if string.Equals(key, "root", StringComparison.OrdinalIgnoreCase) {
                    return string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)
                }
            }
        } catch (IOException) { }
        return false
    }

    private func ParseFile(editorConfigPath string, severities Dictionary[string, string]) {
        // The netstandard2.0 File.ReadAllLines result is oblivious. `!!` checks only the array.
        // Keep the elements nullable, and examine each element before its non-null use (#5413).
        var lines[]string?
        try {
            lines = File.ReadAllLines(editorConfigPath)!!
        } catch (IOException) {
            return
        }
        ParseLines(editorConfigPath, lines, severities)
    }

    /// Applies the `dotnet_diagnostic` severities of one `.editorconfig` file.
    /// @param editorConfigPath The file that supplied the lines.
    /// @param lines The lines of the file.
    /// @param severities The severities to update.
    func ParseLines(editorConfigPath string, lines[]string?, severities Dictionary[string, string]) {
        var sectionAppliesToGs = false
        for raw in lines {
            let line = StripComment(RequireLine(editorConfigPath, raw))
            if line.Length == 0 {
                continue
            }
            if line.StartsWith("[", StringComparison.Ordinal) && line.EndsWith("]", StringComparison.Ordinal) {
                sectionAppliesToGs = SectionAppliesToGs(line.Substring(1, line.Length - 2))
                continue
            }
            if !sectionAppliesToGs {
                continue
            }
            let (key, value) = SplitKeyValue(line)
            if key == nil || value == nil || !key.StartsWith(
                "dotnet_diagnostic.",
                StringComparison.OrdinalIgnoreCase
            ) ||
                !key.EndsWith(".severity", StringComparison.OrdinalIgnoreCase) {
                continue
            }
            let id = key.Substring(
                "dotnet_diagnostic.".Length,
                key.Length - "dotnet_diagnostic.".Length - ".severity".Length
            )
                .Trim()
            if id.Length == 0 {
                continue
            }
            let severity string? = MapSeverity(value)
            if severity != nil {
                severities[id] = severity
            }
        }
    }

    private func SectionAppliesToGs(pattern string) bool {
        var pattern = pattern
        pattern = pattern.Trim()
        if pattern == "*" || pattern == "**" || pattern == "**/*" {
            return true
        }
        // "*.gs", "**/*.gs", "*.{gs,cs}", "*.{cs, gs}" — anything whose
        // extension list mentions gs.
        let brace = pattern.IndexOf('{')
        if brace >= 0 && pattern.EndsWith("}", StringComparison.Ordinal) {
            return pattern
                .Substring(brace + 1, pattern.Length - brace - 2)
                .Split(',')
                .Any((ext string) -> string.Equals(ext.Trim(), "gs", StringComparison.OrdinalIgnoreCase))
        }
        return pattern.EndsWith(".gs", StringComparison.OrdinalIgnoreCase)
    }

    private func MapSeverity(value string) string? -> switch value.Trim().ToLowerInvariant() {
        case "none": "none"
        case "silent": "hidden"
        case "suggestion": "info"
        case "warning": "warning"
        case "error": "error"
        default: default(string?)
    }

    /// Returns a line of an `.editorconfig` file.
    /// A null line is not a normal parse result, so it stops the read.
    /// @param editorConfigPath The file that supplied the line.
    /// @param raw The line.
    /// @returns The non-null line.
    private func RequireLine(editorConfigPath string, raw string?) string ->
    raw ?? throw InvalidDataException("The .editorconfig file '$editorConfigPath' supplied a null line.")

    private func StripComment(line string) string {
        let comment = line.IndexOfAny([]char{'#', ';'})
        return (
            if comment >= 0 {
                line.Substring(0, comment)
            } else {
                line
            }
        ).Trim()
    }

    private func SplitKeyValue(line string)(Key string?, Value string?) {
        let equals = line.IndexOf('=')
        if equals <= 0 {
            return (nil, nil)
        }
        return (line.Substring(0, equals).Trim(), line.Substring(equals + 1).Trim())
    }
}
