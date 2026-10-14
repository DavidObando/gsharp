// <copyright file="Issue1256ElementWiseTupleConversionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1256: an element-wise implicit tuple conversion `(T1, …, Tn) -> (U1, …, Un)`
/// (each `Ti -> Ui` implicit) must bind AND emit. The source and target
/// `ValueTuple<…>` are different CLR instantiations, so a direct reinterpret
/// is not verifiable IL; the binder rebuilds the destination tuple from per-element
/// converted accesses. These tests prove the rebuilt tuple round-trips the original
/// element objects (identity preserved through a reference upcast) and that mixed
/// conversions (reference upcast + numeric widening) produce the correct values.
open class Issue1256ElementWiseTupleConversionEmitTests {
    @Fact
    func DerivedElementUpcast_AsArgument_PreservesIdentity() {
        let source = `package Test
import System

class A { func Name() string { return "A!" } }
open class Base { func Tag() int32 { return 5 } }
class Derived : Base { func Extra() int32 { return 9 } }

func Take(t (A, Base)) string {
    return t.Item1.Name() + ":" + t.Item2.Tag().ToString()
}

let a A = A()
let d Derived = Derived()
Console.WriteLine(Take((a, d)))`
        let output = CompileAndRun(source)
        Assert.Equal("A!:5${Environment.NewLine}", output)
    }

    @Fact
    func DerivedElementUpcast_LetTarget_PreservesIdentity() {
        let source = `package Test
import System

open class Base { func Tag() int32 { return 5 } }
class Derived : Base { func Extra() int32 { return 9 } }

let d Derived = Derived()
let t (Base, int32) = (d, 3)
Console.WriteLine(t.Item1.Tag().ToString() + "," + t.Item2.ToString())`
        let output = CompileAndRun(source)
        Assert.Equal("5,3${Environment.NewLine}", output)
    }

    @Fact
    func ConcreteElementToInterface_AsArgument_RoundTrips() {
        let source = `package Test
import System

interface IShape { func Area() int32; }
class Square : IShape { func Area() int32 { return 16 } }
class A { func N() int32 { return 1 } }

func Take(t (A, IShape)) int32 { return t.Item1.N() + t.Item2.Area() }

let a A = A()
let sq Square = Square()
Console.WriteLine(Take((a, sq)))`
        let output = CompileAndRun(source)
        Assert.Equal("17${Environment.NewLine}", output)
    }

    @Fact
    func ThreeElementMixed_UpcastAndWidening_ProducesCorrectValues() {
        let source = `package Test
import System

class A { func N() int32 { return 1 } }
open class Base { func Tag() int32 { return 5 } }
class Derived : Base {}

func Take(t (A, Base, int64)) string {
    return t.Item1.N().ToString() + ":" + t.Item2.Tag().ToString() + ":" + t.Item3.ToString()
}

let a A = A()
let d Derived = Derived()
let small int32 = 7
Console.WriteLine(Take((a, d, small)))`
        let output = CompileAndRun(source)
        Assert.Equal("1:5:7${Environment.NewLine}", output)
    }

    @Fact
    func NullableDerivedElement_To_NullableBaseElement_RoundTrips() {
        let source = `package Test
import System

class A {}
open class Base { func Tag() int32 { return 5 } }
class Derived : Base {}

func Read(t (A, Base?)) int32 {
    let b Base? = t.Item2
    if b != nil {
        return b.Tag()
    }
    return -1
}

let a A = A()
let dn Derived? = Derived()
Console.WriteLine(Read((a, dn)))`
        let output = CompileAndRun(source)
        Assert.Equal("5${Environment.NewLine}", output)
    }

    @Fact
    func DerivedElementUpcast_ReturnPosition_PreservesIdentity() {
        let source = `package Test
import System

class A { func Name() string { return "A!" } }
open class Base { func Tag() int32 { return 5 } }
class Derived : Base {}

func Make(a A, d Derived) (A, Base) {
    return (a, d)
}

let a A = A()
let d Derived = Derived()
let t (A, Base) = Make(a, d)
Console.WriteLine(t.Item1.Name() + ":" + t.Item2.Tag().ToString())`
        let output = CompileAndRun(source)
        Assert.Equal("A!:5${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source)
            Assert.True(exitCode == 0, (`gsc failed (exit ` + "$exitCode" + `):
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1256_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
                for reference in TrustedPlatformAssemblies() {
                    args.Add("/reference:" + reference)
                }
                args.Add("/nowarn:GS9100")
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
                if compileExit != 0 {
                    return (compileExit, compileOut.ToString(), compileErr.ToString())
                }
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

        private func TrustedPlatformAssemblies() sequence[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                yield break
            }
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }
    }
}
