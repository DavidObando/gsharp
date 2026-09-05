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

    /// <summary>
    /// Resolves a repository source path that survives the cs2gs
    /// self-migration corpus, where every translated project file is renamed
    /// <c>X.csproj</c> to <c>X.gsproj</c> and every translated source file is
    /// renamed <c>X.cs</c> to <c>X.gs</c>. Layout assertions are about the
    /// repository's shape, not about which language the file happens to be
    /// written in, so they must find the file under either name.
    /// </summary>
    /// <param name="path">The C# spelling of the path.</param>
    /// <returns>
    /// <paramref name="path"/> when it exists, otherwise the migrated sibling.
    /// </returns>
    public static string ResolveSourcePath(string path)
    {
        if (File.Exists(path))
        {
            return path;
        }

        var migrated = MigratedSpelling(path);
        return File.Exists(migrated) ? migrated : path;
    }

    private static string MigratedSpelling(string path)
    {
        if (path.EndsWith(".csproj", StringComparison.Ordinal))
        {
            return path.Substring(0, path.Length - ".csproj".Length) + ".gsproj";
        }

        if (path.EndsWith(".cs", StringComparison.Ordinal))
        {
            return path.Substring(0, path.Length - ".cs".Length) + ".gs";
        }

        return path;
    }

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
