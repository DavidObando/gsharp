// <copyright file="NullablePropertyEmitTests.cs" company="GSharp">
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

/// Issue #504 regression tests: reading/writing a CLR property whose declared
/// type is `Nullable<T>` (e.g. `bool?`, `int?`) must emit
/// verifiable IL and execute without
/// `System.InvalidProgramException`.
///
/// Each test builds a small CLR library in-process via
/// (cref:PersistedAssemblyBuilder) exposing `Probe.Settings` with
/// `bool? Flag` and `int? Count` auto-properties, then compiles a
/// GSharp program that exercises the assignment/read paths and runs it.
open class NullablePropertyEmitTests {
    @Fact
    func Set_BoolProperty_FromBoolLiteral_IsVerifiable() {
        let source = `package P

import System
import Probe

var s = Settings()
s.Flag = false
var o object = s.Flag
Console.WriteLine(o)
s.Flag = true
var o2 object = s.Flag
Console.WriteLine(o2)`
        let output = CompileAndRun(source)
        Assert.Equal("False${Environment.NewLine}True${Environment.NewLine}", output)
    }

    @Fact
    func Set_BoolProperty_FromNilLiteral_IsVerifiable() {
        // Boxing a `Nullable<bool>` with HasValue == false yields the CLR
        // null reference. Console.Write(null) writes the empty string, so
        // bracket the output to make the null/non-null distinction visible
        // (G#'s `==` is undefined for `object` against `nil`, so we cannot
        // assert in-program).
        let source = `package P

import System
import Probe

var s = Settings()
s.Flag = nil
var o object = s.Flag
Console.Write("[")
Console.Write(o)
Console.WriteLine("]")`
        let output = CompileAndRun(source)
        Assert.Equal("[]${Environment.NewLine}", output)
    }

    @Fact
    func Set_BoolProperty_FromExplicitNullableCtor_IsVerifiable() {
        let source = `package P

import System
import Probe

var s = Settings()
s.Flag = Nullable[bool](true)
var o object = s.Flag
Console.WriteLine(o)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func RoundTrip_BoolProperty_TrueFalseNil_BoxesCorrectly() {
        let source = `package P

import System
import Probe

var s = Settings()
s.Flag = true
var o1 object = s.Flag
Console.WriteLine(o1)

s.Flag = false
var o2 object = s.Flag
Console.WriteLine(o2)

s.Flag = nil
var o3 object = s.Flag
Console.Write("[")
Console.Write(o3)
Console.WriteLine("]")`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}[]${Environment.NewLine}", output)
    }

    @Fact
    func Read_BoolProperty_IntoLocal_IsVerifiable() {
        // Just reading `var v = s.Flag` (the second repro from #504) must
        // produce verifiable IL even when the value is never observed. Use
        // boxing afterwards so the local is alive for a real round-trip
        // assertion.
        let source = `package P

import System
import Probe

var s = Settings()
s.Flag = true
var v = s.Flag
var o object = v
Console.WriteLine(o)`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}", output)
    }

    @Fact
    func RoundTrip_IntProperty_FromLiteralAndExplicitCtor() {
        let source = `package P

import System
import Probe

var s = Settings()
s.Count = 42
var o1 object = s.Count
Console.WriteLine(o1)

s.Count = Nullable[int32](7)
var o2 object = s.Count
Console.WriteLine(o2)

s.Count = nil
var o3 object = s.Count
Console.Write("[")
Console.Write(o3)
Console.WriteLine("]")`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}7${Environment.NewLine}[]${Environment.NewLine}", output)
    }

    @Fact
    func ClrPropertyOfNullableReferenceType_AllowsNilComparison() {
        // Issue #504 related observation: a CLR property typed as a
        // reference type with `[NullableAttribute]` (e.g. C# `string?`
        // declared on a non-generic `[NullableContext]` class) must be
        // surfaced as a NullableTypeSymbol so `prop != nil` does not
        // surface GS0129. Probe.Settings.Name is declared as `string?`
        // by the in-process helper library below.
        let source = `package P

import System
import Probe

var s = Settings()
s.Name = "alice"
if s.Name != nil {
    Console.WriteLine(s.Name)
}
s.Name = nil
if s.Name == nil {
    Console.WriteLine("cleared")
}`
        let output = CompileAndRun(source)
        Assert.Equal("alice${Environment.NewLine}cleared${Environment.NewLine}", output)
    }

    shared {
        /// Compiles the supplied GSharp source against an in-process
        /// `Probe.Settings` CLR library, IL-verifies the produced assembly,
        /// then runs it with `dotnet exec` and returns stdout. The Probe
        /// library and the host's BCL `System.*` assemblies are all passed
        /// via `/r:` so `import System` resolves (issue #504 tests
        /// always reference a user assembly, which forces the host BCL closure
        /// to be enumerated explicitly).
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_nullable_prop_").FullName
            try {
                let probeDllPath = Path.Combine(tempDir, "ProbeLib.dll")
                BuildProbeLibrary(probeDllPath)
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    "/r:" + probeDllPath
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
                IlVerifier.Verify(outPath, additionalReferences: []string{probeDllPath})
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

        /// Emits a minimal `ProbeLib.dll` exposing
        /// `Probe.Settings { public bool? Flag; public int? Count }` via
        /// (cref:PersistedAssemblyBuilder). Building in-process avoids
        /// spawning `dotnet build` for the helper library and keeps tests
        /// hermetic.
        private func BuildProbeLibrary(dllPath string) {
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
            EmitAutoProperty(typeBuilder, "Name", typeof(string), referenceTypeIsNullable: true)
            // Parameterless ctor that chains to object::.ctor — required for
            // `Settings()` to be valid IL when invoked from GSharp.
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
            asmBuilder.Save(dllPath)
        }

        private func EmitAutoProperty(
            typeBuilder TypeBuilder,
            name string,
            clrType Type,
            referenceTypeIsNullable bool = false
        ) {
            let field = typeBuilder.DefineField("<" + name + ">k__BackingField", clrType, FieldAttributes.Private)
            let property = typeBuilder.DefineProperty(name, PropertyAttributes.HasDefault, clrType, parameterTypes: nil)
            if referenceTypeIsNullable && !clrType.IsValueType {
                // Emit `[NullableAttribute((byte)2)]` on the property so the
                // GSharp binder surfaces the property type as a
                // NullableTypeSymbol over the reference type (issue #209 /
                // #504 follow-up). The single-byte ctor matches what csc emits
                // for a top-level `T?` annotation.
                let nullableAttrType Type? = typeof(object).Assembly.GetType(
                    "System.Runtime.CompilerServices.NullableAttribute",
                    throwOnError: false
                )
                if nullableAttrType != nil {
                    let ctorByte ConstructorInfo? = nullableAttrType.GetConstructor([]Type{typeof(uint8)})
                    if ctorByte != nil {
                        property.SetCustomAttribute(CustomAttributeBuilder(ctorByte, []object{uint8(2)}))
                    }
                }
            }
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

        /// Host BCL assemblies passed via `/r:` so `import System`
        /// resolves when the test program also references a user-supplied
        /// library. Mirrors (cref:IlVerifier)'s runtime-reference
        /// discovery.
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
