// <copyright file="Issue1521NestedTypeInGenericEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1521 — a type declared as a nested type inside a <b>generic</b> user
/// type (`struct Tag` inside `struct Box[T any]`) emitted
/// unverifiable IL. Referencing/constructing the nested type from a
/// <em>constructed</em> context (e.g. `b.MakeTag().Name` where
/// `b : Box[int32]`) parented the member reference at the <b>open</b>
/// self-instantiation `Box`1+Tag`1<!0>` instead of the constructed
/// `Box`1+Tag`1<int32>`, so ilverify reported
/// `StackUnexpected` and the runtime threw a type-load error.
///
/// The fix threads the enclosing construction's type arguments onto the nested
/// type as (cref:GSharp.Core.CodeAnalysis.Symbols.StructSymbol.EnclosingTypeArguments):
/// from a constructed context the nested reference/slot encodes the concrete
/// enclosing arguments (`<int32>`); from within the enclosing
/// generic's own members it stays the open self-instantiation
/// (`<!0>`). The same threading is applied by the binder both for a
/// nested type surfaced from a constructed enclosing member (return of
/// `Box[int32].MakeTag()`) and for an external per-segment nested
/// type-clause (`Box[int32].Tag`, issue #1506 syntax), so the two
/// representations are reference-equal and interconvertible.
///
/// Each test uses a UNIQUE package/type name because the in-process
/// `FunctionTypeSymbol` cache is name-keyed and not cleared between tests.
open class Issue1521NestedTypeInGenericEmitTests {
    @Fact
    func EndToEnd_BaseRepro_NestedStructInSingleParamGeneric_VerifiesAndRuns() {
        // The exact issue repro: `b.MakeTag().Name` (nested type surfaced from a
        // constructed enclosing member) PLUS the external `Box[int32].Tag`
        // per-segment type-clause used in local/parameter positions.
        const source = `package Issue1521BaseRepro
import System

struct Issue1521Box[T any] {
    var Value T
    struct TagBase { var Name string }
    func MakeTag() TagBase { return TagBase{Name: "hi"} }
}

func Issue1521GrabBase(t Issue1521Box[int32].TagBase) string { return t.Name }

func Main() {
    var b = Issue1521Box[int32]{Value: 5}
    System.Console.WriteLine(b.MakeTag().Name)
    var t Issue1521Box[int32].TagBase = b.MakeTag()
    System.Console.WriteLine(Issue1521GrabBase(t))
}`
        let output = CompileAndRun(source)
        Assert.Equal("hi${Environment.NewLine}hi${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_MultiArity_NestedStructInTwoParamGeneric_VerifiesAndRuns() {
        // Generalization: a nested type of a MULTI-parameter generic must thread
        // the full flattened enclosing vector (`Pair`2+Tag`2<int32, string>`),
        // both internally (return of MakeTag) and externally (type-clause).
        const source = `package Issue1521MultiArity
import System

struct Issue1521Pair[K any, V any] {
    var A K
    var B V
    struct TagPair { var Name string }
    func MakeTag() TagPair { return TagPair{Name: "pair"} }
}

func Issue1521GrabPair(t Issue1521Pair[int32, string].TagPair) string { return t.Name }

func Main() {
    var p = Issue1521Pair[int32, string]{A: 1, B: "x"}
    System.Console.WriteLine(p.MakeTag().Name)
    var t Issue1521Pair[int32, string].TagPair = p.MakeTag()
    System.Console.WriteLine(Issue1521GrabPair(t))
}`
        let output = CompileAndRun(source)
        Assert.Equal("pair${Environment.NewLine}pair${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NestedTypeAsFieldParamReturnLocal_VerifiesAndRuns() {
        // Generalization: the nested type used as a FIELD of the enclosing
        // generic, a PARAMETER and LOCAL of its members, and a RETURN — every
        // signature/slot position that previously risked encoding `<!0>` in a
        // constructed context.
        const source = `package Issue1521FieldParamLocal
import System

struct Issue1521BoxFPL[T any] {
    var Value T
    struct TagFPL { var Name string }
    var Marker TagFPL
    func Init() { Marker = TagFPL{Name: "field"} }
    func Combine(a TagFPL) string {
        var local TagFPL = a
        return local.Name
    }
    func MakeTag() TagFPL { return TagFPL{Name: "ret"} }
}

func Main() {
    var b = Issue1521BoxFPL[int32]{Value: 5}
    b.Init()
    System.Console.WriteLine(b.Combine(b.Marker))
    System.Console.WriteLine(b.MakeTag().Name)
}`
        let output = CompileAndRun(source)
        Assert.Equal("field${Environment.NewLine}ret${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NestedMemberUsesOuterTypeParameter_VerifiesAndRuns() {
        // Generalization: the nested type's OWN member references the enclosing
        // type parameter (`TagT.V : T`). On a constructed context this must
        // surface `T` as `int32` (both in the field signature and in the
        // `newobj`/field-access token), which is impossible with the open
        // `<!0>` self-instantiation.
        const source = `package Issue1521OuterTypeParam
import System

struct Issue1521BoxT[T any] {
    var Value T
    struct TagT { var V T }
    func MakeTag() TagT { return TagT{V: Value} }
}

func Main() {
    var b = Issue1521BoxT[int32]{Value: 7}
    System.Console.WriteLine(b.MakeTag().V)
}`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NestedEnumInGeneric_VerifiesAndRuns() {
        // Generalization: a nested ENUM inside a generic (a non-generic nested
        // type) must reference/emit cleanly from a constructed context.
        const source = `package Issue1521NestedEnum
import System

struct Issue1521BoxEnum[T any] {
    var Value T
    enum KindEnum { A, B, C }
    func MakeKind() KindEnum { return KindEnum.B }
}

func Main() {
    var b = Issue1521BoxEnum[int32]{Value: 5}
    System.Console.WriteLine(b.MakeKind().ToString())
}`
        let output = CompileAndRun(source)
        Assert.Equal("B${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NestedInterfaceInGeneric_VerifiesAndRuns() {
        // Generalization: a nested INTERFACE and a nested struct implementing it
        // inside a generic must reference/emit cleanly from a constructed
        // context.
        const source = `package Issue1521NestedInterface
import System

struct Issue1521BoxIface[T any] {
    var Value T
    interface GreeterIface { func Greet() string; }
    struct ImplIface : GreeterIface { func Greet() string { return "hello" } }
    func MakeGreeter() GreeterIface { return ImplIface{} }
}

func Main() {
    var b = Issue1521BoxIface[int32]{Value: 5}
    var g = b.MakeGreeter()
    System.Console.WriteLine(g.Greet())
}`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NonGenericNestedControl_StillVerifiesAndRuns() {
        // Control: the SAME nested-type shape inside a NON-generic enclosing type
        // verified clean before the fix and must remain clean after it.
        const source = `package Issue1521NonGenericControl
import System

struct Issue1521Outer {
    struct TagCtl { var Name string }
    func Make() TagCtl { return TagCtl{Name: "ctl"} }
}

func Main() {
    var o = Issue1521Outer{}
    System.Console.WriteLine(o.Make().Name)
    var t Issue1521Outer.TagCtl = o.Make()
    System.Console.WriteLine(t.Name)
}`
        let output = CompileAndRun(source)
        Assert.Equal("ctl${Environment.NewLine}ctl${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1521_exe_").FullName
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
