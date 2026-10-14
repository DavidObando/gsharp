// <copyright file="Issue2799NullConditionalStructuralDelegateReceiverEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Diagnostics

/// PR #2799 follow-up: the null-conditional invocation form `f?(args)` of a
/// non-nullable <b>structural function</b>-typed receiver
/// (`(int32) -> int32`) was only guarded in
/// `OverloadResolver.Invocations.BuildIndirectDelegateCall` when the
/// receiver was the implicit backing field of a field-like event (an
/// `ImplicitFieldVariableSymbol`). Every other receiver kind reaching that
/// path — a bare static field (`ImplicitStaticFieldVariableSymbol`), a bare
/// instance/static property (`ImplicitPropertyVariableSymbol` /
/// `ImplicitStaticPropertyVariableSymbol`), and a plain local, parameter,
/// or top-level global (`LocalVariableSymbol` / `ParameterSymbol` /
/// `GlobalVariableSymbol`) — fell through to an <b>unguarded</b>
/// `BoundIndirectCallExpression`, silently dropping the `?`: the result
/// was bound as the non-optional return type (so `r == nil` and value-type
/// `??` misbehaved) and a null receiver NRE-d instead of short-circuiting.
///
/// The fix generalizes the null-conditional guard across all receiver kinds,
/// evaluating the receiver exactly once and applying the established result-slot
/// lowering (nullable result type, `$nres_` slot for value-type returns).
/// These tests prove — for a receiver kind whose runtime value can legally be
/// null (an uninitialized function-typed field's CLR default, read through a
/// local copy / property / static member) — that a null receiver short-circuits
/// to the null/optional result and a non-null receiver invokes once, with clean
/// ILVerify, for both value- and void-returning shapes.
///
/// This branch additionally fixes a distinct, tightly-related pre-existing
/// defect in the <b>nominal</b> CLR-delegate call path
/// (`OverloadResolver.CallBinding`): it computed its receiver as a bare
/// `BoundVariableExpression` and never used `TryBuildImplicitMemberLoad`,
/// so a nominal `Func<...>` value exposed as a bare static field or
/// instance/static property ICE-d with GS9998 ("no local slot") on <b>any</b>
/// invocation (conditional or not). The receiver-load fix mirrors the structural
/// path, so those nominal member receivers now invoke — and short-circuit under
/// `?` — correctly.
open class Issue2799NullConditionalStructuralDelegateReceiverEmitTests {
    @Fact
    func LocalReceiver_NullShortCircuits_NonNullInvokes() {
        // Fallthrough (LocalVariableSymbol) path. The local copies an
        // uninitialized function-typed field whose CLR default is null, so the
        // null branch is genuinely runtime-reachable.
        let source = `package MyLib
class C {
    var backing (int32) -> int32
    func SetBacking(fn (int32) -> int32) { backing = fn }
    func Run() int32 {
        var f (int32) -> int32 = backing
        var r = f?(5)
        return r ?? -1
    }
}`
        let c = CompileType(source, "C")
        let instance = Activator.CreateInstance(c)!!
        let run = c.GetMethod("Run")!!
        Assert.Equal(-1, run.Invoke(instance, nil))
        SetDelegate(c, instance, "SetBacking", "IntDoubler")
        Assert.Equal(10, run.Invoke(instance, nil))
    }

    @Fact
    func ParameterReceiver_HonorsQuestion_AndInvokesNonNull() {
        // Fallthrough (ParameterSymbol) path. A non-nullable function parameter
        // cannot be assigned `nil` by language rules (GS0155/GS0129), so its
        // null branch is not reachable via a literal; the `?` is still honored
        // (the result is optional) and a non-null argument invokes once.
        let source = `package MyLib
class C {
    func Run(f (int32) -> int32) int32 {
        var r = f?(5)
        return r ?? -1
    }
}`
        let c = CompileType(source, "C")
        let instance = Activator.CreateInstance(c)!!
        let run = c.GetMethod("Run")!!
        let del = MakeDelegate(run.GetParameters()[0].ParameterType, "IntDoubler")
        Assert.Equal(10, run.Invoke(instance, []object{del}))
    }

    @Fact
    func InstancePropertyReceiver_NullShortCircuits_NonNullInvokes() {
        // Implicit-member (ImplicitPropertyVariableSymbol) path via
        // TryBuildImplicitMemberLoad.
        let source = `package MyLib
class C {
    var backing (int32) -> int32
    prop P (int32) -> int32 {
        get -> this.backing
    }
    func SetBacking(fn (int32) -> int32) { backing = fn }
    func Run() int32 {
        var r = P?(5)
        return r ?? -1
    }
}`
        let c = CompileType(source, "C")
        let instance = Activator.CreateInstance(c)!!
        let run = c.GetMethod("Run")!!
        Assert.Equal(-1, run.Invoke(instance, nil))
        SetDelegate(c, instance, "SetBacking", "IntDoubler")
        Assert.Equal(10, run.Invoke(instance, nil))
    }

    @Fact
    func StaticFieldAndStaticPropertyReceivers_NullShortCircuit_NonNullInvoke() {
        // Implicit-member (ImplicitStaticFieldVariableSymbol /
        // ImplicitStaticPropertyVariableSymbol) paths via
        // TryBuildImplicitMemberLoad.
        let source = `package MyLib
class C {
    shared {
        var sf (int32) -> int32
        prop SP (int32) -> int32 {
            get -> C.sf
        }
        func SetSf(fn (int32) -> int32) { sf = fn }
        func RunField() int32 {
            var r = sf?(5)
            return r ?? -1
        }
        func RunProp() int32 {
            var r = SP?(5)
            return r ?? -1
        }
    }
}`
        let c = CompileType(source, "C")
        let runField = c.GetMethod("RunField")!!
        let runProp = c.GetMethod("RunProp")!!
        Assert.Equal(-1, runField.Invoke(nil, nil))
        Assert.Equal(-1, runProp.Invoke(nil, nil))
        let setSf = c.GetMethod("SetSf")!!
        setSf.Invoke(nil, []object{MakeDelegate(setSf.GetParameters()[0].ParameterType, "IntDoubler")})
        Assert.Equal(10, runField.Invoke(nil, nil))
        Assert.Equal(10, runProp.Invoke(nil, nil))
    }

    @Fact
    func GlobalReceiver_HonorsQuestion_AndInvokesNonNull() {
        // Fallthrough (GlobalVariableSymbol) path: a top-level script variable.
        let source = `package MyLib
import System

func Ident(x int32) int32 { return x }

var f (int32) -> int32 = Ident
var r = f?(5)
Console.WriteLine((r ?? -1).ToString())`
        let output = CompileAndRunExe(source)
        Assert.Equal("5", output.Trim())
    }

    @Fact
    func VoidReturn_LocalReceiver_NullNoOps_NonNullInvokes() {
        // Void-returning structural delegate through a local whose value is a
        // genuinely-null uninitialized field default: the null branch is a safe
        // no-op (no NRE), the non-null branch invokes exactly once.
        let source = `package MyLib
class C {
    var sink (int32) -> void
    func SetSink(fn (int32) -> void) { sink = fn }
    func Run() {
        var s (int32) -> void = sink
        s?(5)
    }
}`
        let c = CompileType(source, "C")
        let instance = Activator.CreateInstance(c)!!
        let run = c.GetMethod("Run")!!
        // Null sink: raising must be a safe no-op.
        Assert.Null(Record.Exception(() -> run.Invoke(instance, nil)))
        let counter = SinkCounter()
        let setSink = c.GetMethod("SetSink")!!
        let del = Delegate.CreateDelegate(
            setSink.GetParameters()[0].ParameterType,
            counter,
            typeof(SinkCounter).GetMethod("Sink")!!
        )
        setSink.Invoke(instance, []object{del})
        run.Invoke(instance, nil)
        Assert.Equal(1, counter.Hits)
    }

    @Fact
    func SideEffectfulPropertyReceiver_EvaluatedExactlyOnce() {
        // The receiver (property getter) must be evaluated exactly once on both
        // the null (short-circuit) and non-null (invoke) paths — single
        // evaluation preserved across the generalized guard.
        let source = `package MyLib
class C {
    var backing (int32) -> int32
    var getCount int32
    prop P (int32) -> int32 {
        get {
            getCount = getCount + 1
            return backing
        }
    }
    func SetBacking(fn (int32) -> int32) { backing = fn }
    func GetCount() int32 { return getCount }
    func Run() int32 {
        var r = P?(5)
        return r ?? -1
    }
}`
        let c = CompileType(source, "C")
        let instance = Activator.CreateInstance(c)!!
        let run = c.GetMethod("Run")!!
        let getCount = c.GetMethod("GetCount")!!
        // Null backing: getter runs once, then short-circuits.
        Assert.Equal(-1, run.Invoke(instance, nil))
        Assert.Equal(1, getCount.Invoke(instance, nil))
        // Non-null: getter runs once more, then invokes.
        SetDelegate(c, instance, "SetBacking", "IntDoubler")
        Assert.Equal(10, run.Invoke(instance, nil))
        Assert.Equal(2, getCount.Invoke(instance, nil))
    }

    @Fact
    func BareResult_IsOptional_NullYieldsNil_NonNullYieldsValue() {
        // Proves the `?` is honored semantically: without a `??` fallback the
        // result of `f?(5)` is a genuine optional (`int32?`), so `r == nil` is
        // legal and true with a null receiver, false once assigned. Before the
        // fix `r` was bound as non-optional `int32`, and `r == nil` failed to
        // bind (GS0129).
        let source = `package MyLib
class C {
    var backing (int32) -> int32
    func SetBacking(fn (int32) -> int32) { backing = fn }
    func IsNil() bool {
        var f (int32) -> int32 = backing
        var r = f?(5)
        return r == nil
    }
}`
        let c = CompileType(source, "C")
        let instance = Activator.CreateInstance(c)!!
        let isNil = c.GetMethod("IsNil")!!
        Assert.Equal(true, isNil.Invoke(instance, nil))
        SetDelegate(c, instance, "SetBacking", "IntDoubler")
        Assert.Equal(false, isNil.Invoke(instance, nil))
    }

    @Fact
    func NominalFuncInstancePropertyReceiver_NullShortCircuits_NonNullInvokes() {
        // Distinct pre-existing defect also fixed on this branch: the nominal
        // CLR-delegate call path (OverloadResolver.CallBinding) computed its
        // receiver as a bare BoundVariableExpression and never used
        // TryBuildImplicitMemberLoad, so a nominal `Func<int, int>` value
        // exposed as a bare instance property ICE-d with GS9998 ("no local
        // slot") on ANY invocation. It now short-circuits on null and invokes
        // when non-null.
        let source = `package MyLib
import System
class C {
    var backing Func[int32,int32]
    prop P Func[int32,int32] {
        get -> this.backing
    }
    func SetBacking(fn Func[int32,int32]) { backing = fn }
    func Run() int32 {
        var r = P?(5)
        return r ?? -1
    }
}`
        let c = CompileType(source, "C")
        let instance = Activator.CreateInstance(c)!!
        let run = c.GetMethod("Run")!!
        Assert.Equal(-1, run.Invoke(instance, nil))
        SetDelegate(c, instance, "SetBacking", "IntDoubler")
        Assert.Equal(10, run.Invoke(instance, nil))
    }

    @Fact
    func NominalFuncInstancePropertyReceiver_NonConditional_Invokes() {
        // Non-null-conditional invocation `P(5)` of a nominal CLR-delegate
        // instance property previously ICE-d (GS9998); the receiver-load fix
        // makes it a normal invoke.
        let source = `package MyLib
import System
class C {
    var backing Func[int32,int32]
    prop P Func[int32,int32] {
        get -> this.backing
    }
    func SetBacking(fn Func[int32,int32]) { backing = fn }
    func Run() int32 {
        return P(5)
    }
}`
        let c = CompileType(source, "C")
        let instance = Activator.CreateInstance(c)!!
        SetDelegate(c, instance, "SetBacking", "IntDoubler")
        Assert.Equal(10, c.GetMethod("Run")!!.Invoke(instance, nil))
    }

    @Fact
    func NominalFuncStaticFieldAndPropertyReceivers_NullShortCircuit_NonNullInvoke() {
        let source = `package MyLib
import System
class C {
    shared {
        var sf Func[int32,int32]
        prop SP Func[int32,int32] {
            get -> C.sf
        }
        func SetSf(fn Func[int32,int32]) { sf = fn }
        func RunField() int32 {
            var r = sf?(5)
            return r ?? -1
        }
        func RunProp() int32 {
            var r = SP?(5)
            return r ?? -1
        }
    }
}`
        let c = CompileType(source, "C")
        let runField = c.GetMethod("RunField")!!
        let runProp = c.GetMethod("RunProp")!!
        Assert.Equal(-1, runField.Invoke(nil, nil))
        Assert.Equal(-1, runProp.Invoke(nil, nil))
        let setSf = c.GetMethod("SetSf")!!
        setSf.Invoke(nil, []object{MakeDelegate(setSf.GetParameters()[0].ParameterType, "IntDoubler")})
        Assert.Equal(10, runField.Invoke(nil, nil))
        Assert.Equal(10, runProp.Invoke(nil, nil))
    }

    private class SinkCounter {
        prop Hits int32 {
            get;
            private set;
        }

        func Sink(x int32) {
            this.Hits++
        }
    }

    shared {
        /// Doubles its argument; bound to `(int32) -> int32` receivers.
        func IntDoubler(x int32) int32 -> x * 2

        private func SetDelegate(owner Type, instance object, setterName string, handlerName string) {
            let setter = owner.GetMethod(setterName)!!
            let del = MakeDelegate(setter.GetParameters()[0].ParameterType, handlerName)
            setter.Invoke(instance, []object{del})
        }

        private func MakeDelegate(delegateType Type, handlerName string) Delegate -> Delegate.CreateDelegate(
            delegateType,
            typeof(Issue2799NullConditionalStructuralDelegateReceiverEmitTests).GetMethod(handlerName)!!
        )

        private func CompileType(source string, typeName string) Type -> CompileToAssembly(source, "library").GetTypes()
            .Single((t Type) -> t.Name == typeName)

        private func CompileAndRunExe(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2799_exe_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            CompileFile(srcPath, outPath, "exe")
            IlVerifier.Verify(outPath)
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir
            }
            psi.ArgumentList.Add(outPath)
            using let proc = Process.Start(psi)!!
            let stdout = proc.StandardOutput.ReadToEnd()
            let stderr = proc.StandardError.ReadToEnd()
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(proc.ExitCode == 0, (`sample exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        private func CompileToAssembly(source string, target string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2799_emit_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            CompileFile(srcPath, outPath, target)
            IlVerifier.Verify(outPath)
            return EmittedFixture.Load(outPath)
        }

        private func CompileFile(srcPath string, outPath string, target string) {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:" + target, "/targetframework:net10.0", srcPath}
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
        }
    }
}
