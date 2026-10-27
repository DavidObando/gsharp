// <copyright file="Issue5451FailedEmissionCleanupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Diagnostics
import System.IO
import System.Text
import System.Text.RegularExpressions
import Xunit

class Issue5451FailedEmissionCleanupTests {
    @Theory
    @InlineData(1, -1)
    @InlineData(2, -1)
    @InlineData(3, -1)
    @InlineData(3, 0)
    @InlineData(3, 1)
    @InlineData(3, 2)
    @InlineData(2, 3)
    func Driver_OutputOpenException_RemovesOnlyNewlyCreatedFiles(failedIndex int32, preservedIndex int32) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let paths = []string{
            Path.Combine(fixture.Directory, "Failed.dll"),
            Path.Combine(fixture.Directory, "Failed.ref.dll"),
            Path.Combine(fixture.Directory, "Failed.pdb"),
            Path.Combine(fixture.Directory, "Failed.xml")
        }
        Directory.CreateDirectory(paths[failedIndex])
        let original = Encoding.UTF8.GetBytes("existing user output")
        if preservedIndex >= 0 {
            File.WriteAllBytes(paths[preservedIndex], original)
        }
        let unrelated = Path.Combine(fixture.Directory, "unrelated.txt")
        File.WriteAllBytes(unrelated, original)
        let source = Path.Combine(fixture.Directory, "Failed.gs")
        File.WriteAllText(source, "Console.Write(\"not executed\")\n")
        let start = ProcessStartInfo("dotnet"){
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        }
        for argument in[]string{
            typeof(Program).Assembly.Location,
            "/target:exe",
            "/targetframework:net10.0",
            "/out:" + paths[0],
            "/refout:" + paths[1],
            "/debug:portable",
            "/pdb:" + paths[2],
            "/doc:" + paths[3],
            source
        } {
            start.ArgumentList.Add(argument)
        }
        using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start gsc.")
        let stdout = process.StandardOutput.ReadToEndAsync()
        let stderr = process.StandardError.ReadToEndAsync()
        if !process.WaitForExit(30_000) {
            process.Kill(entireProcessTree: true)
            process.WaitForExit()
            Assert.Fail("Failed-emission driver exceeded 30 seconds.")
        }
        Assert.Equal(1, process.ExitCode)
        Assert.Empty(stdout.GetAwaiter().GetResult())
        let diagnostic = Assert.Single(
            Regex.Matches(stderr.GetAwaiter().GetResult(), `(?m)^gsc: error (GS\d+):[^\r\n]*`)
        )
        Assert.Equal("GS9997", diagnostic.Groups[1].Value)
        Assert.Contains(paths[failedIndex], diagnostic.Value)
        for var i = 0; i < paths.Length; i++ {
            if i == failedIndex {
                Assert.True(Directory.Exists(paths[i]))
            } else if i == preservedIndex {
                Assert.True(File.Exists(paths[i]), "Removed pre-existing output: " + paths[i])
                Assert.Equal(
                    if i < failedIndex {
                        Array.Empty[uint8]()
                    } else {
                        original
                    },
                    File.ReadAllBytes(paths[i])
                )
            } else {
                Assert.False(File.Exists(paths[i]), "Left failed output: " + paths[i])
            }
        }
        Assert.Equal(original, File.ReadAllBytes(unrelated))
        Assert.False(File.Exists(Path.ChangeExtension(paths[0], ".runtimeconfig.json")))
    }
}
