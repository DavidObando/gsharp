// <copyright file="TestSource.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.IO;

namespace GSharp.Core.Tests;

internal static class TestSource
{
    // Same stage-4 contract as GsharpTestProjectRunner; these guards parse C#, not G#.
    internal const string SourceRootEnvironmentVariable = "CS2GS_TEST_SOURCE_ROOT";

    internal static string Root => FindRoot(
        Environment.GetEnvironmentVariable(SourceRootEnvironmentVariable),
        AppContext.BaseDirectory);

    internal static string FindRoot(string? configuredRoot, string startDirectory)
    {
        if (!string.IsNullOrWhiteSpace(configuredRoot))
        {
            var root = Path.GetFullPath(configuredRoot);
            if (IsSourceRoot(root))
            {
                return root;
            }

            throw new DirectoryNotFoundException(
                $"{SourceRootEnvironmentVariable} must name the original C# source tree: '{root}'.");
        }

        for (var directory = new DirectoryInfo(startDirectory); directory != null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "GSharp.sln")))
            {
                if (IsSourceRoot(directory.FullName))
                {
                    return directory.FullName;
                }

                break;
            }
        }

        throw new DirectoryNotFoundException(
            $"Could not find the original C# source tree. Set {SourceRootEnvironmentVariable}.");
    }

    private static bool IsSourceRoot(string root) =>
        File.Exists(Path.Combine(root, "GSharp.sln"))
        && File.Exists(Path.Combine(root, "src", "Core", "CodeAnalysis", "Syntax", "Parser.cs"));
}
