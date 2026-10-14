// <copyright file="Issue4903ThreadStaticFieldTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #4903: `@ThreadStatic` on a static field was silently dropped in the
/// emitted assembly, so the field became one process-wide slot. The migrated
/// `Gsharp.Runtime.Channels` relied on it for the per-thread `SelectWaiter`
/// cache; every thread then shared one waiter and raced
/// (`ArgumentOutOfRangeException` in `CollectGates`).
open class Issue4903ThreadStaticFieldTests {
    @Fact
    func ThreadStatic_OnSharedClassField_IsEmittedAndPerThread() {
        Run(`package P
import System
import System.Threading
shared class Holder {
    @ThreadStatic
    var slot int32
    func Bump() int32 {
        slot = slot + 1
        return slot
    }
}
Holder.Bump()
Holder.Bump()
var other int32 = 0
let t = Thread(() -> { other = Holder.Bump() })
t.Start()
t.Join()
let main = Holder.Bump()
Console.WriteLine("main=$main other=$other")`, "main=3 other=1")
    }

    @Fact
    func ThreadStatic_InSharedBlock_IsEmittedAndPerThread() {
        Run(`package P
import System
import System.Threading
class Holder {
    shared {
        @ThreadStatic
        private var slot int32
        func Bump() int32 {
            slot = slot + 1
            return slot
        }
    }
}
Holder.Bump()
Holder.Bump()
var other int32 = 0
let t = Thread(() -> { other = Holder.Bump() })
t.Start()
t.Join()
let main = Holder.Bump()
Console.WriteLine("main=$main other=$other")`, "main=3 other=1")
    }

    shared {
        private func Run(source string, expected string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_4903_threadstatic_").FullName
            try {
                let appPath = Path.Combine(tempDir, "P.dll")
                let log = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
                Assert.True(File.Exists(appPath), log)
                IlVerifier.Verify(appPath)
                let (exit, output) = RunDotnet(appPath)
                Assert.True(exit == 0, "exit $exit: $output")
                Assert.Equal(expected, output.Trim().Replace("\r\n", "\n"))
            } finally {
                Directory.Delete(tempDir, recursive: true)
            }
        }

        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return compileOut.ToString() + compileErr.ToString()
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!)
            return tpa!!.Split(Path.PathSeparator)
        }

        private const RunTimeoutMilliseconds int32 = 60_000

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            // Draining stdout to EOF before touching stderr deadlocks if the child
            // fills the stderr pipe first — read both concurrently and bound the
            // wait, or a hanging/misbehaving program takes the whole test run
            // down with it (mirrors Issue3958NullableDirectionalChannelTests).
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeoutMilliseconds) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeoutMilliseconds / 1000}s (deadlock).")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process.ExitCode, output.ToString())
        }
    }
}
