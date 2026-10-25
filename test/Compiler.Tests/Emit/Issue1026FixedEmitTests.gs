// <copyright file="Issue1026FixedEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.Tests
import GSharp.Tests
import System
import System.Collections.Generic
import System.ComponentModel
import System.Diagnostics
import System.IO
import System.IO.Pipes
import System.Reflection.Emit
import System.Text
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issue #1026 / ADR-0125: end-to-end emit + execution tests for the
/// `fixed` statement (`fixed <name> *T = <source> { ... }`).
/// The statement pins a managed array/slice or string and binds an unmanaged
/// `*T` pointer to its first element, emitting a CLR `pinned` local
/// (mirroring C# `fixed (T* p = expr) { }`). Each test compiles via
/// `gsc` and executes the produced assembly under `dotnet exec` to
/// assert runtime behavior.
///
/// Code that pins a buffer and dereferences an unmanaged pointer is
/// <em>unverifiable by design</em>: ilverify reports the usual
/// unmanaged-pointer / by-ref codes at the pin and dereference sites. Those
/// specific codes are passed to `ignoredErrorCodes` so the gate still
/// catches NEW unrelated verification regressions while tolerating the
/// inherent unsafety, rather than skipping ilverify globally.
open class Issue1026FixedEmitTests {
    @Fact
    func ByteCapture_NonterminalFifoCopiesDeferSnapshotsUntilBothCopiesStop() {
        if !OperatingSystem.IsLinux() {
            return
        }
        using let fixture = NativeSliceLanguageTests.Fixture()
        let stdoutPath = Path.Combine(fixture.Directory, "stdout.fifo")
        let stderrPath = Path.Combine(fixture.Directory, "stderr.fifo")
        let create = ProcessStartInfo("mkfifo"){
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        }
        create.ArgumentList.Add(stdoutPath)
        create.ArgumentList.Add(stderrPath)
        using let fifo = Process.Start(create) ?? throw InvalidOperationException("Failed to create FIFOs")
        Assert.Empty(CaptureBytes(fifo, fifo.StandardOutput.BaseStream, fifo.StandardError.BaseStream, 5_000))
        using let stdout = FileStream(
            stdoutPath,
            FileMode.Open,
            FileAccess.ReadWrite,
            FileShare.ReadWrite,
            1,
            FileOptions.None
        )
        using let stderr = FileStream(
            stderrPath,
            FileMode.Open,
            FileAccess.ReadWrite,
            FileShare.ReadWrite,
            1,
            FileOptions.None
        )
        using let stdoutWriter = FileStream(
            stdoutPath,
            FileMode.Open,
            FileAccess.ReadWrite,
            FileShare.ReadWrite,
            1,
            FileOptions.None
        )
        using let stderrWriter = FileStream(
            stderrPath,
            FileMode.Open,
            FileAccess.ReadWrite,
            FileShare.ReadWrite,
            1,
            FileOptions.None
        )
        stdoutWriter.WriteByte(uint8(255))
        stderrWriter.WriteByte(uint8(254))
        let assembly = fixture.Compile("System.Environment.Exit(17)", "failed", true)
        let start = ProcessStartInfo("dotnet"){
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = fixture.Directory
        }
        start.ArgumentList.Add(assembly)
        using let process = Process.Start(start) ?? throw InvalidOperationException("Failed to start witness")
        let snapshots = List[Task[[]uint8]]()
        let copies = List[Task]()
        let elapsed = Stopwatch.StartNew()
        try {
            let failure = Assert.Throws[InvalidOperationException](() -> CaptureBytes(process, stdout, stderr, 2_000))
            for name in[]string{"Stdout", "Stderr"} {
                if failure.Data[name + "Snapshot"] is Task[[]uint8]snapshot {
                    snapshots.Add(snapshot)
                }
                if failure.Data[name + "Copy"] is Task copy {
                    copies.Add(copy)
                }
                Assert.Null(failure.Data[name])
            }
            Assert.True(elapsed.Elapsed < TimeSpan.FromSeconds(12), "Capture exceeded its bounded cleanup budget")
            Assert.Contains("Child process exited with code 17", failure.Message, StringComparison.Ordinal)
            Assert.Contains("<snapshot pending>", failure.Message, StringComparison.Ordinal)
            Assert.Equal(true, failure.Data["CaptureCancellationRequested"])
            Assert.Equal(2, snapshots.Count)
            Assert.Equal(2, copies.Count)
            for copy in copies {
                Assert.False(copy.IsCompleted)
            }
            for snapshot in snapshots {
                Assert.False(snapshot.IsCompleted)
            }
        } finally {
            stdoutWriter.WriteByte(uint8(1))
            stderrWriter.WriteByte(uint8(1))
            let all = Task.WhenAll(snapshots.ToArray())
            let _ = all.ContinueWith(
                (finished Task[[][]uint8]) -> finished.Exception,
                TaskContinuationOptions.OnlyOnFaulted
            )
            let _ = Task.WhenAny(all, Task.Delay(5_000)).GetAwaiter().GetResult()
        }
        for copy in copies {
            Assert.True(copy.IsCanceled)
        }
        for snapshot in snapshots {
            Assert.True(snapshot.IsCompletedSuccessfully)
        }
        Assert.Equal([]uint8{255}, snapshots[0].Result)
        Assert.Equal([]uint8{254}, snapshots[1].Result)
    }

    @Fact
    func ByteCapture_TimeoutReapsChildAndPreservesBothRawPipes() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`import System
Console.OpenStandardOutput().WriteByte(uint8(0))
Console.OpenStandardOutput().WriteByte(uint8(255))
Console.OpenStandardError().WriteByte(uint8(254))
Console.OpenStandardError().WriteByte(uint8(1))
System.Threading.Thread.Sleep(30000)`, "stalled", true)
        let start = ProcessStartInfo("dotnet"){
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = fixture.Directory
        }
        start.ArgumentList.Add(assembly)
        using let process = Process.Start(start) ?? throw InvalidOperationException("Failed to start witness")
        let elapsed = Stopwatch.StartNew()
        let failure = Assert.Throws[TimeoutException](
            () -> CaptureBytes(process, process.StandardOutput.BaseStream, process.StandardError.BaseStream, 2_000)
        )
        Assert.True(elapsed.Elapsed < TimeSpan.FromSeconds(15), "Capture exceeded its bounded cleanup budget")
        Assert.True(process.HasExited)
        Assert.Equal([]uint8{0, 255}, Assert.IsType[[]uint8](failure.Data["Stdout"]))
        Assert.Equal([]uint8{254, 1}, Assert.IsType[[]uint8](failure.Data["Stderr"]))
        Assert.Equal("RanToCompletion", failure.Data["StdoutStatus"])
        Assert.Equal("RanToCompletion", failure.Data["StderrStatus"])
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ByteCapture_RealPipeFaultsOrCancellationDoNotMaskChildFailure(closed bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile("System.Environment.Exit(17)", "failed", true)
        let start = ProcessStartInfo("dotnet"){
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = fixture.Directory
        }
        start.ArgumentList.Add(assembly)
        using let stdoutWriter = AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.None)
        using let stderrWriter = AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.None)
        using let stdout = AnonymousPipeClientStream(PipeDirection.In, stdoutWriter.ClientSafePipeHandle)
        using let stderr = AnonymousPipeClientStream(PipeDirection.In, stderrWriter.ClientSafePipeHandle)
        if closed {
            stdoutWriter.DisposeLocalCopyOfClientHandle()
            stderrWriter.DisposeLocalCopyOfClientHandle()
        } else {
            stdoutWriter.WriteByte(uint8(255))
            stderrWriter.WriteByte(uint8(254))
        }
        using let process = Process.Start(start) ?? throw InvalidOperationException("Failed to start witness")
        let elapsed = Stopwatch.StartNew()
        let capture = Task.Run[[]uint8](() -> CaptureBytes(process, stdout, stderr, 2_000))
        try {
            Assert.Same(capture, Task.WhenAny(capture, Task.Delay(12_000)).GetAwaiter().GetResult())
            let failure = Assert.Throws[InvalidOperationException](() -> capture.GetAwaiter().GetResult())
            Assert.True(elapsed.Elapsed < TimeSpan.FromSeconds(15), "Capture exceeded its bounded cleanup budget")
            Assert.True(process.HasExited)
            Assert.Contains("exited with code 17", failure.Message, StringComparison.Ordinal)
            Assert.Equal(
                if closed {
                    Array.Empty[uint8]()
                } else {
                    []uint8{255}
                },
                Assert.IsType[[]uint8](failure.Data["Stdout"])
            )
            Assert.Equal(
                if closed {
                    Array.Empty[uint8]()
                } else {
                    []uint8{254}
                },
                Assert.IsType[[]uint8](failure.Data["Stderr"])
            )
            Assert.Equal(
                if closed {
                    "Faulted"
                } else {
                    "Canceled"
                },
                failure.Data["StdoutStatus"]
            )
            Assert.Equal(
                if closed {
                    "Faulted"
                } else {
                    "Canceled"
                },
                failure.Data["StderrStatus"]
            )
            Assert.Equal(!closed, failure.Data["CaptureCancellationRequested"])
            let faults = Assert.IsType[AggregateException](failure.InnerException).InnerExceptions
            Assert.Equal(2, faults.Count)
            Assert.Contains("stdout", faults[0].Message, StringComparison.Ordinal)
            Assert.Contains("stderr", faults[1].Message, StringComparison.Ordinal)
            for fault in faults {
                if closed {
                    let errors = Assert.IsType[AggregateException](fault.InnerException).InnerExceptions
                    Assert.IsType[ObjectDisposedException](Assert.Single(errors))
                } else {
                    Assert.IsType[TaskCanceledException](fault.InnerException)
                }
            }
        } finally {
            stdoutWriter.Dispose()
            stderrWriter.Dispose()
            let _ = Task.WhenAny(capture, Task.Delay(1_000)).GetAwaiter().GetResult()
            let _ = capture.ContinueWith(
                (finished Task[[]uint8]) -> finished.Exception,
                TaskContinuationOptions.OnlyOnFaulted
            )
        }
    }

    @Fact
    func InferredImportedByteArray_ExactIssue5266_ReachesArrayPinLowering() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`import System.Text

unsafe {
    let bytes = Encoding.UTF8.GetBytes("x")
    fixed value *uint8 = bytes {
        System.Console.WriteLine(value[0])
    }
}`, "inferred", true)
        IlVerifier.Verify(assembly, nil, FixedIlVerifyIgnored)
        Assert.Equal(Encoding.UTF8.GetBytes("120" + Environment.NewLine), RunBytes(assembly, fixture.Directory))
        let entryPoint = EmittedFixture.Load(assembly)
            .EntryPoint ??
            throw InvalidOperationException("Missing entry point")
        let body = entryPoint.GetMethodBody() ?? throw InvalidOperationException("Missing entry point body")
        Assert.Contains(body.LocalVariables, (local) -> local.IsPinned && local.LocalType == typeof([]uint8))
        let instructions = IlInstructionReader.Read(body.GetILAsByteArray() ?? Array.Empty[uint8]())
        Assert.Contains(instructions, (instruction) -> instruction.OpCode == OpCodes.Ldelema)
        Assert.Contains(instructions, (instruction) -> instruction.OpCode == OpCodes.Ldind_U1)
    }

    @Fact
    func ImportedArrayMembers_PinOriginalStorageAndEvaluateSourceOnce() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        using let contract = CSharpFixture(`#nullable enable
namespace PinContracts {
    public sealed class PinBuffer {
        public byte[] Data = new byte[] { 120 };
        public int Reads;
        public byte[] Value { get { Reads++; return Data; } }
        public int[] Numbers() { Reads++; return new int[] { 42 }; }
    }
}`)
        File.Copy(contract.AssemblyPath, Path.Combine(fixture.Directory, Path.GetFileName(contract.AssemblyPath)))
        let assembly = fixture.Compile(`import System
import PinContracts
unsafe {
    let owner = PinBuffer()
    let inferred = owner.Data
    let annotated []uint8 = inferred
    fixed p *uint8 = inferred { p[0] = uint8(121) }
    fixed p *uint8 = owner.Value {
        Console.WriteLine(p[0])
        p[0] = uint8(122)
    }
    Console.WriteLine(annotated[0])
    Console.WriteLine(owner.Data[0])
    Console.WriteLine(Object.ReferenceEquals(inferred, owner.Data))
    fixed p *int32 = owner.Numbers() { Console.WriteLine(p[0]) }
    Console.WriteLine(owner.Reads)
}`, "members", true, "/r:" + contract.AssemblyPath)
        IlVerifier.Verify(assembly, []string{contract.AssemblyPath}, FixedIlVerifyIgnored)
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                string.Join(Environment.NewLine, []string{"121", "122", "122", "True", "42", "2", ""})
            ),
            RunBytes(assembly, fixture.Directory)
        )
    }

    @Theory
    @InlineData("Bytes", "int32")
    @InlineData("Matrix", "uint8")
    @InlineData("Names", "uint8")
    @InlineData("Maybe", "uint8")
    func ImportedArrayPin_RejectionsKeepLocatedGS0401AndEmitNoPE(member string, pointee string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        using let contract = CSharpFixture(`#nullable enable
namespace PinContracts {
    public static class Pins {
        public static byte[] Bytes() => new byte[1];
        public static byte[,] Matrix() => new byte[1, 1];
        public static string[] Names() => new string[] { "x" };
        public static byte[]? Maybe() => null;
    }
}`)
        let (code, output) = fixture.TryCompile(
            "import PinContracts\nunsafe {\n    fixed value *$pointee = Pins.$member() { }\n}",
            "rejected",
            true,
            "/r:" + contract.AssemblyPath
        )
        Assert.NotEqual(0, code)
        let endColumn = 33 + member.Length
        Assert.Contains("rejected.gs(3,26,3,$endColumn): error GS0401:", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))
    }

    @Fact
    func ArrayPin_WriteRead_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var buf = []uint8{uint8(0), uint8(0), uint8(0)}
    fixed pD *uint8 = buf {
        pD[0] = uint8(65)
        pD[1] = uint8(66)
        pD[2] = uint8(67)
    }
    Console.WriteLine(int32(buf[0]))
    Console.WriteLine(int32(buf[1]))
    Console.WriteLine(int32(buf[2]))
}

run()`
        let output = CompileAndRun(source, FixedIlVerifyIgnored)
        Assert.Equal("65${Environment.NewLine}66${Environment.NewLine}67${Environment.NewLine}", output)
    }

    @Fact
    func StringPin_ReadChars_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var total = 0
    fixed pC *uint16 = "ABC" {
        for var i = 0; i < 3; i++ {
            total = total + int32(pC[i])
        }
    }
    Console.WriteLine(total)
}

run()`
        let output = CompileAndRun(source, FixedIlVerifyIgnored)
        // 'A'(65) + 'B'(66) + 'C'(67) = 198
        Assert.Equal("198${Environment.NewLine}", output)
    }

    @Fact
    func OahuPattern_FixedBytePointer_CompilesAndRuns() {
        // Equivalent of the Oahu case `fixed (byte* pD = destination)` where
        // `destination` is a `byte[]`: copy bytes through the pinned pointer.
        let source = `package Probe
import System

unsafe func copyByte(destination []uint8, value uint8) {
    fixed pD *uint8 = destination {
        *pD = value
    }
}

unsafe func run() {
    var dst = []uint8{uint8(0), uint8(0)}
    copyByte(dst, uint8(42))
    Console.WriteLine(int32(dst[0]))
    Console.WriteLine(int32(dst[1]))
}

run()`
        let output = CompileAndRun(source, FixedIlVerifyIgnored)
        Assert.Equal("42${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func EmptyArrayPin_NullPointer_CompilesAndRuns() {
        let source = `package Probe
import System

unsafe func run() {
    var buf = []uint8{}
    fixed pD *uint8 = buf {
        Console.WriteLine(nint(pD))
    }
}

run()`
        let output = CompileAndRun(source, FixedIlVerifyIgnored)
        Assert.Equal("0${Environment.NewLine}", output)
    }

    shared {
        private func RunBytes(assembly string, directory string)[]uint8 {
            let start = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory
            }
            start.ArgumentList.Add(assembly)
            using let process = Process.Start(start) ?? throw InvalidOperationException("Failed to start dotnet")
            return CaptureBytes(process, process.StandardOutput.BaseStream, process.StandardError.BaseStream, 30_000)
        }

        private func CaptureBytes(process Process, stdout Stream, stderr Stream, timeoutMilliseconds int32)[]uint8 {
            let capturedOut = MemoryStream()
            let capturedError = MemoryStream()
            using let cancelCapture = CancellationTokenSource()
            let output = stdout.CopyToAsync(capturedOut, cancelCapture.Token)
            let stdoutSnapshot = SnapshotAfterCapture(output, capturedOut)
            let error = stderr.CopyToAsync(capturedError, cancelCapture.Token)
            let stderrSnapshot = SnapshotAfterCapture(error, capturedError)
            // Observe snapshot faults even after the bounded cleanup deadline.
            let observed = Task.WhenAll(
                []Task{
                    stdoutSnapshot.ContinueWith(
                        (finished Task[[]uint8]) -> finished.Exception,
                        TaskContinuationOptions.ExecuteSynchronously
                    ),
                    stderrSnapshot.ContinueWith(
                        (finished Task[[]uint8]) -> finished.Exception,
                        TaskContinuationOptions.ExecuteSynchronously
                    )
                }
            )
            let failures = List[Exception]()
            var exited = process.WaitForExit(timeoutMilliseconds)
            let timedOut = !exited
            if timedOut {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (failure Win32Exception) {
                    failures.Add(failure)
                } catch (failure InvalidOperationException) {
                    failures.Add(failure)
                }
                try {
                    exited = process.WaitForExit(5_000)
                } catch (failure Win32Exception) {
                    failures.Add(failure)
                } catch (failure InvalidOperationException) {
                    failures.Add(failure)
                }
                if !exited {
                    failures.Add(TimeoutException("Child did not exit within the post-kill deadline"))
                }
            }
            if Task.WhenAny(observed, Task.Delay(5_000)).GetAwaiter().GetResult() != observed {
                try {
                    cancelCapture.Cancel()
                } catch (failure AggregateException) {
                    failures.Add(failure)
                }
                let _ = Task.WhenAny(observed, Task.Delay(1_000)).GetAwaiter().GetResult()
            }
            let Record = func (name string, task Task) {
                if task.IsFaulted {
                    failures.Add(InvalidOperationException("$name capture faulted", task.Exception))
                } else if task.IsCanceled {
                    failures.Add(InvalidOperationException("$name capture canceled", TaskCanceledException(task)))
                } else if !task.IsCompleted {
                    failures.Add(TimeoutException("$name capture remains ${task.Status} after cancellation"))
                }
            }
            Record("stdout", output)
            Record("stderr", error)
            Record("stdout snapshot", stdoutSnapshot)
            Record("stderr snapshot", stderrSnapshot)
            let stdoutBytes = if stdoutSnapshot.IsCompletedSuccessfully {
                stdoutSnapshot.Result
            } else {
                default([]?uint8)
            }
            let stderrBytes = if stderrSnapshot.IsCompletedSuccessfully {
                stderrSnapshot.Result
            } else {
                default([]?uint8)
            }
            let primary = if timedOut {
                "Child process timed out after $timeoutMilliseconds ms"
            } else if process.ExitCode != 0 {
                "Child process exited with code ${process.ExitCode}"
            } else if failures.Count != 0 || stdoutBytes == nil || stderrBytes == nil {
                "Child process capture failed"
            } else if stderrBytes.Length != 0 {
                "Child process wrote unexpected stderr"
            } else {
                default(string?)
            }
            if primary != nil {
                let stdoutText = if stdoutBytes is {} bytes {
                    BitConverter.ToString(bytes)
                } else {
                    "<snapshot pending>"
                }
                let stderrText = if stderrBytes is {} bytes {
                    BitConverter.ToString(bytes)
                } else {
                    "<snapshot pending>"
                }
                let message = "$primary; stdout (${output.Status}): $stdoutText; " +
                    "stderr (${error.Status}): $stderrText; " +
                    "capture cancellation requested: ${cancelCapture.IsCancellationRequested}"
                let context = AggregateException(failures)
                let failure Exception = if timedOut {
                    TimeoutException(message, context)
                } else {
                    InvalidOperationException(message, context)
                }
                failure.Data["Stdout"] = stdoutBytes
                failure.Data["Stderr"] = stderrBytes
                failure.Data["StdoutStatus"] = output.Status.ToString()
                failure.Data["StderrStatus"] = error.Status.ToString()
                failure.Data["StdoutCopy"] = output
                failure.Data["StderrCopy"] = error
                failure.Data["StdoutSnapshot"] = stdoutSnapshot
                failure.Data["StderrSnapshot"] = stderrSnapshot
                failure.Data["CaptureCancellationRequested"] = cancelCapture.IsCancellationRequested
                throw failure
            }
            return stdoutBytes ?? throw InvalidOperationException("Child process stdout snapshot is unavailable")
        }

        private func SnapshotAfterCapture(copy Task, bytes MemoryStream) Task[[]uint8] {
            return copy.ContinueWith(
                (finished Task) -> {
                    let _ = finished.Exception
                    using let captured = bytes
                    return captured.ToArray()
                },
                TaskContinuationOptions.ExecuteSynchronously
            )
        }

        private let FixedIlVerifyIgnored[]string = []string{
            "Unverifiable",
            "UnmanagedPointer",
            "StackUnexpected",
            "StackByRef",
            "ExpectedPtr",
            "StackUnexpectedArrayType",
            "ExpectedNumericType"
        }

        private func CompileAndRun(source string, ilVerifyIgnored[]string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1026_").FullName
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
                // Pinning + unmanaged-pointer dereference is unverifiable by
                // design; tolerate the specific pointer/by-ref codes while still
                // gating on other verification regressions.
                IlVerifier.Verify(outPath, nil, ilVerifyIgnored)
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
    }
}
