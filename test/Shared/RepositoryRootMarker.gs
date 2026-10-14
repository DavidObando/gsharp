// <copyright file="RepositoryRootMarker.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Tests

import System.Collections.Generic
import System.IO

/// The one rule tests use to recognise the repository root (issue #4861).
/// A directory is the root when it holds the repository solution, spelled
/// `GSharp.sln` in the C# tree or `GSharp.slnx` after the cut-over to
/// G# (which keeps only the generated `.slnx`). Tests call this instead of
/// probing a literal file name, so the cut-over never has to rewrite them.
/// `tools/cs2gs/Cs2Gs.Pipeline/RepositoryRootMarker.cs` carries the same
/// rule for product code; a parity test keeps the two in step.
internal shared class RepositoryRootMarker {
    /// Gets the solution file names that anchor the repository root.
    internal prop SolutionFileNames IReadOnlyList[string] -> []string{"GSharp.slnx", "GSharp.sln"}

    internal func IsRoot(directory string) bool {
        for name in SolutionFileNames {
            if File.Exists(Path.Combine(directory, name)) {
                return true
            }
        }
        return false
    }
}
