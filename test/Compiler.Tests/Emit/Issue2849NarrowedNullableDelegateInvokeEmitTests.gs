// <copyright file="Issue2849NarrowedNullableDelegateInvokeEmitTests.cs" company="GSharp">
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

/// Issue #2849 — a narrowed nullable imported generic delegate lost its
/// symbolic receiver type before emit, so `Invoke` was parented at the
/// erased `Action<object>` instead of the reified
/// `Action<Src>`.
open class Issue2849NarrowedNullableDelegateInvokeEmitTests {
    @Fact
    func EndToEnd_ImportedDelegateTruthTable_VerifiesAndRuns() {
        const source = `package i2849truth
import System

class Src { prop N int32 -> 2 }
struct Pt { var X int32 }

func Main() {
    let f System.Action[Src] = (s Src) -> System.Console.WriteLine(s.N)

    var d System.Action[Src] = f
    d(Src())

    var n System.Action[Src]? = f
    if n != nil {
        n(Src())
    }

    var workaround System.Action[Src]? = f
    if workaround != nil {
        let invoke System.Action[Src] = workaround
        invoke(Src())
    }

    var bcl System.Action[int32]? = (x int32) -> System.Console.WriteLine(x)
    if bcl != nil {
        bcl(1)
    }

    let writePt System.Action[Pt] = (p Pt) -> System.Console.WriteLine(p.X)
    var ptAction System.Action[Pt]? = writePt
    if ptAction != nil {
        var q Pt
        q.X = 5
        ptAction(q)
    }

    let readPt System.Func[Pt,int32] = (p Pt) -> p.X + 1
    var ptFunc System.Func[Pt,int32]? = readPt
    if ptFunc != nil {
        var q Pt
        q.X = 6
        System.Console.WriteLine(ptFunc(q))
    }
}`
        Assert.Equal(
            "2${Environment.NewLine}2${Environment.NewLine}2${Environment.NewLine}1${Environment.NewLine}5${Environment.NewLine}7${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func EndToEnd_SameCompilationNamedDelegate_VerifiesAndRuns() {
        const source = `package i2849namedsame
import System

class Src { prop N int32 -> 21 }
delegate Handler[T](value T) void;

func Main() {
    let write Handler[Src] = (s Src) -> System.Console.WriteLine(s.N)
    var handler Handler[Src]? = write
    if handler != nil {
        handler(Src())
    }
}`
        Assert.Equal("21${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_NarrowedImportedDelegateReceiverShapes_VerifyAndRun() {
        const source = `package i2849shapes
import System

class Src { prop N int32 -> 22 }

class Holder {
    let Field System.Action[Src]?
    prop Property System.Action[Src]? { get; init; }

    init(value System.Action[Src]?) {
        Field = value
        Property = value
    }

    func Run() {
        if Field != nil {
            Field(Src())
        }
        if Property != nil {
            Property(Src())
        }
    }
}

func InvokeParameter(handler System.Action[Src]?) {
    if handler != nil {
        handler(Src())
    }
}

func Main() {
    let write System.Action[Src] = (s Src) -> System.Console.WriteLine(s.N)

    InvokeParameter(write)
    Holder(write).Run()

    var optional System.Action[Src]? = write
    if let narrowed = optional {
        narrowed(Src())
    }

    (optional ?? write)(Src())
}`
        Assert.Equal(
            "22${Environment.NewLine}22${Environment.NewLine}22${Environment.NewLine}22${Environment.NewLine}22${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func EndToEnd_IsNarrowedImportedDelegate_VerifiesAndRuns() {
        const source = `package i2849isnarrowed
import System

class Src { prop N int32 -> 8 }

func Run(value object) {
    if value is System.Action[Src] {
        value(Src())
    }
}

func Main() {
    let write System.Action[Src] = (s Src) -> System.Console.WriteLine(s.N)
    Run(write)
}`
        Assert.Equal("8${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_QualifiedStableMemberPath_VerifiesAndRuns() {
        const source = `package i2849qualified
import System

class Src { prop N int32 -> 7 }

class Inner {
    let H System.Action[Src]?
    init(h System.Action[Src]?) { H = h }
}

class Outer {
    let B Inner
    init(b Inner) { B = b }
}

func Main() {
    let write System.Action[Src] = (s Src) -> System.Console.WriteLine(s.N)
    let outer = Outer(Inner(write))
    if outer.B.H != nil {
        outer.B.H(Src())
    }
}`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func EndToEnd_CrossAssemblyImportedAndNamedDelegates_VerifyAndRun() {
        const library = `package i2849matrixlib
import System

delegate Handler[T](value T) void;

class ImportedRelay[T] {
    func Run(handler System.Action[T]?, value T) {
        if handler != nil {
            handler(value)
        }
    }
}

class NamedRelay[T] {
    func Run(handler Handler[T]?, value T) {
        if handler != nil {
            handler(value)
        }
    }
}`
        const consumer = `package i2849matrixuse
import System
import i2849matrixlib

class Src { prop N int32 -> 23 }

func Main() {
    let imported System.Action[Src] = (s Src) -> System.Console.WriteLine(s.N)
    ImportedRelay[Src]().Run(imported, Src())

    let named Handler[Src] = (s Src) -> System.Console.WriteLine(s.N + 1)
    NamedRelay[Src]().Run(named, Src())
}`
        Assert.Equal(
            "23${Environment.NewLine}24${Environment.NewLine}",
            CompileAndRun(consumer, library, "i2849matrixlib")
        )
    }

    @Fact
    func EndToEnd_CrossAssemblyNamedDelegateWithConsumerSourceType_VerifiesAndRuns() {
        const library = `package i2849lib2

delegate Handler[T](value T) void;`
        const consumer = `package i2849use2
import System
import i2849lib2

class Src { prop N int32 -> 9 }

func Main() {
    let handler Handler[Src] = (s Src) -> System.Console.WriteLine(s.N)
    var optional Handler[Src]? = handler
    if optional != nil {
        optional(Src())
    }
}`
        Assert.Equal("9${Environment.NewLine}", CompileAndRun(consumer, library, "i2849lib2"))
    }

    shared {
        private func CompileAndRun(source string, library string? = nil, libraryAssemblyName string? = nil) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2849_exe_").FullName
            try {
                var libDll string? = nil
                if library != nil {
                    let libSrc = Path.Combine(tempDir, libraryAssemblyName + ".gs")
                    libDll = Path.Combine(tempDir, libraryAssemblyName + ".dll")
                    File.WriteAllText(libSrc, library)
                    Compile([]string{"/out:" + libDll, "/target:library", "/targetframework:net10.0", libSrc})
                    IlVerifier.Verify(libDll)
                }
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0"}
                if libDll != nil {
                    args.Add("/r:" + libDll)
                }
                args.Add(srcPath)
                Compile(args.ToArray())
                IlVerifier.Verify(
                    dllPath,
                    if libDll != nil {
                        []string{libDll}
                    } else {
                        default([]?string)
                    }
                )
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

        private func Compile(args[]string) {
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
        }
    }
}
