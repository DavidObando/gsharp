// <copyright file="Issue750ConstraintOverloadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #750 / ADR-0088 — end-to-end test that the constraint-aware
/// overload resolution lets a single-name `Map` surface bind
/// correctly across a reference-typed receiver (`string?`) and a
/// value-typed receiver (`int?`) using
/// `Gsharp.Extensions.Optional`. Each test compiles via in-process
/// `gsc`, IL-verifies the emitted PE (so the chosen overload's
/// metadata round-trips cleanly), and runs the assembly under
/// `dotnet exec`.
open class Issue750ConstraintOverloadEmitTests {
    @Fact
    func Map_ResolvesBothClassAndStructOverloads_InSameProgram() {
        let source = `package Test
import System
import Gsharp.Extensions.Optional

let name string? = "ada"
let count int32? = 7

let upper = name.Map(func(s string) string { return s.ToUpper() })
let doubled = count.Map(func(n int32) int32 { return n * 2 })

Console.WriteLine(upper ?? "<none>")
Console.WriteLine(doubled.OrElse(-1).ToString())`
        let output = CompileAndRun(source)
        Assert.Equal("ADA${Environment.NewLine}14${Environment.NewLine}", output)
    }

    @Fact
    func Map_OnNullReferenceReceiver_ReturnsNull() {
        let source = `package Test
import System
import Gsharp.Extensions.Optional

let absent string? = nil
let mapped = absent.Map(func(s string) string { return s.ToUpper() })
Console.WriteLine(mapped ?? "<none>")`
        let output = CompileAndRun(source)
        Assert.Equal("<none>${Environment.NewLine}", output)
    }

    @Fact
    func Map_OnNullValueReceiver_ReturnsNull() {
        let source = `package Test
import System
import Gsharp.Extensions.Optional

let absent int32? = nil
let mapped = absent.Map(func(n int32) int32 { return n * 2 })
Console.WriteLine(mapped.OrElse(-1).ToString())`
        let output = CompileAndRun(source)
        Assert.Equal("-1${Environment.NewLine}", output)
    }

    @Fact
    func OrElse_DisjointConstraints_BindCorrectlyForBothReceiverShapes() {
        let source = `package Test
import System
import Gsharp.Extensions.Optional

let s string? = nil
let n int32? = nil

Console.WriteLine(s.OrElse("default"))
Console.WriteLine(n.OrElse(99).ToString())`
        let output = CompileAndRun(source)
        Assert.Equal("default${Environment.NewLine}99${Environment.NewLine}", output)
    }

    @Fact
    func FirstOrNil_SequenceTerminals_BindBothClassAndStructOverloads() {
        // FirstOrNil's class overload lives in SequenceExtensions; the struct
        // overload lives in SequenceValueExtensions (separate class because
        // IEnumerable<T> shape is identical for class and struct T). The
        // binder picks the right one per ADR-0088.
        let source = `package Test
import System
import Gsharp.Extensions.Optional
import Gsharp.Extensions.Sequences

let names = Sequences.Of("alpha", "beta")
let nums = Sequences.Of(11, 22, 33)

Console.WriteLine(names.FirstOrNil() ?? "<none>")
Console.WriteLine(nums.FirstOrNil().OrElse(-1).ToString())`
        let output = CompileAndRun(source)
        Assert.Equal("alpha${Environment.NewLine}11${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue750_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                // Issue #724: link against Gsharp.Extensions.dll and stage it next
                // to the emitted assembly so `dotnet exec` resolves it at runtime.
                let extensionsPath string? = LocateGsharpExtensionsAssembly()
                Assert.True(
                    extensionsPath != nil && File.Exists(extensionsPath),
                    "Gsharp.Extensions.dll not found in any expected location"
                )
                File.Copy(extensionsPath!!, Path.Combine(tempDir, "Gsharp.Extensions.dll"), overwrite: true)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    "/r:" + extensionsPath,
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed (exit ` + "$compileExit" + `):
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath, additionalReferences: []string{extensionsPath!!})
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`sample exited ` + "${proc.ExitCode}" + `
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

        private func LocateGsharpExtensionsAssembly() string? {
            var dir DirectoryInfo? = DirectoryInfo(
                Path.GetDirectoryName(typeof(Issue750ConstraintOverloadEmitTests).Assembly.Location)!!
            )
            while dir != nil {
                if RepositoryRootMarker.IsRoot(dir.FullName) {
                    for cfg in[]string{"Debug", "Release"} {
                        let candidate = Path.Combine(
                            dir.FullName,
                            "out",
                            "bin",
                            cfg,
                            "Gsharp.Extensions",
                            "Gsharp.Extensions.dll"
                        )
                        if File.Exists(candidate) {
                            return candidate
                        }
                    }
                    return nil
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
