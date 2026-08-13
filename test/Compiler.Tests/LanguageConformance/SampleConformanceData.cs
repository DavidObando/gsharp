// <copyright file="SampleConformanceData.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;

namespace GSharp.Tests.LanguageConformance;

internal static class SampleConformanceData
{
    public static IReadOnlyList<string> GetSingleFileSamples(string samplesDirectory)
        => Directory.EnumerateFiles(samplesDirectory, "*.gs", SearchOption.TopDirectoryOnly)
            .Where(path => File.Exists(Path.ChangeExtension(path, ".golden")))
            .Select(Path.GetFileName)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

    public static IReadOnlyList<string> GetMultiFileSamples(string samplesDirectory)
        => Directory.EnumerateDirectories(samplesDirectory)
            .Where(path => !string.Equals(
                Path.GetFileName(path),
                "aspirational",
                StringComparison.Ordinal))
            .Where(path =>
                File.Exists(Path.Combine(path, Path.GetFileName(path) + ".golden"))
                && Directory.EnumerateFiles(path, "*.gs").Any())
            .Select(path => Path.GetFileName(path) + "/")
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

    public static string LocateSamplesDirectory(Assembly testAssembly)
    {
        var directory = new DirectoryInfo(Path.GetDirectoryName(testAssembly.Location)!);
        while (directory != null)
        {
            var candidate = Path.Combine(directory.FullName, "samples");
            if (Directory.Exists(candidate)
                && File.Exists(Path.Combine(directory.FullName, "GSharp.sln")))
            {
                return candidate;
            }

            directory = directory.Parent;
        }

        return null;
    }

    public static string ReadNormalizedFile(string path)
        => NormalizeLineEndings(File.ReadAllText(path));

    public static string NormalizeLineEndings(string text)
        => text.ReplaceLineEndings("\n");
}
