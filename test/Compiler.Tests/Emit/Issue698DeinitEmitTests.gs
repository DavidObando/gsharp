// <copyright file="Issue698DeinitEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Collections.Generic

/// Issue #698 / ADR-0068: end-to-end emit tests for the Swift-style
/// `deinit { … }` destructor.
/// @remarks Each test compiles via `gsc`, runs `ilverify`, and then either
/// reflects on the produced assembly or executes it under `dotnet exec`
/// to assert behavior.
open class Issue698DeinitEmitTests {
    @Fact
    func Deinit_EmitsProtectedVirtualFinalizeOverride() {
        let source = `package Probe
import System

class Resource {
    var Tag string = ""
    deinit {
        Console.WriteLine(Tag)
    }
}

var _ = Resource()`
        WithCompiledAssembly(
            source,
            (asmPath string) -> {
                // Load the produced assembly in a fresh AppDomain-ish reflection
                // context so we can inspect the emitted Finalize method.
                let asm = EmittedFixture.Load(asmPath)
                let resource = asm.GetTypes().Single((t Type) -> t.Name == "Resource")
                let finalize MethodInfo? = resource.GetMethod(
                    "Finalize",
                    BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly
                )
                Assert.NotNull(finalize)
                Assert.Equal(typeof(Void), finalize!!.ReturnType)
                Assert.Empty(finalize!!.GetParameters())
                Assert.True(finalize!!.IsFamily, "Finalize must be `protected` (Family)")
                Assert.True(finalize!!.IsVirtual)
                Assert.True(finalize!!.IsHideBySig)
                // The emitted override must resolve back to System.Object.Finalize.
                let baseDef = finalize!!.GetBaseDefinition()
                Assert.Equal("Finalize", baseDef.Name)
                Assert.Equal(typeof(object), baseDef.DeclaringType)
            }
        )
    }

    @Fact
    func Deinit_RunsUserBody_WhenGCCollects() {
        let source = `package Probe
import System

class Resource {
    var Tag string = ""
    init(tag string) {
        Tag = tag
    }
    deinit {
        Console.WriteLine("deinit: " + Tag)
    }
}

func Allocate() {
    var _ = Resource("alpha")
}

Allocate()
GC.Collect()
GC.WaitForPendingFinalizers()
Console.WriteLine("done")`
        let output = CompileAndRun(source)
        Assert.Contains("deinit: alpha", output)
        Assert.Contains("done", output)
    }

    @Fact
    func Deinit_OnSubclass_RunsBothFinalizers() {
        let source = `package Probe
import System

open class Resource(Tag string) {
    deinit {
        Console.WriteLine("base: " + Tag)
    }
}

class CachedResource : Resource {
    var Key string = ""
    init(tag string, key string) : base(tag) {
        Key = key
    }
    deinit {
        Console.WriteLine("derived: " + Key)
    }
}

func Allocate() {
    var _ = CachedResource("db", "users")
}

Allocate()
GC.Collect()
GC.WaitForPendingFinalizers()
Console.WriteLine("done")`
        let output = CompileAndRun(source)
        // The derived-class Finalize runs first, then chains into the base
        // Finalize via the wrapping `finally { base.Finalize(); }`.
        Assert.Contains("derived: users", output)
        Assert.Contains("base: db", output)
        let dIdx = output.IndexOf("derived: users", StringComparison.Ordinal)
        let bIdx = output.IndexOf("base: db", StringComparison.Ordinal)
        Assert.InRange(dIdx, 0, int32.MaxValue)
        Assert.InRange(bIdx, 0, int32.MaxValue)
        Assert.True(dIdx < bIdx, "derived deinit must run before base deinit")
    }

    @Fact
    func Deinit_OnStruct_FailsToCompile() {
        let source = `package Probe
struct Point {
    var X int32 = 0
    deinit {
    }
}`
        let errors = CompileExpectingErrors(source)
        Assert.Contains(errors, (e string) -> e.Contains("GS0289"))
    }

    @Fact
    func Deinit_AssemblyPassesIlVerify() {
        let source = `package Probe
import System

open class Resource(Tag string) {
    deinit {
        Console.WriteLine("dispose: " + Tag)
    }
}

class CachedResource : Resource {
    init(tag string) : base(tag) {
    }
    deinit {
        Console.WriteLine("cached gone")
    }
}

var _ = CachedResource("x")`
        // CompileAndRun already invokes IlVerifier.Verify on the produced
        // assembly. Just calling it is the assertion.
        let output = CompileAndRun(source)
        Assert.NotNull(output)
    }

    shared {
        private func WithCompiledAssembly(source string, probe(string) -> void) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue698_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                probe(outPath)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // ignored

                }
            }
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue698_run_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
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
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // ignored

                }
            }
        }

        private func CompileExpectingErrors(source string) List[string] {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue698_err_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded")
                let combined = compileOut.ToString() + compileErr.ToString()
                return combined.Split(Environment.NewLine).Where((l string) -> !string.IsNullOrWhiteSpace(l)).ToList()
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // ignored

                }
            }
        }
    }
}
