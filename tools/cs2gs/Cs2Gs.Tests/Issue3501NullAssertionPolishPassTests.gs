// <copyright file="Issue3501NullAssertionPolishPassTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import Xunit

/// Issue #3501 (!! reduction): the polish pass deletes exactly the GS0536
/// spans gsc reported, bottom-up so coordinates stay valid, verifying each
/// span holds `!!` before touching it.
class Issue3501NullAssertionPolishPassTests {
    @Fact
    func Strip_RemovesFlaggedSpans_BottomUp_AndVerifiesTokenText() {
        let directory = Path.Combine(
            Path.GetTempPath(),
            "Issue3501NullAssertionPolishPassTests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        let file = Path.Combine(directory, "Snippet.gs")
        try {
            File.WriteAllLines(file, []string{"func F(s string) string {", "    return s!! + s!!", "}"})
            let diagnostics = []GscDiagnostic{
                GscDiagnostic("GS0536", "Redundant '!!'…", "warning", file, 2, 13, 2, 15),
                GscDiagnostic("GS0536", "Redundant '!!'…", "warning", file, 2, 19, 2, 21),
                GscDiagnostic("GS0536", "Redundant '!!'…", "warning", file, 1, 6, 1, 8),
                GscDiagnostic("GS0100", "Not all code paths…", "error", file, 3, 1, 3, 2)
            }
            let stripped = NullAssertionPolishPass.Strip(diagnostics, []string{file})
            Assert.Equal(2, stripped)
            Assert.Equal([]string{"func F(s string) string {", "    return s + s", "}"}, File.ReadAllLines(file))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func Strip_PolishesDependencyFilesUnderTheStrippableRoot() {
        let root = Path.Combine(
            Path.GetTempPath(),
            "Issue3501NullAssertionPolishPassTests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(Path.Combine(root, "Dep"))
        let owned = Path.Combine(root, "Owned.gs")
        let dependency = Path.Combine(root, "Dep", "Sibling.gs")
        let outside = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".gs")
        try {
            File.WriteAllLines(owned, []string{"let a = b!!"})
            File.WriteAllLines(dependency, []string{"let c = d!!"})
            File.WriteAllLines(outside, []string{"let e = f!!"})
            let diagnostics = []GscDiagnostic{
                GscDiagnostic("GS0536", "Redundant '!!'…", "warning", dependency, 1, 10, 1, 12),
                GscDiagnostic("GS0536", "Redundant '!!'…", "warning", outside, 1, 10, 1, 12)
            }
            Assert.Equal(
                []string{dependency},
                NullAssertionPolishPass.CandidateFiles(diagnostics, []string{owned}, root)
            )
            let stripped = NullAssertionPolishPass.Strip(diagnostics, []string{owned}, root)
            Assert.Equal(1, stripped)
            Assert.Equal([]string{"let c = d"}, File.ReadAllLines(dependency))
            Assert.Equal([]string{"let e = f!!"}, File.ReadAllLines(outside))
        } finally {
            Directory.Delete(root, recursive: true)
            File.Delete(outside)
        }
    }

    @Fact
    func Strip_IgnoresFilesOutsideTheEmittedSet() {
        let directory = Path.Combine(
            Path.GetTempPath(),
            "Issue3501NullAssertionPolishPassTests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        let owned = Path.Combine(directory, "Owned.gs")
        let foreign = Path.Combine(directory, "Foreign.gs")
        try {
            File.WriteAllLines(owned, []string{"let a = b!!"})
            File.WriteAllLines(foreign, []string{"let a = b!!"})
            let diagnostics = []GscDiagnostic{
                GscDiagnostic("GS0536", "Redundant '!!'…", "warning", foreign, 1, 10, 1, 12)
            }
            let stripped = NullAssertionPolishPass.Strip(diagnostics, []string{owned})
            Assert.Equal(0, stripped)
            Assert.Equal([]string{"let a = b!!"}, File.ReadAllLines(foreign))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }
}
