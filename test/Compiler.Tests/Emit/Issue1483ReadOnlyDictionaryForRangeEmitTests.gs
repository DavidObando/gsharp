// <copyright file="Issue1483ReadOnlyDictionaryForRangeEmitTests.cs" company="GSharp">
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

/// Issue #1483: end-to-end emit + IL-verify coverage for `for k, v in d`
/// over a receiver typed only as `IReadOnlyDictionary[K, V]`. Pre-fix the
/// binder failed to recognize the read-only mapping family and mis-lowered the
/// loop as `ForRangeKind.Enumerable` — binding `k` to an
/// `int32` running index and `v` to `KeyValuePair[K, V]`. These
/// tests prove the loop now key/value destructures: `k` is the string KEY
/// and `v` is the int32 VALUE, and the produced assembly IL-verifies.
open class Issue1483ReadOnlyDictionaryForRangeEmitTests {
    @Fact
    func ReadOnlyDictionary_Receiver_ForKV_Destructures_Key_And_Value() {
        // A single-entry dictionary keeps iteration deterministic. `firstKey`
        // returns `k` as a string (impossible under the enumerable
        // mis-binding, where `k` is an int32 index), and `sumValues` adds `v`
        // as an int32 (impossible if `v` were a KeyValuePair). The receivers
        // are typed as IReadOnlyDictionary[string, int32]; a Dictionary is
        // passed in via the read-only interface upcast.
        let source = `package P1483
import System
import System.Collections.Generic

func Issue1483FirstKey(d IReadOnlyDictionary[string, int32]) string {
    for k, v in d {
        return k
    }
    return "none"
}

func Issue1483SumValues(d IReadOnlyDictionary[string, int32]) int32 {
    var total = 0
    for k, v in d {
        total = total + v
    }
    return total
}

var d = Dictionary[string, int32]()
d["solo"] = 7
Console.WriteLine(Issue1483FirstKey(d))
Console.WriteLine(Issue1483SumValues(d))`
        let output = CompileAndRun(source)
        Assert.Equal("solo${Environment.NewLine}7${Environment.NewLine}", output)
    }

    @Fact
    func ReadOnlyDictionary_Receiver_ForKV_SumsValues_OrderIndependent() {
        // Multiple entries: summing values and key lengths is order-independent,
        // so the result is deterministic regardless of dictionary enumeration
        // order. Proves both K (string, via len) and V (int32) destructure.
        let source = `package P1483b
import System
import System.Collections.Generic

func Issue1483Fold(d IReadOnlyDictionary[string, int32]) int32 {
    var acc = 0
    for k, v in d {
        acc = acc + v + k.Length
    }
    return acc
}

var d = Dictionary[string, int32]()
d["a"] = 10
d["bb"] = 20
Console.WriteLine(Issue1483Fold(d))`
        let output = CompileAndRun(source)
        Assert.Equal("33${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1483_emit_").FullName
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
                } catch { }
            }
        }
    }
}
