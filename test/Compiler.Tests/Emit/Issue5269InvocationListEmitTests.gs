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
import Xunit

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

    shared {
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
                using let process = Process.Start(
                    ProcessStartInfo("dotnet"){
                        ArgumentList = {outputPath},
                        WorkingDirectory = directory,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false
                    }
                ) ??
                    throw InvalidOperationException("Cannot start emitted program")
                using let output = MemoryStream()
                let outputTask = process.StandardOutput.BaseStream.CopyToAsync(output)
                let errorTask = process.StandardError.ReadToEndAsync()
                let exited = process.WaitForExit(30_000)
                if !exited {
                    process.Kill(entireProcessTree: true)
                    process.WaitForExit()
                }
                Assert.True(exited, "Emitted program timed out")
                outputTask.GetAwaiter().GetResult()
                let error = errorTask.GetAwaiter().GetResult()
                Assert.True(process.ExitCode == 0, "Emitted program failed: $error")
                Assert.Equal(Encoding.UTF8.GetBytes(expected.ReplaceLineEndings(Environment.NewLine)), output.ToArray())
                Assert.Equal("", error)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
