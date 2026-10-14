// <copyright file="RepositoryRootMarker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System.Collections.Generic
import System.IO

/// The one rule cs2gs uses to recognise the repository root (issue #4861). A
/// directory is the root when it holds the repository solution, spelled
/// `GSharp.sln` in the C# tree or `GSharp.slnx` after the cut-over to
/// G# (which keeps only the generated `.slnx`).
/// `test/Shared/RepositoryRootMarker.cs` carries the same rule for the test
/// projects; a parity test keeps the two in step.
shared class RepositoryRootMarker {
    /// Gets the solution file names that anchor the repository root.
    prop SolutionFileNames IReadOnlyList[string] -> []string{"GSharp.slnx", "GSharp.sln"}

    /// Returns whether [`directory`](paramref) holds the repository solution.
    /// @param directory The directory to probe.
    /// @returns True when a solution file is present.
    func IsRoot(directory string?) bool {
        for name in SolutionFileNames {
            if File.Exists(Path.Combine(directory!!, name)) {
                return true
            }
        }
        return false
    }
}
