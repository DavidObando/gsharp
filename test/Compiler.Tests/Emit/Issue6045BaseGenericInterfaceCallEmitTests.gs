// <copyright file="Issue6045BaseGenericInterfaceCallEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #6045: end-to-end CLR emit + ILVerify + runtime execution coverage for
/// constructed generic base-interface calls across classes, structs, generic
/// types, properties, generic methods, async/lambdas, and imported C# DIMs.
open class Issue6045BaseGenericInterfaceCallEmitTests {
    @Fact
    func ExactRepro_ConstructedGenericBaseInterface_VerifiesAndRuns() {
        let source = `package Probe
import System

interface IDefault[T] {
    func Read() T { return default(T) }
}

class C : IDefault[int32] {
    func Value() int32 -> base[IDefault[int32]].Read()
}

System.Console.WriteLine(C().Value())`
        Assert.Equal("0${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ConstructedGenericBaseInterface_ClassAndStructAndGenericClass_VerifyAndRun() {
        let source = `package Probe
import System
import System.Threading.Tasks

interface IBase[T] {
    func Scale(v T) T { return v }
    prop BaseProp T {
        get { return default(T) }
    }
}

interface IDefault[T] : IBase[T] {
    func Echo(v T) T { return v }
    func Map[U](v T, f (T) -> U) U { return f(v) }
    func Pair[U](v T, u U) (T, U) { return (v, u) }
    prop Value T {
        get { return default(T) }
        set { }
    }
}

class Dual : IDefault[int32], IDefault[string] {
    func Echo(v int32) int32 -> 999
    func Echo(v string) string -> "override"
    func Run() string {
        base[IDefault[int32]].Value = 5
        let a = base[IDefault[int32]].Echo(41) + 1
        let b = base[IDefault[string]].Echo("hi") + "!"
        let c = base[IDefault[int32]].Scale(7)
        let d = base[IDefault[int32]].Map[string](9, (x int32) -> "m:${x}")
        let (p1, p2) = base[IDefault[string]].Pair("k", 3)
        let bp = base[IBase[int32]].BaseProp + base[IDefault[int32]].Value
        return "${a}|${b}|${c}|${d}|${p1}:${p2}|${bp}"
    }
    async func RunAsync() int32 {
        await Task.Yield()
        return base[IDefault[int32]].Echo(33)
    }
    func RunLambda() int32 {
        let fn = () -> base[IDefault[int32]].Echo(44)
        return fn()
    }
}

struct ValueImpl : IDefault[int32] {
    func Echo(v int32) int32 -> 999
    func Run() string {
        let a = base[IDefault[int32]].Echo(12)
        let b = base[IDefault[int32]].Map[string](8, (x int32) -> "s:${x}")
        return "${a}|${b}"
    }
}

class GenericImpl[U] : IDefault[U] {
    func Echo(v U) U -> base[IDefault[U]].Echo(v)
}

let d = Dual()
Console.WriteLine(d.Run())
Console.WriteLine(d.RunAsync().GetAwaiter().GetResult())
Console.WriteLine(d.RunLambda())
let s = ValueImpl{}
Console.WriteLine(s.Run())
Console.WriteLine(GenericImpl[int32]().Echo(77))
Console.WriteLine(GenericImpl[string]().Echo("ok"))`
        let expected = string.Join(Environment.NewLine, "42|hi!|7|m:9|k:3|0", "33", "44", "12|s:8", "77", "ok") +
            Environment.NewLine
        Assert.Equal(expected, CompileAndRun(source))
    }

    @Fact
    func ConstructedGenericBaseInterface_EmitsNonVirtualCall_AndPassesIlVerify() {
        let source = `package Probe

interface IDefault[T] {
    func Echo(v T) T { return v }
}

class C : IDefault[int32] {
    func Echo(v int32) int32 -> base[IDefault[int32]].Echo(v) + 1
}`
        let dllPath = CompileLibrary(source)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            var echoMethod MethodDefinitionHandle? = nil
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if !reader.StringComparer.Equals(td.Name, "C") {
                    continue
                }
                for mh in td.GetMethods() {
                    let md = reader.GetMethodDefinition(mh)
                    if reader.StringComparer.Equals(md.Name, "Echo") {
                        echoMethod = mh
                    }
                }
            }
            Assert.True(echoMethod != nil, "expected C::Echo")
            let method = reader.GetMethodDefinition(echoMethod!!)
            let body = peReader.GetMethodBody(method.RelativeVirtualAddress)
            let ilBytes[]?uint8 = body.GetILBytes()
            Assert.NotNull(ilBytes)
            var sawCall = false
            var sawCallvirt = false
            for b in ilBytes!! {
                if b == uint8(0x28) {
                    sawCall = true
                } else if b == uint8(0x6F) {
                    sawCallvirt = true
                }
            }
            Assert.True(sawCall, "C::Echo must use `call` for base[IDefault[int32]].Echo")
            Assert.False(sawCallvirt, "C::Echo must NOT use `callvirt`")
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func ImportedCSharpDim_ConstructedGenericBaseInterface_VerifiesAndRuns() {
        let csSource = `using System;
namespace ProbeClr
{
    public interface IClrDefault<T>
    {
        T Read() => default!;
        T Echo(T value) => value;
        U Map<U>(T value, Func<T, U> f) => f(value);
        T Prop => default!;
    }
}`
        using let fixture = CSharpFixture(csSource, assemblyName: "ProbeClrDim")
        let gsSource = `package Probe
import System
import ProbeClr

class Item {
    var Tag string
    init(tag string) { Tag = tag }
}

class ClassInt : IClrDefault[int32] {
    func Echo(v int32) int32 -> 999
    func Run() string {
        let a = base[IClrDefault[int32]].Echo(41) + 1
        let b = base[IClrDefault[int32]].Map[string](9, (x int32) -> "c:${x}")
        let c = base[IClrDefault[int32]].Prop
        return "${a}|${b}|${c}"
    }
}

class ClassItem : IClrDefault[Item] {
    func Echo(v Item) Item -> Item("override")
    func Run(item Item) string {
        return base[IClrDefault[Item]].Echo(item).Tag
    }
}

struct StructInt : IClrDefault[int32] {
    func Echo(v int32) int32 -> 999
    func Run() int32 -> base[IClrDefault[int32]].Echo(23) + base[IClrDefault[int32]].Read()
}

Console.WriteLine(ClassInt().Run())
Console.WriteLine(ClassItem().Run(Item("user")))
Console.WriteLine(StructInt{}.Run())`
        let output = CompileAndRunWithReference(gsSource, fixture.AssemblyPath)
        let expected = string.Join(Environment.NewLine, "42|c:9|0", "user", "23") + Environment.NewLine
        Assert.Equal(expected, output)
    }

    shared {
        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_6045_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
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
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func CompileAndRun(source string, referenceDll string? = nil) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_6045_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0"}
                if referenceDll != nil {
                    args.Add("/reference:" + referenceDll)
                    for reference in TrustedPlatformAssemblies() {
                        args.Add("/reference:" + reference)
                    }
                    args.Add("/nowarn:GS9100")
                }
                args.Add(srcPath)
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                if referenceDll != nil {
                    File.Copy(referenceDll, Path.Combine(tempDir, Path.GetFileName(referenceDll)), overwrite: true)
                    IlVerifier.Verify(dllPath, additionalReferences: []string{referenceDll})
                } else {
                    IlVerifier.Verify(dllPath)
                }
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

        private func CompileAndRunWithReference(source string, referenceDll string) string {
            return CompileAndRun(source, referenceDll)
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

        private func TryCleanup(dllPath string) {
            try {
                let dir string? = Path.GetDirectoryName(dllPath)
                if dir != nil && Directory.Exists(dir) {
                    Directory.Delete(dir, recursive: true)
                }
            } catch { }
        }
    }
}
