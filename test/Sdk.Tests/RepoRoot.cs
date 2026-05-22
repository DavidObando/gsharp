// <copyright file="RepoRoot.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;

namespace GSharp.Sdk.Tests;

/// <summary>
/// Locates the repository root by walking up from the test assembly directory
/// until a folder containing <c>GSharp.sln</c> is found. This keeps the test
/// project free of build-time path injection.
/// </summary>
internal static class RepoRoot
{
    public static string Path { get; } = Find();

    public static string SdkSourceDir { get; } =
        System.IO.Path.Combine(Path, "src", "Sdk", "Gsharp.NET.Sdk");

    public static string TemplatesSourceDir { get; } =
        System.IO.Path.Combine(Path, "src", "Sdk", "Gsharp.Templates");

    public static string SamplesDir { get; } =
        System.IO.Path.Combine(Path, "samples");

    private static string Find()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(System.IO.Path.Combine(dir.FullName, "GSharp.sln")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        throw new InvalidOperationException(
            $"Could not locate GSharp.sln walking up from {AppContext.BaseDirectory}.");
    }
}
