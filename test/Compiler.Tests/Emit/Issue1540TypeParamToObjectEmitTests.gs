// <copyright file="Issue1540TypeParamToObjectEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #1540 — a generic type-parameter value `T` converting to a GENUINE
/// `object` slot (return, assignment, explicit cast, argument) was rejected
/// with `GS0155 'Cannot convert type T to object'`. Converting `T` to
/// `object` is always valid: a boxing conversion for a value `T`, a
/// reference conversion for a reference `T`, and `box !!T` (verifier
/// correct for both) for an unconstrained `T`.
///
/// The delicate part is that an ERASED open generic parameter slot (e.g. the
/// `!0` element type of `List[T].Add(!0)`, compiled inside the generic
/// method that declares `T`) presents as `System.Object` at the raw CLR
/// signature level, so a blanket `T -> object` boxing rule reintroduced the
/// #1196 regression (a spurious `box T` before the call → invalid IL). The
/// fix classifies `T -> object` as an implicit conversion but recovers the
/// real type-parameter slot for erased-`!0` arguments in
/// `ConversionClassifier.BindClrParameterConversions` — for both erased
/// RECEIVER slots (`List[T].Add`) and erased METHOD-level slots
/// (`Enumerable.Repeat[T]`) — so such arguments stay `T -> T` identity
/// (no box) while genuine `object` targets box.
///
/// Every test round-trips through compile → `IlVerifier.Verify` → run, so any
/// spurious box or missing box surfaces as invalid IL. The final two tests are
/// #1196 controls proving a `List[T].Add` / `Dictionary[K,V].Add`
/// argument still passes straight through with NO box. Each uses a UNIQUE
/// package/type name.
open class Issue1540TypeParamToObjectEmitTests {
    @Fact
    func ValueTypeParam_ImplicitReturn_Boxes_Roundtrips() {
        const source = `package i1540valimplicit
import System

class Ext {
    shared {
        func Box[T](val T) object { return val }
        func Back[T](o object) T { return T(o) }
    }
}

func Main() {
    let o = Ext.Box[int32](42)
    let back = Ext.Back[int32](o)
    System.Console.WriteLine(o)
    System.Console.WriteLine(back)
}`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}42${Environment.NewLine}", output)
    }

    @Fact
    func ValueTypeParam_ExplicitCast_Boxes() {
        const source = `package i1540valexplicit
import System

class Ext {
    shared {
        func Box[T](val T) object { return object(val) }
    }
}

func Main() { System.Console.WriteLine(Ext.Box[int32](7)) }`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func ValueTypeParam_LocalAssignment_Boxes() {
        const source = `package i1540valassign
import System

class Ext {
    shared {
        func Box[T](val T) object {
            let o object = val
            return o
        }
    }
}

func Main() { System.Console.WriteLine(Ext.Box[int32](9)) }`
        let output = CompileAndRun(source)
        Assert.Equal("9${Environment.NewLine}", output)
    }

    @Fact
    func ReferenceTypeParam_ImplicitReturn_ReferenceConversion() {
        const source = `package i1540refimplicit
import System

class Ext {
    shared {
        func Box[T](val T) object { return val }
        func Back[T](o object) T { return T(o) }
    }
}

func Main() {
    let o = Ext.Box[string]("hello")
    let back = Ext.Back[string](o)
    System.Console.WriteLine(o)
    System.Console.WriteLine(back)
}`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}hello${Environment.NewLine}", output)
    }

    @Fact
    func TypeParam_PassedToObjectParameter_Boxes() {
        const source = `package i1540objparam
import System

class Ext {
    shared {
        func Consume(o object) string { return o.ToString() ?? "" }
        func Feed[T](val T) string { return Ext.Consume(val) }
    }
}

func Main() {
    System.Console.WriteLine(Ext.Feed[int32](11))
    System.Console.WriteLine(Ext.Feed[string]("z"))
}`
        let output = CompileAndRun(source)
        Assert.Equal("11${Environment.NewLine}z${Environment.NewLine}", output)
    }

    @Fact
    func ClassConstrainedTypeParam_Boxes() {
        const source = `package i1540classconstraint
import System

class Ext {
    shared {
        func Box[T class](val T) object { return val }
    }
}

func Main() { System.Console.WriteLine(Ext.Box[string]("cc")) }`
        let output = CompileAndRun(source)
        Assert.Equal("cc${Environment.NewLine}", output)
    }

    @Fact
    func StructConstrainedTypeParam_Boxes_Roundtrips() {
        const source = `package i1540structconstraint
import System

class Ext {
    shared {
        func Box[T struct](val T) object { return object(val) }
        func Back[T struct](o object) T { return T(o) }
    }
}

func Main() {
    let o = Ext.Box[int32](33)
    System.Console.WriteLine(o)
    System.Console.WriteLine(Ext.Back[int32](o))
}`
        let output = CompileAndRun(source)
        Assert.Equal("33${Environment.NewLine}33${Environment.NewLine}", output)
    }

    @Fact
    func Control_ListTAdd_ErasedSlot_NoSpuriousBox() {
        // #1196 regression control: `T` fed into the erased `!0` element slot of
        // `List[T].Add(!0)` (compiled inside the generic method that declares
        // `T`) must remain a NO-OP identity conversion with NO `box T`. A
        // spurious box makes ilverify report `[found ref 'T'][expected value
        // 'T']` and the program throws InvalidProgramException. This coexists in
        // ONE compilation with a genuine `T -> object` boxing method to prove the
        // two paths stay independent after the #1540 change.
        const source = `package i1540listcontrol
import System
import System.Collections.Generic

class Ext {
    shared {
        func Box[T](val T) object { return val }
        func DoubleViaList[T](val T) []T {
            var list = List[T]()
            list.Add(val)
            list.Add(val)
            return list.ToArray()
        }
    }
}

func Main() {
    var arr = Ext.DoubleViaList[int32](5)
    System.Console.WriteLine(arr.Length)
    System.Console.WriteLine(arr[0])
    System.Console.WriteLine(Ext.Box[int32](5))
}`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}5${Environment.NewLine}5${Environment.NewLine}", output)
    }

    @Fact
    func Control_DictionaryAdd_ErasedSlots_NoSpuriousBox() {
        // #1196 regression control across TWO erased slots: both `K` and `V` are
        // fed into the erased `!0`/`!1` parameter slots of
        // `Dictionary[K,V].Add(!0, !1)`. Neither may emit a spurious box; the
        // count read-back proves the entry was stored.
        const source = `package i1540dictcontrol
import System
import System.Collections.Generic

class Ext {
    shared {
        func Store[K comparable, V any](k K, v V) int32 {
            var d = Dictionary[K, V]()
            d.Add(k, v)
            return d.Count
        }
    }
}

func Main() {
    System.Console.WriteLine(Ext.Store[int32, string](1, "a"))
    System.Console.WriteLine(Ext.Store[string, int32]("k", 7))
}`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}1${Environment.NewLine}", output)
    }

    @Fact
    func Control_StaticGenericMethodArg_ErasedMethodSlot_NoSpuriousBox() {
        // #1196 regression control for an erased METHOD-level type-parameter slot
        // (distinct from the receiver-slot controls above). `Enumerable.Repeat[T]`
        // has element parameter `TSource`, which closes over the enclosing open
        // `T`; at the raw CLR signature level that slot presents as `System.Object`.
        // The #1540 `T -> object` implicit rule must NOT box the `v T` argument
        // here — the classifier recovers the real `T` slot from the method's own
        // type arguments, keeping the argument `T -> T` identity. A spurious box
        // would produce `[found ref 'T'][expected value 'T']` invalid IL.
        const source = `package i1540staticgenmethod
import System
import System.Linq
import System.Collections.Generic

func RepeatVal[T](v T, n int32) IEnumerable[T] {
    return Enumerable.Repeat[T](v, n)
}

func Main() {
    for x in RepeatVal[int32](42, 3) {
        System.Console.WriteLine(x)
    }
    for s in RepeatVal[string]("a", 2) {
        System.Console.WriteLine(s)
    }
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "42${Environment.NewLine}42${Environment.NewLine}42${Environment.NewLine}a${Environment.NewLine}a${Environment.NewLine}",
            output
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1540_exe_").FullName
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
