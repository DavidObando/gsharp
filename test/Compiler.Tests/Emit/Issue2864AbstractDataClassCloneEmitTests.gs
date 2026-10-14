// <copyright file="Issue2864AbstractDataClassCloneEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2864 — `DataStructSynthesizer.EmitDataClassClone` gave every
/// data class a `<Clone>$` whose body is
/// `ldarg.0; newobj <copy ctor>; ret`. A data class is ABSTRACT when
/// its effective member set still contains a no-body `open` member
/// (`StructSymbol.IsAbstract`, #987), and `newobj` of an abstract
/// type is rejected by ilverify with `NewobjAbstractClass`.
///
/// Issue #2871 restores the C# record shape: abstract data classes emit an
/// abstract `<Clone>$`, and derived data classes bind their
/// covariant-return clone to the base slot with MethodImpl metadata. The
/// MethodDef planner must reserve that row so every later method token remains
/// aligned.
open class Issue2864AbstractDataClassCloneEmitTests {
    @Fact
    func AbstractDataClassWithConcreteDerived_VerifiesAndRuns() {
        const source = `package i2864a

open data class Base {
    open prop Kind string {
        get;
    }
}

open data class Derived(Value int32) : Base {
    open override prop Kind string -> "derived"
}

func Main() {
    let d = Derived(7)
    System.Console.WriteLine(d.Kind + ":" + d.Value.ToString())
}`
        Assert.Equal("derived:7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func AbstractDataClassWithUserMethods_KeepsMethodTokensAligned() {
        // The planner and emitter must both include the abstract `<Clone>$`
        // row. Any disagreement shifts every later MethodDef token in the type
        // and corrupts unrelated call sites rather than failing locally.
        const source = `package i2864b

open data class Shape {
    open prop Name string {
        get;
    }

    func Describe() string -> "shape:" + this.Name

    func Twice() string -> this.Describe() + "/" + this.Describe()
}

open data class Square(Side int32) : Shape {
    open override prop Name string -> "square"

    func Area() int32 -> this.Side * this.Side
}

func Main() {
    let s = Square(4)
    System.Console.WriteLine(s.Twice() + "|" + s.Area().ToString())
}`
        Assert.Equal("shape:square/shape:square|16${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func AbstractDataClassWithUserToStringOverride_ComposesWithExistingSkips() {
        // Issue #2361 already removes one reserved row for a hand-written
        // ToString; the new abstract skip must compose with it rather than
        // replace it.
        const source = `package i2864c

open data class Base {
    open prop Kind string {
        get;
    }

    func Describe() string -> "kind=" + this.Kind

    open override func ToString() string -> "base<" + this.Kind + ">"

    func Shout() string -> this.Describe() + "!"
}

open data class Leaf(Id int32) : Base {
    open override prop Kind string -> "leaf"
}

func Main() {
    let l = Leaf(3)
    System.Console.WriteLine(l.Shout() + "|" + l.ToString() + "|" + l.Id.ToString())
}`
        // `Leaf` synthesizes its OWN ToString, which overrides the base's
        // hand-written one — that is ordinary data-class behaviour. What
        // matters here is that `Base` reserves 10 - 1 (ToString) rows,
        // including its abstract Clone row, so `Describe` and `Shout` still
        // resolve to the right tokens.
        Assert.Equal("kind=leaf!|Leaf { Kind = leaf, Id = 3 }|3${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ConcreteDataClass_StillEmitsWorkingSynthesizedMembers() {
        // Control: a data class that is NOT abstract keeps every synthesized
        // member, including `<Clone>$`, and its rows stay aligned.
        const source = `package i2864d

open data class Point(X int32, Y int32) {
    func Sum() int32 -> this.X + this.Y
}

func Main() {
    let p = Point(2, 5)
    System.Console.WriteLine(p.Sum().ToString() + "|" + p.ToString())
}`
        let output = CompileAndRun(source)
        Assert.StartsWith("7|", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2864_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                Compile([]string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath})
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
                } catch (IOException) { }
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
