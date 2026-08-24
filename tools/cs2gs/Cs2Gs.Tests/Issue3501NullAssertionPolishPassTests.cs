// <copyright file="Issue3501NullAssertionPolishPassTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3501 (!! reduction): the polish pass deletes exactly the GS0536
/// spans gsc reported, bottom-up so coordinates stay valid, verifying each
/// span holds <c>!!</c> before touching it.
/// </summary>
public sealed class Issue3501NullAssertionPolishPassTests
{
    [Fact]
    public void Strip_RemovesFlaggedSpans_BottomUp_AndVerifiesTokenText()
    {
        string directory = Path.Combine(
            Path.GetTempPath(),
            nameof(Issue3501NullAssertionPolishPassTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        string file = Path.Combine(directory, "Snippet.gs");
        try
        {
            File.WriteAllLines(file, new[]
            {
                "func F(s string) string {",
                "    return s!! + s!!",
                "}",
            });

            var diagnostics = new[]
            {
                new GscDiagnostic("GS0536", "Redundant '!!'…", "warning", file, 2, 13, 2, 15),
                new GscDiagnostic("GS0536", "Redundant '!!'…", "warning", file, 2, 19, 2, 21),

                // Stale/mismatched span — must be skipped, not corrupt the file.
                new GscDiagnostic("GS0536", "Redundant '!!'…", "warning", file, 1, 6, 1, 8),

                // Non-GS0536 diagnostics are ignored entirely.
                new GscDiagnostic("GS0100", "Not all code paths…", "error", file, 3, 1, 3, 2),
            };

            int stripped = NullAssertionPolishPass.Strip(diagnostics, new[] { file });

            Assert.Equal(2, stripped);
            Assert.Equal(
                new[]
                {
                    "func F(s string) string {",
                    "    return s + s",
                    "}",
                },
                File.ReadAllLines(file));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void Strip_PolishesDependencyFilesUnderTheStrippableRoot()
    {
        string root = Path.Combine(
            Path.GetTempPath(),
            nameof(Issue3501NullAssertionPolishPassTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(root, "Dep"));
        string owned = Path.Combine(root, "Owned.gs");
        string dependency = Path.Combine(root, "Dep", "Sibling.gs");
        string outside = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".gs");
        try
        {
            File.WriteAllLines(owned, new[] { "let a = b!!" });
            File.WriteAllLines(dependency, new[] { "let c = d!!" });
            File.WriteAllLines(outside, new[] { "let e = f!!" });

            var diagnostics = new[]
            {
                new GscDiagnostic("GS0536", "Redundant '!!'…", "warning", dependency, 1, 10, 1, 12),
                new GscDiagnostic("GS0536", "Redundant '!!'…", "warning", outside, 1, 10, 1, 12),
            };

            Assert.Equal(
                new[] { dependency },
                NullAssertionPolishPass.CandidateFiles(diagnostics, new[] { owned }, root));

            int stripped = NullAssertionPolishPass.Strip(diagnostics, new[] { owned }, root);

            Assert.Equal(1, stripped);
            Assert.Equal(new[] { "let c = d" }, File.ReadAllLines(dependency));
            Assert.Equal(new[] { "let e = f!!" }, File.ReadAllLines(outside));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
            File.Delete(outside);
        }
    }

    [Fact]
    public void Strip_IgnoresFilesOutsideTheEmittedSet()
    {
        string directory = Path.Combine(
            Path.GetTempPath(),
            nameof(Issue3501NullAssertionPolishPassTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        string owned = Path.Combine(directory, "Owned.gs");
        string foreign = Path.Combine(directory, "Foreign.gs");
        try
        {
            File.WriteAllLines(owned, new[] { "let a = b!!" });
            File.WriteAllLines(foreign, new[] { "let a = b!!" });

            var diagnostics = new[]
            {
                new GscDiagnostic("GS0536", "Redundant '!!'…", "warning", foreign, 1, 10, 1, 12),
            };

            int stripped = NullAssertionPolishPass.Strip(diagnostics, new[] { owned });

            Assert.Equal(0, stripped);
            Assert.Equal(new[] { "let a = b!!" }, File.ReadAllLines(foreign));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
