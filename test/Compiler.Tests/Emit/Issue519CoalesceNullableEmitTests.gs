// <copyright file="Issue519CoalesceNullableEmitTests.cs" company="GSharp">
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

/// Issue #519: applying the null-coalescing operator `??` to a CLR
/// `Nullable<T>` value previously crashed the emit phase silently
/// (`MSB4181` with no `GS####` diagnostic). The cause was the value-
/// type guard at the binary emit site rejecting any nullable value-type LHS
/// because `dup; brtrue` is invalid IL for a struct stack value, plus a
/// missing `HasValue`/`get_Value` lowering path.
///
/// These tests pin down the new behaviour:
/// - `Nullable<T> ?? T` for `bool?` and `int32?`, both the present and absent branches, against locals
/// and CLR properties.
/// - `Nullable<T> ?? Nullable<T>` preserves the wrapper shape and threads `nil` through both sides.
/// - Chained `a ?? b ?? c` over nullable operands routes through the right operand correctly when the
/// LHSs are `nil`.
/// - Reference-typed nullables (`string?`) continue to use the existing `dup; brtrue` path and are not
/// regressed.
/// Each test compiles via `gsc`, runs `ilverify` against the produced
/// PE, then executes the assembly under `dotnet exec` and asserts on the
/// captured stdout (so any invalid IL surfaces as a verification failure
/// rather than silently passing).
open class Issue519CoalesceNullableEmitTests {
    @Fact
    func CoalesceNullableBool_HasValue_Local_ReturnsLeftUnderlying() {
        let source = `package P

import System

var a bool? = true
var v bool = a ?? false
Console.WriteLine(v)

var b bool? = false
var w bool = b ?? true
Console.WriteLine(w)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func CoalesceNullableBool_NoValue_Local_ReturnsRightLiteral() {
        let source = `package P

import System

var a bool? = nil
var v bool = a ?? true
Console.WriteLine(v)

var b bool? = nil
var w bool = b ?? false
Console.WriteLine(w)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func CoalesceNullableInt_HasValue_Local_ReturnsLeftUnderlying() {
        let source = `package P

import System

var a int32? = 7
var v int32 = a ?? 99
Console.WriteLine(v)`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func CoalesceNullableInt_NoValue_Local_ReturnsRightLiteral() {
        let source = `package P

import System

var a int32? = nil
var v int32 = a ?? 99
Console.WriteLine(v)`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    @Fact
    func CoalesceNullableInt_BothNullable_HasValue_PreservesLeftWrapper() {
        // RHS is also `int32?`, so the operator's result type is the wrapper
        // `Nullable<int32>` rather than `int32`. The non-null branch must
        // reload the spilled `Nullable<T>` value (not unwrap and re-wrap),
        // so that `r` observes the original wrapper's identity.
        let source = `package P

import System

var a int32? = 7
var b int32? = 99
var r int32? = a ?? b
Console.WriteLine(r!!)`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func CoalesceNullableInt_BothNullable_LeftNil_UsesRightWrapper() {
        let source = `package P

import System

var a int32? = nil
var b int32? = 42
var r int32? = a ?? b
Console.WriteLine(r!!)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func CoalesceNullableInt_BothNullable_BothNil_PropagatesAbsence() {
        // When both sides carry no value, the result must remain absent —
        // a literal `nil` wrapper must reach the consumer (here observed
        // through `object` widening so `Console.Write` prints empty).
        let source = `package P

import System

var a int32? = nil
var b int32? = nil
var r int32? = a ?? b
var o object = r
Console.Write("[")
Console.Write(o)
Console.WriteLine("]")`
        let output = CompileAndRun(source)
        Assert.Equal("[]${Environment.NewLine}", output)
    }

    @Fact
    func CoalesceNullableInt_Chained_AllNil_ReturnsLastLiteral() {
        // `a ?? b ?? c` parses right-associatively as `a ?? (b ?? c)`.
        // Both `a` and `b` are value-type Nullable<int>, so the emitter
        // pre-allocates two separate scratch slots (one per BoundBinary
        // expression). When all left operands are nil the final literal
        // wins.
        let source = `package P

import System

var a int32? = nil
var b int32? = nil
var c int32 = 99
var r int32 = a ?? b ?? c
Console.WriteLine(r)`
        let output = CompileAndRun(source)
        Assert.Equal("99${Environment.NewLine}", output)
    }

    @Fact
    func CoalesceNullableInt_Chained_MiddleHasValue_ReturnsMiddle() {
        let source = `package P

import System

var a int32? = nil
var b int32? = 7
var c int32 = 99
var r int32 = a ?? b ?? c
Console.WriteLine(r)`
        let output = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", output)
    }

    @Fact
    func CoalesceNullableInt_Chained_FirstHasValue_ReturnsFirst() {
        let source = `package P

import System

var a int32? = 1
var b int32? = 7
var c int32 = 99
var r int32 = a ?? b ?? c
Console.WriteLine(r)`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func CoalesceClrNullableBoolProperty_HasValue_ReturnsUnderlying() {
        // End-to-end reproducer mirroring the issue: a sibling CLR type
        // exposes `bool? Flag`. GSharp reads through the getter and
        // coalesces with a literal. Each step must produce verifiable IL —
        // before #519 the compile crashed silently as MSB4181.
        let source = `package P

import System
import Probe

var s = Settings()
s.Flag = true
var v bool = s.Flag ?? false
Console.WriteLine(v)

s.Flag = false
var w bool = s.Flag ?? true
Console.WriteLine(w)`
        let output = CompileAndRunWithProbe(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func CoalesceClrNullableBoolProperty_NoValue_ReturnsFallback() {
        let source = `package P

import System
import Probe

var s = Settings()
s.Flag = nil
var v bool = s.Flag ?? true
Console.WriteLine(v)

s.Flag = nil
var w bool = s.Flag ?? false
Console.WriteLine(w)`
        let output = CompileAndRunWithProbe(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func CoalesceClrNullableIntProperty_RoundTripsThroughCoalesce() {
        let source = `package P

import System
import Probe

var s = Settings()
s.Count = 7
var v int32 = s.Count ?? 99
Console.WriteLine(v)

s.Count = nil
var w int32 = s.Count ?? 99
Console.WriteLine(w)`
        let output = CompileAndRunWithProbe(source)
        Assert.Equal("7${Environment.NewLine}99${Environment.NewLine}", output)
    }

    @Fact
    func CoalesceNullConditionalBoolResult_UsesFallbackWhenReceiverIsNil() {
        let source = `package P

import System

class Items {
    public func HasItems() bool {
        return true
    }
}

class Probe {
    public prop Items Items { get; set; }
}

var missing Probe? = nil
var absent bool = missing?.Items!!.HasItems() ?? false
Console.WriteLine(absent)

var present Probe? = Probe() { Items = Items() }
var found bool = present?.Items!!.HasItems() ?? false
Console.WriteLine(found)`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func CoalesceReferenceNullableString_StillUsesShortCircuitPath() {
        // Regression guard: a reference-typed nullable continues to use the
        // existing `dup; brtrue; pop; rhs` short-circuit, which is legal IL
        // for object references. The value-type emit branch added for #519
        // must not capture this case.
        let source = `package P

import System

var s string? = "hello"
var r string = s ?? "fallback"
Console.WriteLine(r)

var t string? = nil
var u string = t ?? "fallback"
Console.WriteLine(u)`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}fallback${Environment.NewLine}", output)
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
            let tempDir = Directory.CreateTempSubdirectory("gs_issue519_").FullName
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
