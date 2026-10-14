// <copyright file="Issue3317NilCompareWarningSuppressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.IO
import Xunit

/// Issue #3317 / ADR-0159: GS0523 (statically-constant nil comparison) is a
/// warning-severity diagnostic, so the standard gsc suppression/promotion
/// plumbing applies: it surfaces by default without failing the build,
/// `/nowarn:GS0523` suppresses it, and `/warnaserror` promotes it
/// to a build-failing error.
open class Issue3317NilCompareWarningSuppressionTests {
    @Fact
    func Gs0521_SurfacesAsWarning_BuildSucceeds() {
        let (exit, output) = CompileLibrary(DeadNilCheckSource, extraArgs: Array.Empty[string]())
        Assert.Equal(0, exit)
        Assert.Contains("GS0523", output)
    }

    @Fact
    func Gs0521_NowarnSuppresses() {
        let (exit, output) = CompileLibrary(DeadNilCheckSource, extraArgs: []string{"/nowarn:GS0523"})
        Assert.Equal(0, exit)
        Assert.DoesNotContain("GS0523", output)
    }

    @Fact
    func Gs0521_WarnAsErrorFailsBuild() {
        let (exit, output) = CompileLibrary(DeadNilCheckSource, extraArgs: []string{"/warnaserror"})
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0523", output)
    }

    shared {
        private const DeadNilCheckSource string = `package P3317Gsc

func Dead(m map[string, int32]) bool {
    return m == nil
}`

        private func CompileLibrary(source string, extraArgs[]string)(ExitCode int32, Output string) {
            let sample = Path.Combine(Path.GetTempPath(), "gs_test_${Guid.NewGuid():N}.gs")
            File.WriteAllText(sample, source)
            let tempDir = Directory.CreateTempSubdirectory("gsc_gs0521_").FullName
            let outPath = Path.Combine(tempDir, "P3317Gsc.dll")
            using let outWriter = StringWriter()
            using let errWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(outWriter)
            Console.SetError(errWriter)
            try {
                let args = [extraArgs.Length + 3]string
                args[0] = "/out:" + outPath
                args[1] = "/target:library"
                Array.Copy(extraArgs, 0, args, 2, extraArgs.Length)
                args[^1] = sample
                let exit = Program.Main(args)
                return (exit, outWriter.ToString() + errWriter.ToString())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
                try {
                    File.Delete(sample)
                } catch { }
            }
        }
    }
}
