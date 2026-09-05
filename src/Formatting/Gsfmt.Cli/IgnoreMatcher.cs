// <copyright file="IgnoreMatcher.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace GSharp.Gsfmt;

internal static class IgnoreMatcher
{
    public static bool IsIgnored(string path)
    {
        string fullPath = Path.GetFullPath(path);
        if (fullPath.EndsWith(".g.gs", StringComparison.OrdinalIgnoreCase)
            || HasExcludedDirectory(fullPath))
        {
            return true;
        }

        var ignoreFiles = new Stack<string>();
        DirectoryInfo? directory = new FileInfo(fullPath).Directory;
        while (directory is not null)
        {
            string ignorePath = Path.Combine(directory.FullName, ".gsfmtignore");
            if (File.Exists(ignorePath))
            {
                ignoreFiles.Push(ignorePath);
            }

            directory = directory.Parent;
        }

        bool ignored = false;
        while (ignoreFiles.Count > 0)
        {
            string ignorePath = ignoreFiles.Pop();
            string root = Path.GetDirectoryName(ignorePath)
                ?? throw new InvalidOperationException("An ignore file must have a parent directory.");
            string relative = Path.GetRelativePath(root, fullPath).Replace('\\', '/');
            if (relative.StartsWith("../", StringComparison.Ordinal))
            {
                continue;
            }

            foreach (string rawLine in File.ReadLines(ignorePath))
            {
                string line = rawLine.Trim();
                if (line.Length == 0 || line[0] == '#')
                {
                    continue;
                }

                bool negated = line[0] == '!';
                if (negated)
                {
                    line = line.Substring(1);
                }

                if (line.Length > 0 && Matches(relative, line))
                {
                    ignored = !negated;
                }
            }
        }

        return ignored;
    }

    private static bool HasExcludedDirectory(string fullPath)
    {
        string[] segments = fullPath.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        foreach (string segment in segments)
        {
            if (segment is "bin" or "obj" or "out")
            {
                return true;
            }
        }

        return false;
    }

    private static bool Matches(string relativePath, string pattern)
    {
        bool directoryOnly = pattern.EndsWith("/", StringComparison.Ordinal);
        if (directoryOnly)
        {
            pattern = pattern.TrimEnd('/');
        }

        bool rooted = pattern.StartsWith("/", StringComparison.Ordinal);
        pattern = pattern.TrimStart('/');
        bool hasSlash = pattern.Contains('/', StringComparison.Ordinal);

        var regex = new StringBuilder();
        regex.Append(rooted || hasSlash ? "^" : "(^|.*/)");
        for (int i = 0; i < pattern.Length; i++)
        {
            char character = pattern[i];
            if (character == '*')
            {
                bool doubleStar = i + 1 < pattern.Length && pattern[i + 1] == '*';
                if (doubleStar)
                {
                    i++;
                    regex.Append(".*");
                }
                else
                {
                    regex.Append("[^/]*");
                }
            }
            else if (character == '?')
            {
                regex.Append("[^/]");
            }
            else
            {
                regex.Append(Regex.Escape(character.ToString()));
            }
        }

        regex.Append(directoryOnly ? "(/.*)?$" : "$");
        return Regex.IsMatch(relativePath, regex.ToString(), RegexOptions.CultureInvariant);
    }
}
