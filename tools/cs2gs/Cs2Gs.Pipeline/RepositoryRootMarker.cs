// <copyright file="RepositoryRootMarker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;

namespace Cs2Gs.Pipeline;

/// <summary>
/// The one rule cs2gs uses to recognise the repository root (issue #4861). A
/// directory is the root when it holds the repository solution, spelled
/// <c>GSharp.sln</c> in the C# tree or <c>GSharp.slnx</c> after the cut-over to
/// G# (which keeps only the generated <c>.slnx</c>).
/// <c>test/Shared/RepositoryRootMarker.cs</c> carries the same rule for the test
/// projects; a parity test keeps the two in step.
/// </summary>
public static class RepositoryRootMarker
{
    /// <summary>Gets the solution file names that anchor the repository root.</summary>
    public static IReadOnlyList<string> SolutionFileNames => new[] { "GSharp.slnx", "GSharp.sln" };

    /// <summary>Returns whether <paramref name="directory"/> holds the repository solution.</summary>
    /// <param name="directory">The directory to probe.</param>
    /// <returns>True when a solution file is present.</returns>
    public static bool IsRoot(string directory)
    {
        foreach (string name in SolutionFileNames)
        {
            if (File.Exists(Path.Combine(directory, name)))
            {
                return true;
            }
        }

        return false;
    }
}
