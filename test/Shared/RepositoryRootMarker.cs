// <copyright file="RepositoryRootMarker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;

namespace GSharp.Tests;

/// <summary>
/// The one rule tests use to recognise the repository root (issue #4861).
/// A directory is the root when it holds the repository solution, spelled
/// <c>GSharp.sln</c> in the C# tree or <c>GSharp.slnx</c> after the cut-over to
/// G# (which keeps only the generated <c>.slnx</c>). Tests call this instead of
/// probing a literal file name, so the cut-over never has to rewrite them.
/// <c>tools/cs2gs/Cs2Gs.Pipeline/RepositoryRootMarker.cs</c> carries the same
/// rule for product code; a parity test keeps the two in step.
/// </summary>
internal static class RepositoryRootMarker
{
    /// <summary>Gets the solution file names that anchor the repository root.</summary>
    internal static IReadOnlyList<string> SolutionFileNames => new[] { "GSharp.slnx", "GSharp.sln" };

    internal static bool IsRoot(string directory)
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
