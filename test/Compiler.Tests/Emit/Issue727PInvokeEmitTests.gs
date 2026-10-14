// <copyright file="Issue727PInvokeEmitTests.cs" company="GSharp">
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
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Runtime.InteropServices
import Xunit

/// End-to-end emit + execute coverage for ADR-0086 / issue #727: a G#
/// function annotated with `@DllImport` and a `;` body lowers
/// to a CLR `PinvokeImpl` method with an `ImplMap` row pointing
/// at a deduplicated `ModuleRef`, and the runtime can invoke the
/// underlying native entry point.
open class Issue727PInvokeEmitTests {
    @Fact
    func PInvoke_LibcStrLen_RoundTrip_ReturnsExpectedLength() {
        if !IsLibcCallable() {
            return // skip-not-fail per task spec on platforms without libc

        }
        const source = `package P
import System
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
func strlen_native(text string) nint;

Console.WriteLine(strlen_native("Hello, world!"))`
        let output = CompileAndRun(source)
        Assert.Equal("13${Environment.NewLine}", output)
    }

    @Fact
    func PInvoke_SetLastError_PropagatesToManagedSide() {
        if !IsLibcCallable() || RuntimeInformation.IsOSPlatform(OSPlatform.Windows) {
            // POSIX-only test: open(2) is portable but not universally
            // discoverable through "libc" on Windows. Marshal.GetLastWin32Error
            // is still readable, but the call would resolve differently.
            return
        }
        // open(2) with O_RDONLY=0 on a missing path sets errno to ENOENT (2).
        // We invoke it via P/Invoke with SetLastError=true and verify that the
        // managed `Marshal.GetLastWin32Error` returns the propagated errno
        // (matching the SetLastError contract on POSIX runtimes — see ADR-0086
        // §3 "SetLastError").
        const source = `package P
import System
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "open", SetLastError: true)
func native_open(path string, flags int32) int32;

var fd = native_open("/no/such/path/should/exist/at/all", 0)
var err = Marshal.GetLastWin32Error()
Console.WriteLine(fd)
Console.WriteLine(err)`
        let output = CompileAndRun(source)
        let lines = output.TrimEnd(Environment.NewLine.ToCharArray()).Split(Environment.NewLine)
        Assert.Equal(2, lines.Length)
        Assert.Equal("-1", lines[0])
        Assert.NotEqual("0", lines[1])
    }

    @Fact
    func PInvoke_EmittedMethod_HasPinvokeImpl_And_ImplMap() {
        if !IsLibcCallable() {
            return
        }
        const source = `package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi)
func MyStrLen(text string) nint;`
        let tempDir = Directory.CreateTempSubdirectory("gs_pinvoke_meta_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            CompileOrThrow(srcPath, outPath, target: "library")
            using let pe = PEReader(File.OpenRead(outPath))
            let md = pe.GetMetadataReader()
            var foundPInvoke = false
            for h in md.MethodDefinitions {
                let m = md.GetMethodDefinition(h)
                let name = md.GetString(m.Name)
                if name != "MyStrLen" {
                    continue
                }
                foundPInvoke = true
                Assert.True((m.Attributes & MethodAttributes.PinvokeImpl) == MethodAttributes.PinvokeImpl)
                let import_ = m.GetImport()
                Assert.False(import_.Module.IsNil)
                Assert.False(import_.Name.IsNil)
                let moduleName = md.GetString(md.GetModuleReference(import_.Module).Name)
                Assert.Equal("libc", moduleName)
                Assert.Equal("strlen", md.GetString(import_.Name))
                Assert.True(
                    (import_.Attributes & MethodImportAttributes.CharSetAnsi) == MethodImportAttributes.CharSetAnsi
                )
            }
            Assert.True(foundPInvoke, "expected an emitted P/Invoke method named MyStrLen")
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    shared {
        private func IsLibcCallable() bool -> RuntimeInformation.IsOSPlatform(OSPlatform.Linux) ||
            RuntimeInformation.IsOSPlatform(OSPlatform.OSX)

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_pinvoke_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                CompileOrThrow(srcPath, outPath, target: "exe")
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
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
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

        private func CompileOrThrow(srcPath string, outPath string, target string) {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:" + target, "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
        }
    }
}
