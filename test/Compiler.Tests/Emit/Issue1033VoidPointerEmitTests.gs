// <copyright file="Issue1033VoidPointerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #1033 / ADR-0122 §3: end-to-end emit + execution tests for the true
/// void-element pointer `*void` (CLR `ELEMENT_TYPE_PTR` over
/// `ELEMENT_TYPE_VOID`, the faithful mapping of C# `void*`) — distinct
/// from the byte pointer `*uint8`. A `*void` round-trips through
/// `nint`/`IntPtr` and casts to/from typed pointers `*T`; it
/// cannot be dereferenced/indexed/advanced directly (those are binder errors,
/// covered by the Core binder tests).
///
/// Genuinely-unsafe pointer code is <em>unverifiable by design</em>; the same
/// inherent-unsafety ilverify codes used by the #1014 tests are tolerated here
/// while still gating on unrelated verification regressions.
open class Issue1033VoidPointerEmitTests {
    @Fact
    func VoidPointer_RoundTripsThroughNintAndTypedCast_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var arr = []int32{123, 0}
    var p = &arr[0]
    var vp = *void(p)
    var addr = nint(vp)
    var vp2 = *void(addr)
    var ip = *int32(vp2)
    Console.WriteLine(*ip)
    ip[1] = 999
    Console.WriteLine(arr[1])
}

run()`
        let output = CompileAndRun(source)
        Assert.Equal("123${Environment.NewLine}999${Environment.NewLine}", output)
    }

    @Fact
    func VoidPointer_Field_EmitsVoidElementPointerSignature() {
        let source = `package Probe
import System

unsafe class Holder {
    var buf *void
}

func run() {
    Console.WriteLine("ok")
}

run()`
        let tempDir = Directory.CreateTempSubdirectory("gs_issue1033_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            CompileOrThrow(srcPath, outPath)
            using let pe = PEReader(File.OpenRead(outPath))
            let md = pe.GetMetadataReader()
            var found = false
            for fh in md.FieldDefinitions {
                let fd = md.GetFieldDefinition(fh)
                if md.GetString(fd.Name) != "buf" {
                    continue
                }
                found = true
                let sig = md.GetBlobBytes(fd.Signature)
                // FIELD (0x06), then ELEMENT_TYPE_PTR (0x0F) over
                // ELEMENT_TYPE_VOID (0x01) — a genuine void-element pointer,
                // NOT `PTR U1` (0x0F 0x05) which would be a `*uint8`.
                Assert.Equal(3, sig.Length)
                Assert.Equal(0x06, int32(sig[0]))
                Assert.Equal(uint8(SignatureTypeCode.Pointer), sig[1])
                Assert.Equal(uint8(SignatureTypeCode.Void), sig[2])
            }
            Assert.True(found, "field 'buf' not found in emitted metadata")
        } finally {
            TryDeleteDir(tempDir)
        }
    }

    shared {
        private let UnsafeIlVerifyIgnored[]string = []string{
            "UnmanagedPointer",
            "StackUnexpected",
            "StackByRef",
            "ExpectedPtr",
            "StackUnexpectedArrayType"
        }

        private func CompileOrThrow(srcPath string, outPath string) {
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
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1033_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                CompileOrThrow(srcPath, outPath)
                // Unsafe pointer code is unverifiable by design; tolerate the
                // inherent-unsafety error codes while still gating on other
                // verification regressions.
                IlVerifier.Verify(outPath, nil, UnsafeIlVerifyIgnored)
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
                TryDeleteDir(tempDir)
            }
        }

        private func TryDeleteDir(dir string) {
            try {
                Directory.Delete(dir, recursive: true)
            } catch {
                // ignored

            }
        }
    }
}
