// <copyright file="Issue5269InvocationListEmitTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Core.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text
import System.Threading
import System.Threading.Tasks
import Xunit
import Xunit.Sdk

open class Issue5269InvocationListEmitTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func EmptyStructEvent_OriginalRepro_EmitsAndRuns(referencePack bool) {
        AssertOutput(`package Repro
import System

internal enum Key { Escape }
internal struct Modifiers { internal var Shift bool }
internal struct Notifications {
    private event pressed Func[Key, Modifiers, bool]

    internal func Dispatch(key Key, modifiers Modifiers) bool {
        for callback in Delegate.EnumerateInvocationList[Func[Key, Modifiers, bool]](pressed) {
            if callback(key, modifiers) { return true }
        }
        return false
    }
}

func Main() {
    var notifications = Notifications{}
    Console.WriteLine(notifications.Dispatch(Key.Escape, Modifiers{}))
}`, "False\n", referencePack: referencePack)
    }

    @Theory
    @InlineData("struct", "Notifications{}", false)
    @InlineData("class", "Notifications()", false)
    @InlineData("struct", "Notifications{}", true)
    @InlineData("class", "Notifications()", true)
    func EventSubscribers_KeepOrderArgumentsShortCircuitAndStorage(
        kind string,
        construction string,
        referencePack bool
    ) {
        let source = `package Subscribers
import System

internal enum Key { Escape }
internal struct Modifiers { internal var Shift bool }
internal KIND Notifications {
    private event pressed Func[Key, Modifiers, bool]
    internal func Add(callback Func[Key, Modifiers, bool]) { pressed += callback }
    internal func Remove(callback Func[Key, Modifiers, bool]) { pressed -= callback }
    internal func Dispatch(key Key, modifiers Modifiers) bool {
        for callback in Delegate.EnumerateInvocationList[Func[Key, Modifiers, bool]](pressed) {
            if callback(key, modifiers) { return true }
        }
        return false
    }
}

func First(key Key, modifiers Modifiers) bool {
    Console.WriteLine("first:" + (key == Key.Escape).ToString() + ":" + modifiers.Shift.ToString())
    return false
}
func Second(key Key, modifiers Modifiers) bool {
    Console.WriteLine("second:" + modifiers.Shift.ToString())
    return true
}
func Last(key Key, modifiers Modifiers) bool {
    Console.WriteLine("last")
    return true
}
func Snapshot(callback Func[Key, Modifiers, bool]) Func[Key, Modifiers, bool] {
    Console.WriteLine("snapshot")
    return callback
}

func Main() {
    var notifications = CONSTRUCTION
    Console.WriteLine(notifications.Dispatch(Key.Escape, Modifiers{}))
    notifications.Add(First)
    Console.WriteLine(notifications.Dispatch(Key.Escape, Modifiers{Shift: true}))
    notifications.Add(Second)
    notifications.Add(Last)
    Console.WriteLine(notifications.Dispatch(Key.Escape, Modifiers{Shift: true}))
    notifications.Remove(Second)
    Console.WriteLine(notifications.Dispatch(Key.Escape, Modifiers{}))
    notifications.Remove(First)
    notifications.Remove(Last)
    Console.WriteLine(notifications.Dispatch(Key.Escape, Modifiers{}))
    let callback Func[Key, Modifiers, bool] = First
    for item in Delegate.EnumerateInvocationList[Func[Key, Modifiers, bool]](Snapshot(callback)) {
        Console.WriteLine(item(Key.Escape, Modifiers{}))
    }
    let control Func[int32, bool] = (value int32) -> value == 7
    for item in Delegate.EnumerateInvocationList[Func[int32, bool]](control) {
        Console.WriteLine(item(7))
    }
}`
        AssertOutput(source.Replace("KIND", kind).Replace("CONSTRUCTION", construction), `False
first:True:True
False
first:True:True
second:True
True
first:True:False
last
True
False
snapshot
first:True:False
False
True
`, referencePack: referencePack)
    }

    @Theory
    @InlineData("struct", "holder.Read()")
    @InlineData("struct", "holder.Value")
    @InlineData("ref struct", "holder.Read()")
    @InlineData("ref struct", "holder.Value")
    func ConstrainedImportedContainer_MethodAndField_KeepDelegateProjection(kind string, read string) {
        using let contract = CSharpFixture(`using System;
namespace Native {
    public KIND Holder<T> where T : Delegate {
        public T Value;
        public Holder(T value) { Value = value; }
        public T Read() => Value;
    }
}`.Replace("KIND", kind))
        AssertOutput(`package Imported
import System
import Native

struct Payload { var Value int32 }
func Main() {
    let callback Func[Payload, bool] = (value Payload) -> value.Value == 42
    let holder = Holder[Func[Payload, bool]](callback)
    let value = READ
    Console.WriteLine(value(Payload{Value: 42}))
}`.Replace("READ", read), "True\n", contract.AssemblyPath)
    }

    @Theory
    @InlineData("property")
    @InlineData("field")
    @InlineData("ref")
    @InlineData("readonly")
    func ReferenceEnumerator_ProjectsActualCurrentDeclaration(kind string) {
        let member = switch kind {
            case "field": "public int Current;"
            case "ref": "public ref int Current => ref current;"
            case "readonly": "public ref readonly int Current => ref current;"
            default: "public int Current => current;"
        }
        using let contract = CSharpFixture(`#nullable enable
using System.Collections.Generic;
namespace Native {
    public class View<T> {
        public Cursor<object, List<T>> GetEnumerator() => new();
    }
    public class Cursor<A, B> {
        private int current;
        CURRENT_MEMBER
        public bool MoveNext() {
            current += 21;
            FIELD_UPDATE
            return current <= 42;
        }
    }
}`.Replace("CURRENT_MEMBER", member)
                .Replace(
                "FIELD_UPDATE",
                if kind == "field" {
                    "Current = current;"
                } else {
                    ""
                }
            ))
        AssertOutput(`package ReferenceCurrent
import System
import Native

func Main() {
    var total = 0
    for value in View[int32]() {
        Console.WriteLine(value)
        total += value
    }
    Console.WriteLine(total)
}`, "21\n42\n63\n", contract.AssemblyPath)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ReferenceEnumerator_ProjectsNullableConstrainedCurrent(field bool) {
        using let contract = CSharpFixture(`#nullable enable
using System.Collections.Generic;
namespace Native {
    public class View<T> {
        public Cursor<object, int, List<T>> GetEnumerator() => new(42);
    }
    public class Cursor<A, B, C> where B : struct {
        private readonly B value;
        private int index;
        public Cursor(B value) { this.value = value; }
        CURRENT_MEMBER
        public bool MoveNext() {
            index++;
            FIELD_UPDATE
            return index <= 2;
        }
    }
}`.Replace(
                "CURRENT_MEMBER",
                if field {
                    "public B? Current;"
                } else {
                    "public B? Current => index == 1 ? null : value;"
                }
            )
                .Replace(
                "FIELD_UPDATE",
                if field {
                    "Current = index == 1 ? null : value;"
                } else {
                    ""
                }
            ))
        AssertOutput(`package NullableCurrent
import System
import Native

func Main() {
    for value in View[int32]() {
        Console.WriteLine(value == nil ? "nil" : value.ToString())
    }
}`, "nil\n42\n", contract.AssemblyPath)
    }

    @Theory
    @InlineData("normal")
    @InlineData("hung")
    @InlineData("escaped")
    func RuntimeCapture_BoundsExitAndBothBinaryPipes(shape string) {
        if OperatingSystem.IsWindows() {
            // Like the existing escaped-pipe verifier probe, this requires POSIX inherited handles.
            return
        }
        let directory = Path.Combine(AppContext.BaseDirectory, "issue5269-capture", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        let pidPath = Path.Combine(directory, "child.pid")
        try {
            let script = switch shape {
                case "normal": "printf '\\377out'; printf '\\376err' >&2; " +
                    "awk 'BEGIN { for (i = 0; i < 131072; i++) printf \"o\" }'; " +
                    "awk 'BEGIN { for (i = 0; i < 131072; i++) printf \"e\" }' >&2"
                case "hung": "echo $$$$ > '$pidPath'; printf '\\377out'; printf '\\376err' >&2; read ignored"
                default: "(sleep 10 & echo $$! > '$pidPath'); printf '\\377out'; printf '\\376err' >&2"
            }
            let startInfo = ProcessStartInfo("/bin/sh"){
                ArgumentList = {"-c", script},
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory
            }
            let stopwatch = Stopwatch.StartNew()
            if shape == "normal" {
                let result = CaptureProcess(startInfo, 10_000, 1_000)
                Assert.Equal(0, result.ExitCode)
                let expectedOutput = List[uint8]([]uint8{0xFF, 0x6F, 0x75, 0x74})
                let expectedError = List[uint8]([]uint8{0xFE, 0x65, 0x72, 0x72})
                for var i = 0; i < 131072; i++ {
                    expectedOutput.Add(0x6F)
                    expectedError.Add(0x65)
                }
                Assert.Equal(expectedOutput.ToArray(), result.Stdout)
                Assert.Equal(expectedError.ToArray(), result.Stderr)
            } else {
                let exception = Assert.ThrowsAny[XunitException](() -> CaptureProcess(startInfo, 1_000, 500))
                Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(5), "capture took ${stopwatch.Elapsed}")
                Assert.Contains("stdout(hex): FF6F7574", exception.Message, StringComparison.Ordinal)
                Assert.Contains("stderr(hex): FE657272", exception.Message, StringComparison.Ordinal)
                Assert.Contains(
                    if shape == "hung" {
                        "Emitted program timed out after 1000 ms"
                    } else {
                        "Emitted program exited but output pipes timed out"
                    },
                    exception.Message,
                    StringComparison.Ordinal
                )
                Assert.True(File.Exists(pidPath), "The actual child must have started.")
                Assert.True(int32.TryParse(File.ReadAllText(pidPath).Trim(), out var pid) && pid > 0)
            }
        } finally {
            if File.Exists(pidPath) && int32.TryParse(File.ReadAllText(pidPath).Trim(), out var pid) {
                try {
                    using let child = Process.GetProcessById(pid)
                    child.Kill(entireProcessTree: true)
                    Assert.True(child.WaitForExit(5_000), "Probe child did not terminate.")
                } catch (ArgumentException) { }
            }
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private async func PumpBytes(stream Stream, output MemoryStream, cancellation CancellationToken) {
            let buffer = [4096]uint8
            while await stream.ReadAsync(buffer.AsMemory(), cancellation) is var count && count > 0 {
                lock output {
                    output.Write(buffer, 0, count)
                }
            }
        }

        private func Snapshot(output MemoryStream)[]uint8 {
            lock output {
                return output.ToArray()
            }
        }

        private func CaptureProcess(
            startInfo ProcessStartInfo,
            timeoutMilliseconds int32 = 30_000,
            cleanupMilliseconds int32 = 5_000
        )(ExitCode int32, Stdout[]uint8, Stderr[]uint8) {
            let process = Process.Start(startInfo) ?? throw InvalidOperationException("Cannot start emitted program")
            let output = MemoryStream()
            let error = MemoryStream()
            let cancellation = CancellationTokenSource()
            let outputTask = PumpBytes(process.StandardOutput.BaseStream, output, cancellation.Token)
            let errorTask = PumpBytes(process.StandardError.BaseStream, error, cancellation.Token)
            let exitTask = process.WaitForExitAsync()
            let pumps = Task.WhenAll(outputTask, errorTask)
            let lifetime = Task.WhenAll(exitTask, pumps)
            // Observe each fault even if its sibling or the process never becomes terminal.
            let _ = outputTask.ContinueWith((task Task) -> task.Exception, TaskContinuationOptions.OnlyOnFaulted)
            let _ = errorTask.ContinueWith((task Task) -> task.Exception, TaskContinuationOptions.OnlyOnFaulted)
            let _ = exitTask.ContinueWith((task Task) -> task.Exception, TaskContinuationOptions.OnlyOnFaulted)
            var failure = ""
            try {
                try {
                    exitTask.WaitAsync(TimeSpan.FromMilliseconds(timeoutMilliseconds)).GetAwaiter().GetResult()
                } catch (TimeoutException) {
                    failure = "Emitted program timed out after $timeoutMilliseconds ms"
                    try {
                        process.Kill(entireProcessTree: true)
                    } catch (ex Exception) {
                        failure += "; kill failed: $ex"
                    }
                    try {
                        exitTask.WaitAsync(TimeSpan.FromMilliseconds(cleanupMilliseconds)).GetAwaiter().GetResult()
                    } catch (ex Exception) {
                        failure += "; termination did not complete: $ex"
                    }
                }
                try {
                    pumps.WaitAsync(TimeSpan.FromMilliseconds(cleanupMilliseconds)).GetAwaiter().GetResult()
                } catch (TimeoutException) {
                    if failure.Length == 0 {
                        failure = "Emitted program exited but output pipes timed out"
                    }
                    cancellation.Cancel()
                    try {
                        pumps.WaitAsync(TimeSpan.FromMilliseconds(cleanupMilliseconds)).GetAwaiter().GetResult()
                    } catch (ex Exception) {
                        failure += "; pipe settlement: $ex"
                    }
                } catch (ex Exception) {
                    failure += "; output capture failed: $ex"
                }
                if failure.Length != 0 {
                    throw XunitException(
                        failure + "\nstdout(hex): " + Convert.ToHexString(Snapshot(output)) +
                            "\nstderr(hex): " +
                            Convert.ToHexString(Snapshot(error)) +
                            "\nstdout fault: ${outputTask.Exception}\nstderr fault: ${errorTask.Exception}"
                    )
                }
                return (process.ExitCode, Snapshot(output), Snapshot(error))
            } finally {
                // Pending readers retain their buffers and process; disposal cannot race a write.
                let _ = lifetime.ContinueWith(
                    (completed Task) -> {
                        let _ = completed.Exception
                        process.Dispose()
                        output.Dispose()
                        error.Dispose()
                        cancellation.Dispose()
                    },
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default
                )
            }
        }

        private func AssertOutput(source string, expected string, reference string? = nil, referencePack bool = false) {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue5269", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "Program.gs")
                let outputPath = Path.Combine(directory, "Probe.dll")
                File.WriteAllText(sourcePath, source)
                let args = List[string]{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0"}
                if referencePack {
                    for path in ReferenceClosure.RefPackAssemblies() {
                        args.Add("/r:" + path)
                    }
                }
                if reference != nil {
                    args.Add("/r:" + reference)
                    File.Copy(reference, Path.Combine(directory, Path.GetFileName(reference)))
                }
                args.Add(sourcePath)
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                var exitCode int32
                Console.SetOut(stdout)
                Console.SetError(stderr)
                try {
                    exitCode = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, "gsc failed:\n$stdout\n$stderr")
                IlVerifier.Verify(
                    outputPath,
                    additionalReferences: if reference == nil {
                        Array.Empty[string]()
                    } else {
                        []string{reference}
                    }
                )
                let result = CaptureProcess(
                    ProcessStartInfo("dotnet"){
                        ArgumentList = {outputPath},
                        WorkingDirectory = directory,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false
                    }
                )
                Assert.True(result.ExitCode == 0, "Emitted program failed: ${Encoding.UTF8.GetString(result.Stderr)}")
                Assert.Equal(Encoding.UTF8.GetBytes(expected.ReplaceLineEndings(Environment.NewLine)), result.Stdout)
                Assert.Equal(Array.Empty[uint8](), result.Stderr)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
