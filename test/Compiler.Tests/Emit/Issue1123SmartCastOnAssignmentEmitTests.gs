// <copyright file="Issue1123SmartCastOnAssignmentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1123: Kotlin-style smart cast that narrows a nullable `var`
/// local to its non-nullable underlying type after it is assigned a
/// statically non-nullable value. These tests prove the narrowed read both
/// binds (member dispatch resolves) and emits/runs correctly — the call
/// dispatches to the expected member and the program produces the expected
/// output.
open class Issue1123SmartCastOnAssignmentEmitTests {
    @Fact
    func Assignment_NarrowsNullableRefLocal_DispatchesCall() {
        // The minimal repro from the issue, run end-to-end: `x` is `E?`,
        // assigned a non-nullable `E`, then `x.M()` must dispatch.
        let source = `package Test
import System

class E { func M() int32 { return 42 } }

func F(fresh E) int32 {
    var x E? = nil
    x = fresh
    return x.M()
}

Console.WriteLine(F(E()))`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func Assignment_NarrowingReachesNestedBlock() {
        let source = `package Test
import System

class E { func M() int32 { return 7 } }

func F(fresh E) int32 {
    var x E? = nil
    x = fresh
    if true {
        return x.M()
    }
    return 0
}

Console.WriteLine(F(E()))`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func Assignment_NarrowsToMostDerivedAssignedValue_DispatchesVirtual() {
        // `x` is declared `Base?`; after `x = Derived()` the value is provably
        // a non-null Base. Virtual dispatch must reach the Derived override.
        let source = `package Test
import System

open class Base { open func M() int32 { return 1 } }
class Derived : Base { override func M() int32 { return 99 } }

func F(d Derived) int32 {
    var x Base? = nil
    x = d
    return x.M()
}

Console.WriteLine(F(Derived()))`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    @Fact
    func Assignment_NullableValueType_NotNarrowed_ScopedToReferenceTypes() {
        // Issue #1123 is scoped to reference types: nullable value types
        // (`int32?`) are intentionally NOT narrowed on assignment because the
        // narrowed-read emit path does not unwrap `Nullable<T>`. Reading the
        // value type directly still requires an explicit unwrap (e.g. a nil
        // guard), so a bare arithmetic read here must fail to compile.
        let source = `package Test
import System

func F(n int32) int32 {
    var x int32? = nil
    x = n
    return x + 1
}

Console.WriteLine(F(41))`
        let (exitCode, _, _) = CompileAndRunRaw(source)
        Assert.NotEqual(0, exitCode)
    }

    shared {
        private func CompileAndRun(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source)
            Assert.True(exitCode == 0, (`gsc failed (exit ` + "$exitCode" + `):
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1123_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
                for reference in TrustedPlatformAssemblies() {
                    args.Add("/reference:" + reference)
                }
                args.Add("/nowarn:GS9100")
                args.Add(srcPath)
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
                if compileExit != 0 {
                    return (compileExit, compileOut.ToString(), compileErr.ToString())
                }
                IlVerifier.Verify(outPath)
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
                return (
                    proc.ExitCode,
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    stderr.ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func TrustedPlatformAssemblies() sequence[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                yield break
            }
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }
    }
}
