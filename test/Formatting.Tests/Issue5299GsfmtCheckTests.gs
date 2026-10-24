// <copyright file="Issue5299GsfmtCheckTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting.Tests

import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import GSharp.Gsfmt
import System
import System.IO
import Xunit

class Issue5299GsfmtCheckTests {
    private func Unformatted() string -> "package P\n\nfunc   F()   int32 {   return 1   }\n"

    @Fact
    func Check_NamesEachFileThatWouldChangeInSortedOrderAndExitsOne() {
        let root = Path.Combine(Path.GetTempPath(), "gsfmt-check-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        let bad2 = Path.Combine(root, "B.gs")
        let bad1 = Path.Combine(root, "A.gs")
        let good = Path.Combine(root, "C.gs")
        try {
            File.WriteAllText(bad2, Unformatted())
            File.WriteAllText(bad1, Unformatted())
            File.WriteAllText(good, FormatCanonical(Unformatted()))
            let stdout = StringWriter()
            let stderr = StringWriter()
            let exitCode = Program.Run([]string{"--check", root}, stdout, stderr)
            Assert.Equal(1, exitCode)
            Assert.Equal(bad1 + "\n" + bad2 + "\n", stdout.ToString().Replace("\r\n", "\n"))
            Assert.Contains("2 file(s) need formatting", stderr.ToString())
            Assert.Contains("Run 'gsfmt -w ", stderr.ToString())
            Assert.Equal(Unformatted(), File.ReadAllText(bad1))
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    func Check_PrintsNothingAndExitsZeroWhenEverythingIsFormatted() {
        let root = Path.Combine(Path.GetTempPath(), "gsfmt-check-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        let good = Path.Combine(root, "Good.gs")
        try {
            File.WriteAllText(good, FormatCanonical(Unformatted()))
            let stdout = StringWriter()
            let stderr = StringWriter()
            let exitCode = Program.Run([]string{"--check", good}, stdout, stderr)
            Assert.Equal(0, exitCode)
            Assert.Equal(string.Empty, stdout.ToString())
            Assert.Equal(string.Empty, stderr.ToString())
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    func Check_WithListPrintsEachFileOnce() {
        let root = Path.Combine(Path.GetTempPath(), "gsfmt-check-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        let bad1 = Path.Combine(root, "A.gs")
        let bad2 = Path.Combine(root, "B.gs")
        try {
            File.WriteAllText(bad1, Unformatted())
            File.WriteAllText(bad2, Unformatted())
            let stdout = StringWriter()
            let exitCode = Program.Run([]string{"--check", "-l", root}, stdout, StringWriter())
            Assert.Equal(1, exitCode)
            Assert.Equal(bad1 + "\n" + bad2 + "\n", stdout.ToString().Replace("\r\n", "\n"))
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    func Check_StillListsChangedFilesWhenAnotherFileFailsToParse() {
        let root = Path.Combine(Path.GetTempPath(), "gsfmt-check-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        let bad = Path.Combine(root, "A.gs")
        try {
            File.WriteAllText(bad, Unformatted())
            File.WriteAllText(Path.Combine(root, "B.gs"), "package P\n\nfunc (\n")
            let stdout = StringWriter()
            let exitCode = Program.Run([]string{"--check", root}, stdout, StringWriter())
            Assert.Equal(2, exitCode)
            Assert.Equal(bad + "\n", stdout.ToString().Replace("\r\n", "\n"))
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    func Check_QuotesFixCommandArgumentsThatTheShellWouldSplit() {
        let root = Path.Combine(Path.GetTempPath(), "gsfmt check " + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        try {
            File.WriteAllText(Path.Combine(root, "A.gs"), Unformatted())
            let stderr = StringWriter()
            Program.Run([]string{"--check", root}, StringWriter(), stderr)
            Assert.Contains("gsfmt -w '" + root + "'", stderr.ToString())
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    private func FormatCanonical(text string) string {
        let result = GSharpFormatter.Format(SourceText.From(text, "x.gs"))
        return result.Text?.ToString() ?? text
    }
}
