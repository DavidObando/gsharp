// <copyright file="Issue1239CoalesceCommonTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #1239: the null-coalescing operator `a ?? b` must compute the
/// C# §12.15 best common type rather than requiring both operands to share an
/// exact type. When the right operand implicitly converts to the left's
/// non-null type the result is that type; otherwise, when the left's non-null
/// type implicitly converts to the right operand's type (a reference upcast /
/// interface implementation or a numeric widening), the result is the right
/// type. Both branches are emitted with the conversions required so the
/// produced value matches the operator's result type.
///
/// Each test compiles via `gsc`, IL-verifies the produced PE, then executes
/// it under `dotnet exec` and asserts on captured stdout.
open class Issue1239CoalesceCommonTypeEmitTests {
    @Fact
    func RightImplementsInterface_ResultIsInterface() {
        let source = `package P

import System

interface IFoo { func Bar() int32; }
class Foo : IFoo { func Bar() int32 { return 1 } }
class Baz : IFoo { func Bar() int32 { return 2 } }

func Pick(f Foo?, g IFoo) IFoo {
    return f ?? g
}

let present Foo = Foo()
let g IFoo = Baz()
Console.WriteLine(Pick(present, g).Bar().ToString())
Console.WriteLine(Pick(nil, g).Bar().ToString())`
        let output = CompileAndRun(source)
        // Non-null left -> Foo.Bar() == 1; nil left -> Baz.Bar() == 2.
        Assert.Equal("1${Environment.NewLine}2${Environment.NewLine}", output)
    }

    @Fact
    func RightSubtypeAndDelegateFactory_ConvertToNullableLeftTypes() {
        let source = `package P

import System

interface ILogger { func Name() string; }
class RealLogger : ILogger { func Name() string { return "real" } }
class NullLogger : ILogger { func Name() string { return "null" } }

func PickLogger(logger ILogger?) ILogger {
    return logger ?? NullLogger()
}

func PickFactory(factory (() -> ILogger)?) () -> ILogger {
    return factory ?? (() -> NullLogger())
}

var realFactory (() -> ILogger) = () -> RealLogger()
Console.WriteLine(PickLogger(RealLogger()).Name())
Console.WriteLine(PickLogger(nil).Name())
Console.WriteLine(PickFactory(realFactory)().Name())
Console.WriteLine(PickFactory(nil)().Name())`
        let output = CompileAndRun(source)
        Assert.Equal(
            "real${Environment.NewLine}null${Environment.NewLine}real${Environment.NewLine}null${Environment.NewLine}",
            output
        )
    }

    @Fact
    func NullableRightSubtype_ConvertsToNullableLeftInterface() {
        let source = `package P

import System

interface ILogger { func Name() string; }
class NullLogger : ILogger { func Name() string -> "null" }

func Pick(logger ILogger?, fallback NullLogger?) ILogger? {
    var selected = logger ?? fallback
    return selected
}

Console.WriteLine(Pick(nil, NullLogger())!!.Name())
Console.WriteLine(Pick(nil, nil) == nil)`
        let output = CompileAndRun(source)
        Assert.Equal("null${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func RightIsBaseClass_ResultIsBaseClass() {
        let source = `package P

import System

open class Animal { open func Speak() int32 { return 10 } }
class Dog : Animal { override func Speak() int32 { return 20 } }

func Pick(d Dog?, a Animal) Animal {
    return d ?? a
}

let dog Dog = Dog()
let baseAnimal Animal = Animal()
Console.WriteLine(Pick(dog, baseAnimal).Speak().ToString())
Console.WriteLine(Pick(nil, baseAnimal).Speak().ToString())`
        let output = CompileAndRun(source)
        // Non-null left -> Dog.Speak() == 20; nil left -> Animal.Speak() == 10.
        Assert.Equal("20${Environment.NewLine}10${Environment.NewLine}", output)
    }

    @Fact
    func NumericWidening_RightWidensToLeftUnderlying_ResultIsLeftType() {
        let source = `package P

import System

func Coalesce(a int32?, b uint16) int32 {
    return a ?? b
}

let seven uint16 = 7
Console.WriteLine(Coalesce(100, seven).ToString())
Console.WriteLine(Coalesce(nil, seven).ToString())`
        let output = CompileAndRun(source)
        // Non-null left -> 100 (int32); nil left -> 7 widened from uint16.
        Assert.Equal("100${Environment.NewLine}7${Environment.NewLine}", output)
    }

    @Fact
    func NumericWidening_LeftWidensToRight_ResultIsRightType() {
        let source = `package P

import System

func Coalesce(a int32?, b int64) int64 {
    return a ?? b
}

let big int64 = 9000000000
Console.WriteLine(Coalesce(100, big).ToString())
Console.WriteLine(Coalesce(nil, big).ToString())`
        let output = CompileAndRun(source)
        // Non-null left -> 100 widened to int64; nil left -> 9000000000.
        Assert.Equal("100${Environment.NewLine}9000000000${Environment.NewLine}", output)
    }

    @Fact
    func ExplicitTargetType_BindsThroughInterface() {
        let source = `package P

import System

interface IFoo { func Bar() int32; }
class Foo : IFoo { func Bar() int32 { return 42 } }
class Baz : IFoo { func Bar() int32 { return 7 } }

func WithTarget(f Foo?, g IFoo) int32 {
    let r IFoo = f ?? g
    return r.Bar()
}

Console.WriteLine(WithTarget(Foo(), Baz()).ToString())
Console.WriteLine(WithTarget(nil, Baz()).ToString())`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}7${Environment.NewLine}", output)
    }

    @Fact
    func SameType_StillWorks() {
        let source = `package P

import System

class Foo { func Bar() int32 { return 5 } }

func Same(f Foo?, g Foo) Foo {
    return f ?? g
}

Console.WriteLine(Same(Foo(), Foo()).Bar().ToString())
Console.WriteLine(Same(nil, Foo()).Bar().ToString())`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}5${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source)
            Assert.True(exitCode == 0, (`exited ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1239_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                for bcl in BclReferences.Value {
                    args.Add("/r:" + bcl)
                }
                args.Add(srcPath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
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
                return (
                    proc.ExitCode,
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    stderr.ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                if string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir) {
                    return Array.Empty[string]()
                }
                return Directory
                    .EnumerateFiles(runtimeDir!!, "*.dll", SearchOption.TopDirectoryOnly)
                    .Where(
                    (p string) -> {
                        let name = Path.GetFileName(p)
                        return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase) || string.Equals(
                            name,
                            "mscorlib.dll",
                            StringComparison.OrdinalIgnoreCase
                        ) ||
                            string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase)
                    }
                )
                    .ToList()
            }
        )
    }
}
