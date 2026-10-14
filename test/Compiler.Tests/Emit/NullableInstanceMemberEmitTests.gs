// <copyright file="NullableInstanceMemberEmitTests.cs" company="GSharp">
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
import System.Reflection
import System.Reflection.Emit
import Xunit

/// Issue #517 — end-to-end emit + execute coverage for
/// `System.Nullable<T>`'s instance API surfaced through the binder
/// (`Value`, `HasValue`, `GetValueOrDefault()`,
/// `GetValueOrDefault(T)`). Each source compiles to a verifiable PE
/// (asserted via `ilverify`) and is then executed under
/// `dotnet exec`; the captured stdout is compared against the BCL's
/// semantics. The IL must take the receiver by managed pointer (the
/// instance methods on `Nullable<T>` require a `ref`
/// `this`), so this test also exercises the receiver-spill and
/// field-address paths the existing `!!` emitter relies on.
open class NullableInstanceMemberEmitTests {
    @Fact
    func Value_OnNullableInt32_Local_WithValue_ReturnsUnderlying() {
        let source = `package P

import System

var a Nullable[int32] = 42
Console.WriteLine(a.Value)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func Value_OnNullableInt32_Local_WithoutValue_ThrowsInvalidOperation() {
        // `a.Value` on a nil-valued nullable must throw
        // InvalidOperationException — the same observable failure mode
        // produced by `!!` (issue #504) and by `Nullable<T>.Value` in C#.
        let source = `package P

import System

var a Nullable[int32] = nil
var v = a.Value
Console.WriteLine(v)`
        let (exitCode, _, stderr) = CompileAndRunRaw(source, expectSuccess: false)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("InvalidOperationException", stderr)
    }

    @Fact
    func HasValue_OnNullableInt32_Local_BothBranches_RoundTrip() {
        let source = `package P

import System

var a Nullable[int32] = 7
Console.WriteLine(a.HasValue)

var b Nullable[int32] = nil
Console.WriteLine(b.HasValue)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func GetValueOrDefault_NoArg_OnNullableInt32_Local_BothBranches() {
        let source = `package P

import System

var a Nullable[int32] = 7
Console.WriteLine(a.GetValueOrDefault())

var b Nullable[int32] = nil
Console.WriteLine(b.GetValueOrDefault())`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func GetValueOrDefault_WithFallback_OnNullableInt32_Local_BothBranches() {
        let source = `package P

import System

var a Nullable[int32] = 7
Console.WriteLine(a.GetValueOrDefault(99))

var b Nullable[int32] = nil
Console.WriteLine(b.GetValueOrDefault(99))`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}99${Environment.NewLine}", output)
    }

    @Fact
    func Value_OnNullableBool_Local_BothLiterals() {
        let source = `package P

import System

var a Nullable[bool] = true
Console.WriteLine(a.Value)

var b Nullable[bool] = false
Console.WriteLine(b.Value)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func HasValue_AndValue_OnNullableDateTime_NonPrimitiveStruct() {
        // Covers a non-primitive (8-byte trivially-blittable) struct: the
        // `Nullable<DateTime>` slot is larger than a `Nullable<int32>` and
        // exercises the `ldloca` + `call` path on a struct with managed
        // ref semantics. The DateTime value is built inside ProbeLib's
        // `MakeDate` helper so the test never depends on the still-open
        // source-side `var x Nullable[DateTime] = DateTime(...)` lifting
        // limitation tracked separately. Comparing whole-DateTime values
        // is brittle across machines; checking only HasValue + the Year
        // accessor (which is chained off `.Value` — a property access on
        // the unwrapped DateTime — exercises receiver chaining too).
        let source = `package P

import System
import Probe

var a = Settings.MakeDate(2026, 6, 6)
Console.WriteLine(a.HasValue)
Console.WriteLine(a.Value.Year)

var b = Settings.NoDate()
Console.WriteLine(b.HasValue)`
        let output = CompileAndRunWithProbe(source)
        Assert.Equal("True${Environment.NewLine}2026${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func HasValue_OnParameter_DispatchesThroughLdarga() {
        // A `Nullable<T>` parameter is already in addressable storage
        // (`ldarga`). Verify the binder + emit produces a call against
        // the parameter's address rather than copying it to a fresh slot.
        let source = `package P

import System

func describe(x Nullable[int32]) {
    Console.WriteLine(x.HasValue)
    Console.WriteLine(x.GetValueOrDefault(-1))
}

var a Nullable[int32] = 5
describe(a)
var b Nullable[int32] = nil
describe(b)`
        let output = CompileAndRun(source)
        Assert.Equal(
            "True${Environment.NewLine}5${Environment.NewLine}False${Environment.NewLine}-1${Environment.NewLine}",
            output
        )
    }

    @Fact
    func HasValue_OnClassField_DispatchesThroughLdflda() {
        // A `Nullable<T>` field on a class receiver must take the field
        // address (`ldflda`) before the `call instance` so the struct
        // instance method's `this` is a managed pointer to the actual
        // field, not a copy on the eval stack.
        let source = `package P

import System

class Holder {
    var Flag bool?

    init() {
        Flag = nil
    }
}

var h = Holder()
Console.WriteLine(h.Flag.HasValue)
Console.WriteLine(h.Flag.GetValueOrDefault(false))

h.Flag = true
Console.WriteLine(h.Flag.HasValue)
Console.WriteLine(h.Flag.Value)`
        let output = CompileAndRun(source)
        Assert.Equal(
            "False${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            output
        )
    }

    @Fact
    func Value_OnClrPropertyReturning_NullableBool_FullPipeline() {
        // Reproduces the exact `Assert.Equal(true, prop.Value)` shape from
        // the upstream Oahu workaround for #504. The receiver is a CLR
        // property's return value (an rvalue) — the emit pipeline must
        // spill it to a `Nullable<bool>`-typed scratch slot before taking
        // the address for the `Nullable<bool>::get_Value` call.
        let source = `package P

import System
import Probe

var s = Settings()
s.Flag = true
Console.WriteLine(s.Flag.Value)
Console.WriteLine(s.Flag.HasValue)
Console.WriteLine(s.Flag.GetValueOrDefault(false))

s.Flag = nil
Console.WriteLine(s.Flag.HasValue)
Console.WriteLine(s.Flag.GetValueOrDefault(false))`
        let output = CompileAndRunWithProbe(source)
        Assert.Equal(
            "True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}",
            output
        )
    }

    @Fact
    func Value_OnClrPropertyReturning_NullableInt32_Nil_ThrowsInvalidOperation() {
        // Same property-as-receiver pipeline, but the underlying value is
        // `nil` — the unwrap call into `Nullable<T>::get_Value` must throw
        // InvalidOperationException end-to-end, not InvalidProgramException
        // or NullReferenceException.
        let source = `package P

import System
import Probe

var s = Settings()
s.Count = nil
var v = s.Count.Value
Console.WriteLine(v)`
        let (exitCode, _, stderr) = CompileAndRunRaw(source, expectSuccess: false, withProbe: true)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("InvalidOperationException", stderr)
    }

    @Fact
    func GetValueOrDefault_OnClrProperty_PropagatesFallback() {
        // CLR-property receiver + `GetValueOrDefault(fallback)`. Exercises
        // the spill-to-Nullable<T>-slot + ldloca + call sequence with a
        // non-zero argument flowing through to the BCL implementation.
        let source = `package P

import System
import Probe

var s = Settings()
s.Count = nil
Console.WriteLine(s.Count.GetValueOrDefault(-1))

s.Count = 7
Console.WriteLine(s.Count.GetValueOrDefault(-1))`
        let output = CompileAndRunWithProbe(source)
        Assert.Equal("-1${Environment.NewLine}7${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: true)
            Assert.True(exitCode == 0, (`exited ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunWithProbe(source string) string {
            let (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: true, withProbe: true)
            Assert.True(exitCode == 0, (`exited ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileAndRunRaw(source string, expectSuccess bool, withProbe bool = false)(
            ExitCode int32,
            Stdout string,
            Stderr string
        ) {
            let tempDir = Directory.CreateTempSubdirectory("gs_nullable_instance_").FullName
            try {
                var probeDllPath string? = nil
                if withProbe {
                    probeDllPath = Path.Combine(tempDir, "ProbeLib.dll")
                    BuildProbeLibrary(probeDllPath)
                }
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                if probeDllPath != nil {
                    args.Add("/r:" + probeDllPath)
                }
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
                let verifyRefs[]?string = if probeDllPath != nil {
                    []string{probeDllPath}
                } else {
                    default([]?string)
                }
                IlVerifier.Verify(outPath, additionalReferences: verifyRefs)
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

        private func BuildProbeLibrary(dllPath string?) {
            let coreAssembly = typeof(object).Assembly
            let asmName = AssemblyName("ProbeLib"){Version = Version(1, 0, 0, 0)}
            let asmBuilder = PersistedAssemblyBuilder(asmName, coreAssembly)
            let moduleBuilder = asmBuilder.DefineDynamicModule("ProbeLib")
            let typeBuilder = moduleBuilder.DefineType(
                "Probe.Settings",
                TypeAttributes.Public | TypeAttributes.Class | TypeAttributes.AutoLayout | TypeAttributes.BeforeFieldInit,
                parent: typeof(object)
            )
            EmitAutoProperty(typeBuilder, "Flag", typeof(bool?))
            EmitAutoProperty(typeBuilder, "Count", typeof(int32?))
            EmitMakeDate(typeBuilder)
            EmitNoDate(typeBuilder)
            let ctor = typeBuilder.DefineConstructor(
                MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.RTSpecialName | MethodAttributes.HideBySig,
                CallingConventions.Standard,
                Type.EmptyTypes
            )
            let ctorIl = ctor.GetILGenerator()
            ctorIl.Emit(OpCodes.Ldarg_0)
            ctorIl.Emit(OpCodes.Call, typeof(object).GetConstructor(Type.EmptyTypes)!!)
            ctorIl.Emit(OpCodes.Ret)
            typeBuilder.CreateType()
            asmBuilder.Save(dllPath!!)
        }

        private func EmitAutoProperty(typeBuilder TypeBuilder, name string, clrType Type) {
            let field = typeBuilder.DefineField("<" + name + ">k__BackingField", clrType, FieldAttributes.Private)
            let property = typeBuilder.DefineProperty(name, PropertyAttributes.HasDefault, clrType, parameterTypes: nil)
            const accessorAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig
            let getter = typeBuilder.DefineMethod("get_" + name, accessorAttrs, clrType, Type.EmptyTypes)
            let getterIl = getter.GetILGenerator()
            getterIl.Emit(OpCodes.Ldarg_0)
            getterIl.Emit(OpCodes.Ldfld, field)
            getterIl.Emit(OpCodes.Ret)
            let setter = typeBuilder.DefineMethod(
                "set_" + name,
                accessorAttrs,
                returnType: nil,
                parameterTypes: []Type{clrType}
            )
            let setterIl = setter.GetILGenerator()
            setterIl.Emit(OpCodes.Ldarg_0)
            setterIl.Emit(OpCodes.Ldarg_1)
            setterIl.Emit(OpCodes.Stfld, field)
            setterIl.Emit(OpCodes.Ret)
            property.SetGetMethod(getter)
            property.SetSetMethod(setter)
        }

        private func EmitMakeDate(typeBuilder TypeBuilder) {
            // Static method `MakeDate(year, month, day) -> Nullable<DateTime>`.
            // Sidesteps the pre-existing source-side `var x Nullable[DateTime] =
            // DateTime(...)` lifting limitation by handing the binder a value
            // that is already typed as `Nullable<DateTime>` at the call site.
            let method = typeBuilder.DefineMethod(
                "MakeDate",
                MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.HideBySig,
                typeof(DateTime?),
                []Type{typeof(int32), typeof(int32), typeof(int32)}
            )
            let il = method.GetILGenerator()
            let dtCtor ConstructorInfo? = typeof(DateTime).GetConstructor(
                []Type{typeof(int32), typeof(int32), typeof(int32)}
            )
            let nullableCtor ConstructorInfo? = typeof(DateTime?).GetConstructor([]Type{typeof(DateTime)})
            il.Emit(OpCodes.Ldarg_0)
            il.Emit(OpCodes.Ldarg_1)
            il.Emit(OpCodes.Ldarg_2)
            il.Emit(OpCodes.Newobj, dtCtor!!)
            il.Emit(OpCodes.Newobj, nullableCtor!!)
            il.Emit(OpCodes.Ret)
        }

        private func EmitNoDate(typeBuilder TypeBuilder) {
            // Static method `NoDate() -> Nullable<DateTime>` returning the
            // default (HasValue == false) value.
            let method = typeBuilder.DefineMethod(
                "NoDate",
                MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.HideBySig,
                typeof(DateTime?),
                Type.EmptyTypes
            )
            let il = method.GetILGenerator()
            let local = il.DeclareLocal(typeof(DateTime?))
            il.Emit(OpCodes.Ldloca_S, uint8(local.LocalIndex))
            il.Emit(OpCodes.Initobj, typeof(DateTime?))
            il.Emit(OpCodes.Ldloc, local)
            il.Emit(OpCodes.Ret)
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
