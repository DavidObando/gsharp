// <copyright file="Issue502AsyncUserClassReturnTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import System.Threading.Tasks
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Threading

/// Regression tests for issue #502 (remaining facet): `async func`
/// returning a user-defined G# class type must correctly lift to
/// `Task<UserClass>`. Prior to this fix, the binder returned the
/// bare class type from `WrapAsTask` because
/// `StructSymbol.ClrType` is null during binding (TypeBuilder doesn't
/// exist yet). Callers saw the bare type and `await` rejected with
/// `GS0133`.
open class Issue502AsyncUserClassReturnTypeTests {
    @Fact
    func AsyncFunc_ReturnsPrimaryCtorClass_AwaitWorks() {
        let source = `package P

import System
import System.Threading.Tasks

class AsyncPC(Value int32) {}

class Probe {
    async func MakePC() AsyncPC {
        await Task.Delay(1)
        return AsyncPC(7)
    }

    async func Pc_Roundtrip() {
        let r = await this.MakePC()
        Console.WriteLine(r.Value)
    }
}

let p = Probe()
p.Pc_Roundtrip().Wait()`
        let assembly = CompileToAssembly(source)
        let asyncPc = assembly.GetTypes().Single((t Type) -> t.Name == "AsyncPC")
        let probe = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let makePc MethodInfo? = probe.GetMethod("MakePC", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(makePc)
        Assert.Equal(typeof(Task[_]).MakeGenericType(asyncPc), makePc!!.ReturnType)
        InvokeWithHangGuard(GetEntryMethod(assembly))
    }

    @Fact
    func AsyncFunc_ReturnsClassWithInit_AwaitWorks() {
        let source = `package P

import System
import System.Threading.Tasks

class AsyncCC {
    var Value int32
    init() { Value = 0 }
}

class Probe {
    async func MakeCC() AsyncCC {
        await Task.Delay(1)
        var cc = AsyncCC()
        cc.Value = 42
        return cc
    }

    async func Cc_Roundtrip() {
        let r = await this.MakeCC()
        Console.WriteLine(r.Value)
    }
}

let p = Probe()
p.Cc_Roundtrip().Wait()`
        let assembly = CompileToAssembly(source)
        let asyncCc = assembly.GetTypes().Single((t Type) -> t.Name == "AsyncCC")
        let probe = assembly.GetTypes().Single((t Type) -> t.Name == "Probe")
        let makeCc MethodInfo? = probe.GetMethod("MakeCC", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(makeCc)
        Assert.Equal(typeof(Task[_]).MakeGenericType(asyncCc), makeCc!!.ReturnType)
        InvokeWithHangGuard(GetEntryMethod(assembly))
    }

    @Fact
    func AsyncFunc_ReturnsClassWithFields_RoundtripsValues() {
        let source = `package P

import System
import System.Threading.Tasks

class Container(X int32, Y int32) {}

class Svc {
    async func MakeContainer() Container {
        await Task.Delay(1)
        return Container(10, 20)
    }

    async func Run() {
        let c = await this.MakeContainer()
        Console.WriteLine(c.X + c.Y)
    }
}

let svc = Svc()
svc.Run().Wait()`
        let assembly = CompileToAssembly(source)
        let container = assembly.GetTypes().Single((t Type) -> t.Name == "Container")
        let svc = assembly.GetTypes().Single((t Type) -> t.Name == "Svc")
        let makeContainer MethodInfo? = svc.GetMethod("MakeContainer", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(makeContainer)
        Assert.Equal(typeof(Task[_]).MakeGenericType(container), makeContainer!!.ReturnType)
        let entry = GetEntryMethod(assembly)
        let stdout = CaptureStdout(() -> InvokeWithHangGuard(entry))
        Assert.Contains("30", stdout)
    }

    @Fact
    func AsyncFunc_ReturnsGenericUserClass_AwaitWorks() {
        // Generic user classes erase their type parameter to object in the
        // emitted IL (type-erased generics). The async Task<T> lift should
        // still work because the outer class is a reference type.
        let source = `package P

import System
import System.Threading.Tasks

class Box(Item int32) {}

class Svc {
    async func MakeBox() Box {
        await Task.Delay(1)
        return Box(99)
    }

    async func Run() {
        let b = await this.MakeBox()
        Console.WriteLine(b.Item)
    }
}

let svc = Svc()
svc.Run().Wait()`
        let assembly = CompileToAssembly(source)
        let box = assembly.GetTypes().Single((t Type) -> t.Name == "Box")
        let svc = assembly.GetTypes().Single((t Type) -> t.Name == "Svc")
        let makeBox MethodInfo? = svc.GetMethod("MakeBox", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(makeBox)
        Assert.Equal(typeof(Task[_]).MakeGenericType(box), makeBox!!.ReturnType)
        let entry = GetEntryMethod(assembly)
        let stdout = CaptureStdout(() -> InvokeWithHangGuard(entry))
        Assert.Contains("99", stdout)
    }

    @Fact
    func AwaitOnNonTaskUserStruct_StillErrors_GS0133() {
        // Negative test: a plain user-defined class without GetAwaiter()
        // must still produce GS0133 when someone attempts to await it
        // directly (not via an async method that returns it).
        let source = `package P

import System
import System.Threading.Tasks

class Point(X int32, Y int32) {}

async func Bad() {
    let p = Point(1, 2)
    let r = await p
    Console.WriteLine(r)
}`
        let (exitCode, stdout, _) = CompileRaw(source)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0133", stdout)
    }

    shared {
        private func GetEntryMethod(assembly Assembly) MethodInfo {
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            Assert.NotNull(entry)
            return entry!!
        }

        private func InvokeWithHangGuard(entry MethodInfo, timeoutMs int32 = 10000) {
            var captured Exception? = nil
            let thread = Thread(
                () -> {
                    try {
                        entry.Invoke(
                            nil,
                            if entry.GetParameters().Length == 0 {
                                default([]?object)
                            } else {
                                []object{Array.Empty[string]()}
                            }
                        )
                    } catch (ex Exception) {
                        captured = ex
                    }
                }
            )
            thread.IsBackground = true
            thread.Start()
            let finished = thread.Join(timeoutMs)
            Assert.True(
                finished,
                "Compiled entry-point did not complete within " + timeoutMs.ToString() +
                    " ms — async lowering hang (issue #502 regression)."
            )
            if captured != nil {
                throw InvalidOperationException("Compiled entry-point threw.", captured)
            }
        }

        private func CaptureStdout(action() -> void) string {
            let prevOut = Console.Out
            using let sw = StringWriter()
            Console.SetOut(sw)
            try {
                action()
            } finally {
                Console.SetOut(prevOut)
            }
            return sw.ToString()
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_502_user_class_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
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
            IlVerifier.Verify(outPath)
            return EmittedFixture.Load(outPath)
        }

        private func CompileRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_502_neg_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (compileExit, compileOut.ToString(), compileErr.ToString())
        }
    }
}
