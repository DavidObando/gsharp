// <copyright file="NullableValueEmitTests.cs" company="GSharp">
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

/// Issue #504 (remaining emit-side gaps after PR #513): exercises code paths
/// that move `Nullable<T>` values through the emitter — `!!`
/// unwrap, generic call boundaries (type-erased boxing), and the full
/// CLR-property write/read/unwrap pipeline used by the original reproducer.
///
/// Each test compiles the GSharp source with gsc, runs `ilverify` against
/// the produced PE to confirm the IL is verifiable (the original bugs all
/// emitted invalid IL that the JIT caught at runtime as
/// `InvalidProgramException`), then executes the assembly under
/// `dotnet exec` and asserts on the captured stdout.
open class NullableValueEmitTests {
    @Fact
    func UnwrapBangBang_OnNullableBool_HasValue_ReturnsUnderlying() {
        // Original reproducer from #504 follow-up: `s.ExportToAax!!` (where
        // the property is `bool?`) compiled successfully but threw
        // InvalidProgramException at runtime because the emitter used the
        // reference-type `dup; brtrue` pattern on a struct stack value.
        // Modelled here without the CLR property dependency — see
        // RoundTripWriteReadUnwrap_OnClrNullableBoolProperty for the
        // end-to-end shape.
        let source = `package P

import System

var a Nullable[bool] = true
var v = a!!
Console.WriteLine(v)

var b Nullable[bool] = false
var w = b!!
Console.WriteLine(w)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func UnwrapBangBang_OnNullableInt_HasValue_ReturnsUnderlying() {
        // Verifies the same path for a value type with a non-trivial size
        // (Nullable<int32> is 8 bytes — the `Nullable<T>::get_Value` call
        // must take the slot's address, not its value).
        let source = `package P

import System

var a Nullable[int32] = 42
var v = a!!
Console.WriteLine(v)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func UnwrapBangBang_OnNullableBool_NoValue_ThrowsInvalidOperation() {
        // The emitted IL routes the unwrap through
        // `Nullable<T>::get_Value()`, which the BCL implements as
        // `if (!HasValue) throw new InvalidOperationException(...);` — match
        // that exact behaviour so `!!` on a value-type Nullable mirrors the
        // C# `nullable.Value` property surface, and so the failure mode is
        // surfaced to the user (not silently zeroed).
        let source = `package P

import System

var a Nullable[bool] = nil
var v = a!!
Console.WriteLine(v)`
        let (exitCode, _, stderr) = CompileAndRunRaw(source, expectSuccess: false)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("InvalidOperationException", stderr)
    }

    @Fact
    func GenericMethod_PassNullableArg_RoundTripsThroughObjectBoundary() {
        // Phase 4 emit treats generic functions as type-erased — every `T`
        // parameter is encoded as `System.Object`, so value-type arguments
        // are boxed at the call boundary and unboxed at the return. Issue
        // #504 originally claimed `Assert.Equal[bool?](a, b)` (both bool?)
        // hit InvalidProgramException through this same code path. Confirm
        // the boundary handles a `Nullable<T>` argument correctly: the CLR
        // boxes a `Nullable<T>` as either a boxed T or a null reference.
        // Route everything through an `object` slot before printing so the
        // test asserts only on the box/unbox round-trip, not on
        // overload-resolution for Console.WriteLine(Nullable<bool>).
        let source = `package P

import System

func Id[T](a T) T {
    return a
}

var a Nullable[bool] = false
var r1 Nullable[bool] = Id[Nullable[bool]](a)
var o1 object = r1
Console.WriteLine(o1)

var b Nullable[bool] = nil
var r2 Nullable[bool] = Id[Nullable[bool]](b)
var o2 object = r2
Console.Write("[")
Console.Write(o2)
Console.WriteLine("]")`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}[]${Environment.NewLine}", output)
    }

    @Fact
    func GenericMethod_TwoNullableArgs_PassedAsObjectsRoundTrip() {
        // Mirrors the reported `Assert.Equal[bool?](a, b)` shape: two
        // distinct `Nullable<bool>` locals threaded through a generic
        // method whose body re-emits `box Nullable<bool>` on each arg.
        // Each call boundary must box `Nullable<T>` correctly so the call
        // site's stack shape matches the type-erased `(object, object)`
        // signature, and the return must `unbox.any` back to `Nullable<T>`.
        let source = `package P

import System

func TwoArgs[T](a T, b T) T {
    return a
}

var x Nullable[bool] = true
var y Nullable[bool] = false
var first Nullable[bool] = TwoArgs[Nullable[bool]](x, y)
var o1 object = first
Console.WriteLine(o1)

var second Nullable[bool] = TwoArgs[Nullable[bool]](y, x)
var o2 object = second
Console.WriteLine(o2)

var nilHs Nullable[bool] = nil
var third Nullable[bool] = TwoArgs[Nullable[bool]](nilHs, x)
var o3 object = third
Console.Write("[")
Console.Write(o3)
Console.WriteLine("]")`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}[]${Environment.NewLine}", output)
    }

    @Fact
    func BoxNullable_ToObject_PreservesPresenceAndUnderlyingValue() {
        // `box Nullable<T>` is CLR-special-cased: the result is either a
        // boxed T (when HasValue) or a null reference (when !HasValue). The
        // emitter must therefore emit `box Nullable<T>` (not `box T`) on a
        // `Nullable<T>` stack value crossing into an `object` slot.
        let source = `package P

import System

var a Nullable[bool] = true
var o1 object = a
Console.WriteLine(o1)

var b Nullable[bool] = false
var o2 object = b
Console.WriteLine(o2)

var c Nullable[bool] = nil
var o3 object = c
Console.Write("[")
Console.Write(o3)
Console.WriteLine("]")`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}[]${Environment.NewLine}", output)
    }

    @Fact
    func UnboxNullable_FromObject_ThroughGenericIdentity() {
        // The "unbox.any Nullable<T>" path is hit on the return value of a
        // generic method whose return is `T`. The emitter's
        // EmitErasedObjectReturnWidening must select the right closed
        // `Nullable<T>` token when widening the `object` placeholder back
        // to the caller's expected slot type.
        let source = `package P

import System

func Echo[T](a T) T {
    return a
}

var src Nullable[int32] = 7
var dst Nullable[int32] = Echo[Nullable[int32]](src)
Console.WriteLine(dst!!)

var srcNil Nullable[int32] = nil
var dstNil Nullable[int32] = Echo[Nullable[int32]](srcNil)
var o object = dstNil
Console.Write("[")
Console.Write(o)
Console.WriteLine("]")`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}[]${Environment.NewLine}", output)
    }

    @Fact
    func RoundTripWriteReadUnwrap_OnClrNullableBoolProperty() {
        // End-to-end reproducer mirroring the original issue: a sibling CLR
        // type exposes `bool? Flag`. GSharp writes through the setter,
        // reads back through the getter, and unwraps with `!!`. Each step
        // must produce verifiable IL.
        let source = `package P

import System
import Probe

var s = Settings()
s.Flag = true
var v = s.Flag!!
Console.WriteLine(v)

s.Flag = false
var v2 = s.Flag!!
Console.WriteLine(v2)`
        let output = CompileAndRunWithProbe(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func UnwrapClrNullableProperty_NoValue_ThrowsInvalidOperation() {
        // `s.Flag!!` when the underlying value is `nil` must throw
        // InvalidOperationException (not InvalidProgramException, not
        // NullReferenceException) so the call surface matches
        // `Nullable<T>.Value`.
        let source = `package P

import System
import Probe

var s = Settings()
s.Flag = nil
var v = s.Flag!!
Console.WriteLine(v)`
        let (exitCode, _, stderr) = CompileAndRunRaw(source, expectSuccess: false, withProbe: true)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("InvalidOperationException", stderr)
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
            let tempDir = Directory.CreateTempSubdirectory("gs_nullable_value_").FullName
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
