// <copyright file="PrivateInterfaceHelpersEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// ADR-0090 / issue #756 — `private` interface helper methods.
/// Validates the CLR emit shape end-to-end: a private interface helper is
/// emitted as `Private | HideBySig` (instance), NOT virtual / abstract,
/// and carries an IL body. A sibling default method may call the helper;
/// an implementer that omits both inherits only the public default and
/// cannot see the helper. The library passes ilverify.
open class PrivateInterfaceHelpersEmitTests {
    @Fact
    func PrivateInterfaceHelper_InterfaceMetadata_IsPrivateHideBySig_NotVirtual() {
        let source = `package Probe
import System

interface ICalc {
    func Double(x int32) int32 { return Helper(x) + Helper(x) }
    private func Helper(x int32) int32 { return x }
}`
        let dllPath = CompileLibrary(source)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            var helperHandle MethodDefinitionHandle? = nil
            var doubleHandle MethodDefinitionHandle? = nil
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if !reader.StringComparer.Equals(td.Name, "ICalc") {
                    continue
                }
                for mh in td.GetMethods() {
                    let md = reader.GetMethodDefinition(mh)
                    if reader.StringComparer.Equals(md.Name, "Helper") {
                        helperHandle = mh
                    } else if reader.StringComparer.Equals(md.Name, "Double") {
                        doubleHandle = mh
                    }
                }
            }
            Assert.True((helperHandle != nil), "expected to find Helper on ICalc")
            Assert.True((doubleHandle != nil), "expected to find Double on ICalc")
            let helper = reader.GetMethodDefinition(helperHandle!!)
            let helperAttrs = helper.Attributes
            let helperVisibility = helperAttrs & MethodAttributes.MemberAccessMask
            Assert.True(
                helperVisibility == MethodAttributes.Private,
                "private interface helper must be Private; got $helperVisibility"
            )
            Assert.True((helperAttrs & MethodAttributes.HideBySig) != 0, "private interface helper must be HideBySig")
            Assert.True((helperAttrs & MethodAttributes.Virtual) == 0, "private interface helper must NOT be virtual")
            Assert.True((helperAttrs & MethodAttributes.Abstract) == 0, "private interface helper must NOT be abstract")
            Assert.True(
                (helperAttrs & MethodAttributes.NewSlot) == 0,
                "private interface helper must NOT carry NewSlot"
            )
            Assert.True((helperAttrs & MethodAttributes.Static) == 0, "instance private helper must NOT be static")
            Assert.True(helper.RelativeVirtualAddress != 0, "private interface helper must carry a body (non-zero RVA)")
            // The sibling public default is still emitted as Public | Virtual.
            let dbl = reader.GetMethodDefinition(doubleHandle!!)
            let dblVisibility = dbl.Attributes & MethodAttributes.MemberAccessMask
            Assert.Equal(MethodAttributes.Public, dblVisibility)
            Assert.True((dbl.Attributes & MethodAttributes.Virtual) != 0, "sibling public default must be Virtual")
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func EndToEnd_PublicDefaultCallsPrivateHelper_RuntimeDispatchWorks() {
        // ADR-0090: a default method on an interface may call its private
        // helper via implicit `this`. The implementer that omits both
        // inherits the public default, which transparently delegates to the
        // helper at runtime.
        let source = `package Probe
import System

interface ICalc {
    func Double(x int32) int32 { return Helper(x) + Helper(x) }
    private func Helper(x int32) int32 { return x }
}

class C : ICalc {
}

func Main() {
    var c ICalc = C{}
    Console.WriteLine(c.Double(7))
}`
        let output = CompileAndRun(source)
        Assert.Equal("14${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_ImplementerCannotSeeHelper_FromOutsideInterface() {
        // ADR-0090: external code (a class accessor) cannot call the private
        // helper through an interface-typed receiver — GS0334 fires during
        // compilation.
        let source = `package Probe
import System

interface ICalc {
    func Double(x int32) int32 { return x + x }
    private func Helper(x int32) int32 { return x }
}

class C : ICalc {
}

func Main() {
    var c ICalc = C{}
    Console.WriteLine(c.Helper(3))
}`
        let (exit, stdout, stderr) = CompileExpectingFailure(source)
        Assert.NotEqual(0, exit)
        Assert.Contains("GS0334", stdout + stderr)
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_pih_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_pih_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
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

        private func CompileExpectingFailure(source string)(Exit int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_pih_fail_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                return (compileExit, stdoutWriter.ToString(), stderrWriter.ToString())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func TryCleanup(dllPath string) {
            try {
                let dir string? = Path.GetDirectoryName(dllPath)
                if dir != nil && Directory.Exists(dir) {
                    Directory.Delete(dir, recursive: true)
                }
            } catch { }
        }
    }
}
