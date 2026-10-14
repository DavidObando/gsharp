// <copyright file="Issue2810ExplicitLambdaParameterConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

class Issue2810ExplicitLambdaParameterConversionEmitTests {
    @Fact
    func ExplicitParameterImplicitConversion_Runs() {
        const Source = `package Issue2810

import System
import System.Collections.Generic
import System.Linq

class Number(val int32) {
    func Get() int32 {
        return val
    }

    func operator implicit(value Number) int32 {
        return value.Get()
    }
}

let nums = List[Number]()
nums.Add(Number(1))
nums.Add(Number(2))
nums.Add(Number(3))
nums.Add(Number(4))

for value in nums.Where((x int32) -> x % 2 == 0) {
    Console.WriteLine(value.Get())
}`
        Assert.Equal("2${Environment.NewLine}4${Environment.NewLine}", CompileAndRun(Source))
    }

    @Fact
    func ExplicitUserTypeParameterImplicitConstruction_Runs() {
        const Source = `package Issue2810Reverse

import System
import System.Collections.Generic
class Wrapped(val int32) {
    func Get() int32 {
        return val
    }

    func operator implicit(value int32) Wrapped {
        return Wrapped(value)
    }
}

let nums = List[int32]()
nums.Add(1)
nums.Add(2)
nums.Add(3)
nums.Add(4)

nums.ForEach((x Wrapped) -> Console.WriteLine(x.Get()))`
        Assert.Equal(
            "1${Environment.NewLine}2${Environment.NewLine}3${Environment.NewLine}4${Environment.NewLine}",
            CompileAndRun(Source)
        )
    }

    @Fact
    func ExplicitParameterConversion_RunsOncePerInvocation() {
        const Source = `package Issue2810Once

import System
import System.Collections.Generic
import System.Linq

class Number(val int32) {
    func operator implicit(value Number) int32 {
        Console.WriteLine("convert")
        return value.val
    }
}

let nums = List[Number]()
nums.Add(Number(1))
nums.Add(Number(2))

for value in nums.Where((x int32) -> x > 0 && x % 2 == 0) {
}`
        Assert.Equal("convert${Environment.NewLine}convert${Environment.NewLine}", CompileAndRun(Source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue2810_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                let exitCode = Program.Main(
                    []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
                Assert.Equal(0, exitCode)
                IlVerifier.Verify(outputPath)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
                startInfo.ArgumentList.Add(outputPath)
                using let process = Process.Start(startInfo) ??
                    throw InvalidOperationException("Failed to start dotnet exec.")
                let stdout = process.StandardOutput.ReadToEnd()
                let stderr = process.StandardError.ReadToEnd()
                Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
                Assert.True(process.ExitCode == 0, (`exited ` + "${process.ExitCode}" + `
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
