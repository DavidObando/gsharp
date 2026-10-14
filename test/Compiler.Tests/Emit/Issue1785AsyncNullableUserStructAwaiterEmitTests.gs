// <copyright file="Issue1785AsyncNullableUserStructAwaiterEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1785: awaiting a `Task[T?]` where `T` is a same-
/// compilation user value type (struct/enum) mistyped the hoisted awaiter
/// field. `TryGetAwaiterTypeSymbol` only recognized a bare
/// `StructSymbol`/`InterfaceSymbol`/`EnumSymbol` type argument,
/// so a `NullableTypeSymbol` wrapping a user struct/enum fell through to
/// `null`, and the awaiter field/local ended up typed
/// `TaskAwaiter<object>` instead of the correct
/// `TaskAwaiter<Nullable<T>>`. The same narrow predicate
/// recurred in three other places that also need to agree on the widened
/// `Task<T?>` shape: `LambdaBinder.WrapAsTask` (the async
/// function's own declared/observable return type), `ReflectionMetadataEmitter
/// .IsAsyncUserDefinedResultType` (the kickoff method's real emitted
/// `Task<T>` return type), and `AsyncStateMachineTypeBuilder`'s
/// `ResolveAsyncReturnClrType`/`Build` (the async method builder's
/// erasure placeholder and the state machine's `<>t__builder` field
/// type). All four now use symbol-based detection (a
/// `NullableTypeSymbol` whose `UnderlyingType` is a
/// `StructSymbol`/`InterfaceSymbol`/`EnumSymbol`) instead of
/// `ClrType.IsValueType`, which is `null` for an
/// in-flight (same-compilation) user type and therefore can't distinguish the
/// nullable-wrapped case from an ordinary BCL/erased type.
open class Issue1785AsyncNullableUserStructAwaiterEmitTests {
    @Fact
    func Await_Task_Of_NullableUserStruct_Returns_Value() {
        const source = `package i1785struct
import System
import System.Threading.Tasks

struct Point1785(X int32) { }

async func inner() Point1785 {
    return Point1785(42)
}

async func getVal() Point1785? {
    let v = await inner()
    return v
}

let opt = getVal().Result
let p = opt ?? Point1785(0)
Console.WriteLine(p.X)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func Await_Task_Of_NullableUserEnum_Returns_Value() {
        const source = `package i1785enum
import System
import System.Threading.Tasks

enum Color1785 { Red, Green, Blue }

async func inner() Color1785 {
    return Color1785.Green
}

async func getVal() Color1785? {
    let v = await inner()
    return v
}

let opt = getVal().Result
let r = opt ?? Color1785.Red
Console.WriteLine(r)`
        // G# has no user-defined enum ToString override here, so
        // Console.WriteLine prints the underlying int32 value (Green = 1).
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func Await_Task_Of_NullableUserClass_Still_Works() {
        // Regression guard: a nullable REFERENCE type (`UserClass?`) has the
        // same CLR shape as the bare class (no `Nullable<T>` wrapper), but its
        // NullableTypeSymbol also reports a null ClrType during compilation.
        // The fix must not force reference-type nullables down the
        // value-type-nullable path; they still need the widened detection so
        // `WrapAsTask` produces `Task[UserClass?]` instead of falling through
        // unwrapped.
        const source = `package i1785class
import System
import System.Threading.Tasks

class Box1785(X int32) { }

async func inner() Box1785 {
    return Box1785(42)
}

async func getVal() Box1785? {
    let v = await inner()
    return v
}

let opt = getVal().Result
let b = opt ?? Box1785(0)
Console.WriteLine(b.X)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1785_exe_").FullName
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
    }
}
