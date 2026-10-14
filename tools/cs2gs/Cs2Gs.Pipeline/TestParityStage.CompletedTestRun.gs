// <copyright file="TestParityStage.CompletedTestRun.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System.Text.RegularExpressions

partial class TestParityStage : IMigrationStage {
    shared {
        /// Issue #2867: detects the VSTest run summary that only ever appears once
        /// the test project has built and its tests have actually executed.
        /// @param output The captured `dotnet test` output.
        /// @returns `true` when a test run completed.
        internal func CompletedTestRun(output string?) bool {
            return !string.IsNullOrEmpty(output) && Regex.IsMatch(
                output!!,
                "^\\s*(Passed|Failed)!\\s+-\\s+Failed:",
                RegexOptions.Multiline | RegexOptions.CultureInvariant
            )
        }
    }
}
