// <copyright file="Issue3318MapForInEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #3318: end-to-end emit + IL-verify coverage for range-`for`
/// over `map[K, V]`. The produced assemblies must be IL-verifiable
/// (the enumerator-based Dictionary lowering, including the #3313
/// symbolic-MemberRef path for open-generic maps, emits verifiable IL)
/// and run to the expected stdout. Assertions are order-independent
/// because map iteration order is unspecified.
open class Issue3318MapForInEmitTests {
    @Fact
    func ConcreteMap_TwoVar_Compiles_Verifies_And_Runs() {
        let source = `package P
import System

var m = map[int32, int32]{1: 10, 2: 20, 3: 30}
var keySum = 0
var valSum = 0
for k, v in m {
    keySum = keySum + k
    valSum = valSum + v
}
Console.WriteLine(keySum)
Console.WriteLine(valSum)`
        let output = CompileAndRun(source)
        Assert.Equal("6${Environment.NewLine}60${Environment.NewLine}", output)
    }

    @Fact
    func ConcreteMap_OneVar_KeyValuePair_Compiles_Verifies_And_Runs() {
        let source = `package P
import System

var m = map[string, int32]{"a": 1, "bb": 2}
var n = 0
for kv in m {
    n = n + kv.Key.Length * kv.Value
}
Console.WriteLine(n)`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    @Fact
    func OpenGenericMap_BothForms_Compile_Verify_And_Run() {
        let source = `package P
import System

func SumValues[K any](items map[K, int32]) int32 {
    var n = 0
    for k, v in items {
        n = n + v
    }
    return n
}

func CountEntries[K any, V any](items map[K, V]) int32 {
    var n = 0
    for kv in items {
        n = n + 1
    }
    return n
}

var m = map[string, int32]{"a": 1, "b": 2, "c": 4}
Console.WriteLine(SumValues[string](m))
Console.WriteLine(CountEntries[string, int32](m))`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}3${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue3318_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }
}
