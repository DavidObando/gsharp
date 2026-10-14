// <copyright file="IgnoreMatcher.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Gsfmt

import System
import System.Collections.Generic
import System.IO
import System.Text
import System.Text.RegularExpressions

internal shared class IgnoreMatcher {
    func IsIgnored(path string, searchRoot string) bool {
        let fullPath = Path.GetFullPath(path)
        if fullPath.EndsWith(".g.gs", StringComparison.OrdinalIgnoreCase) ||
            HasExcludedDirectory(Path.GetRelativePath(Path.GetFullPath(searchRoot), fullPath)) {
            return true
        }
        let ignoreFiles = Stack[string]()
        var directory DirectoryInfo? = FileInfo(fullPath).Directory
        while directory != nil {
            let ignorePath = Path.Combine(directory.FullName, ".gsfmtignore")
            if File.Exists(ignorePath) {
                ignoreFiles.Push(ignorePath)
            }
            directory = directory.Parent
        }
        var ignored = false
        while ignoreFiles.Count > 0 {
            let ignorePath = ignoreFiles.Pop()
            let root = Path.GetDirectoryName(ignorePath) ??
                throw InvalidOperationException("An ignore file must have a parent directory.")
            let relative = Path.GetRelativePath(root, fullPath).Replace('\\', '/')
            if relative.StartsWith("../", StringComparison.Ordinal) {
                continue
            }
            for rawLine in File.ReadLines(ignorePath) {
                var line = rawLine.Trim()
                if line.Length == 0 || line[0] == '#' {
                    continue
                }
                let negated = line[0] == '!'
                if negated {
                    line = line.Substring(1)
                }
                if line.Length > 0 && Matches(relative, line) {
                    ignored = !negated
                }
            }
        }
        return ignored
    }

    private func HasExcludedDirectory(relativePath string) bool {
        // Relative to the search root: a checkout that itself lives under a
        // directory called `out` must not have every file ignored, which would
        // turn `--check` into a silent pass.
        let segments = relativePath.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
        for segment in segments {
            if segment == "bin" || segment == "obj" || segment == "out" {
                return true
            }
        }
        return false
    }

    private func Matches(relativePath string, pattern string) bool {
        var pattern = pattern
        let directoryOnly = pattern.EndsWith("/", StringComparison.Ordinal)
        if directoryOnly {
            pattern = pattern.TrimEnd('/')
        }
        let rooted = pattern.StartsWith("/", StringComparison.Ordinal)
        pattern = pattern.TrimStart('/')
        let hasSlash = pattern.Contains('/', StringComparison.Ordinal)
        let regex = StringBuilder()
        regex.Append(
            if rooted || hasSlash {
                "^"
            } else {
                "(^|.*/)"
            }
        )
        for var i = 0; i < pattern.Length; i++ {
            let character = pattern[i]
            if character == '*' {
                let doubleStar = i + 1 < pattern.Length && pattern[i + 1] == '*'
                if doubleStar {
                    i++
                    regex.Append(".*")
                } else {
                    regex.Append("[^/]*")
                }
            } else if character == '?' {
                regex.Append("[^/]")
            } else {
                regex.Append(Regex.Escape(character.ToString()))
            }
        }
        regex.Append(
            if directoryOnly {
                "(/.*)?$$"
            } else {
                "$$"
            }
        )
        return Regex.IsMatch(relativePath, regex.ToString(), RegexOptions.CultureInvariant)
    }
}
