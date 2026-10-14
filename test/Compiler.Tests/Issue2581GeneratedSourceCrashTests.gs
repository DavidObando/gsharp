// <copyright file="Issue2581GeneratedSourceCrashTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.IO
import Xunit

open class Issue2581GeneratedSourceCrashTests {
    @Fact
    func Main_GeneratedSourceAndDiscardedDictionaryKey_EmitsStableAssembly() {
        let tempDir = Directory.CreateTempSubdirectory("gsc_2581_").FullName
        try {
            let generatedPath = Path.Combine(tempDir, "Repro.Version.gs")
            let appPath = Path.Combine(tempDir, "App.gs")
            File.WriteAllText(
                generatedPath,
                "package Repro\n@assembly: System.Reflection.AssemblyVersionAttribute(\"1.0.0.0\")"
            )
            File.WriteAllText(appPath, `package Repro
import System.Collections.Generic

func Sum(values Dictionary[string, int32]) int32 {
    var total = 0
    for (_, value) in values {
        total += value
    }
    return total
}`)
            let first = Compile(tempDir, "first.dll", generatedPath, appPath)
            let second = Compile(tempDir, "second.dll", generatedPath, appPath)
            Assert.Equal(0, first.ExitCode)
            Assert.Equal(0, second.ExitCode)
            Assert.DoesNotContain("GS9998", first.Output)
            Assert.DoesNotContain("GS9998", second.Output)
            Assert.Equal(File.ReadAllBytes(first.OutputPath), File.ReadAllBytes(second.OutputPath))
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    shared {
        private func Compile(directory string, outputName string, sources ...string)(
            ExitCode int32,
            Output string,
            OutputPath string
        ) {
            let outputPath = Path.Combine(directory, outputName)
            using let writer = StringWriter()
            let previous = Console.Out
            Console.SetOut(writer)
            try {
                let args = [sources.Length + 4]string
                args[0] = "/out:" + outputPath
                args[1] = "/target:library"
                args[2] = "/deterministic+"
                args[3] = "/nowarn:GS9100"
                sources.CopyTo(args, 4)
                return (Program.Main(args), writer.ToString(), outputPath)
            } finally {
                Console.SetOut(previous)
            }
        }
    }
}
