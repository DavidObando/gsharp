// <copyright file="Issue1506PerSegmentNestedTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Runtime.InteropServices
import Xunit

/// Issue #1506 — a type clause naming a nested type of a <em>constructed</em>
/// generic (`List[int32].Enumerator`) must resolve, emit, and run in every
/// type-clause position. This end-to-end test declares such a type in local,
/// parameter, return, and field positions, drives a manual enumeration
/// (`MoveNext()`/`Current`), and asserts both correct output and
/// ilverify-clean IL. The BCL is supplied via explicit `/reference:`
/// entries (MetadataLoadContext) exactly like the corpus harness so the emitted
/// nested `TypeSpec` is exercised under the real reference-resolution path.
open class Issue1506PerSegmentNestedTypeEmitTests {
    @Fact
    func EndToEnd_NestedEnumeratorOfConstructedList_VerifiesAndRuns() {
        // Unique package/type/func names: the in-process FunctionTypeSymbol
        // cache is not cleared between tests, so names must not collide with
        // any other emit test.
        let source = `package Issue1506EmitProbe
import System
import System.Collections.Generic

struct Issue1506Holder {
    var stash List[int32].Enumerator
}

func Issue1506SumViaParam(e List[int32].Enumerator) int32 {
    var total = 0
    while e.MoveNext() {
        total = total + e.Current
    }
    return total
}

func Issue1506MakeEnumerator(values List[int32]) List[int32].Enumerator {
    return values.GetEnumerator()
}

func Main() {
    var values = List[int32]()
    values.Add(3)
    values.Add(4)
    values.Add(5)

    var localEnum List[int32].Enumerator = values.GetEnumerator()
    var localSum = 0
    while localEnum.MoveNext() {
        localSum = localSum + localEnum.Current
    }

    var paramSum = Issue1506SumViaParam(Issue1506MakeEnumerator(values))

    var holder Issue1506Holder
    holder.stash = values.GetEnumerator()
    var fieldEnum = holder.stash
    var fieldSum = 0
    while fieldEnum.MoveNext() {
        fieldSum = fieldSum + fieldEnum.Current
    }

    Console.WriteLine(localSum)
    Console.WriteLine(paramSum)
    Console.WriteLine(fieldSum)
}`
        let output = CompileAndRun(source)
        Assert.Equal("12${Environment.NewLine}12${Environment.NewLine}12${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1506_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                // Pass the shared-framework assemblies as explicit `/reference:`
                // entries so gsc loads the BCL through a MetadataLoadContext, matching
                // the corpus harness and exercising the real nested-TypeSpec path.
                let frameworkReferences = FrameworkReferencePaths()
                let args = List[string]{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0"}
                args.AddRange(frameworkReferences.Select((r string) -> ("/reference:" + r)))
                args.Add(srcPath)
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                IlVerifier.Verify(dllPath)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func FrameworkReferencePaths() IReadOnlyList[string] {
            let runtimeDir = RuntimeEnvironment.GetRuntimeDirectory()
            if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
                return Array.Empty[string]()
            }
            return Directory
                .EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
                .OrderBy((p string) -> p, StringComparer.Ordinal)
                .ToList()
        }
    }
}
