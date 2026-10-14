// <copyright file="Issue522InitOnlyPropertyEmitTests.cs" company="GSharp">
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

/// Issue #522 regression tests. Two facets are exercised end-to-end:
/// * Facet 1 — plain assignment to a CLR `init`-only property must
/// emit IL whose setter reference carries the
/// `modreq(IsExternalInit)` signature; previously the modreq was
/// dropped and the runtime failed with `MissingMethodException`.
/// * Facet 2 — the C#-style object initializer suffix
/// `T(args) { Prop1 = v1, … }` must parse, bind, and execute,
/// covering init-only and regular setters, the zero-property degenerate,
/// and a writable-field regression guard.
/// Each test builds a hermetic `ProbeLib.dll` in-process with
/// (cref:PersistedAssemblyBuilder), compiles a small G# program
/// against it, ilverifies the produced assembly, and runs it with
/// `dotnet exec`.
open class Issue522InitOnlyPropertyEmitTests {
    @Fact
    func PlainAssignment_ToInitOnlyProperty_RunsWithoutMissingMethodException() {
        // Facet 1: the emitter previously dropped modreq(IsExternalInit) on
        // the setter return parameter, so the runtime couldn't resolve
        // set_Asin and threw MissingMethodException.
        let source = `package P

import System
import Probe

var w = WithInit()
w.Asin = "X"
Console.WriteLine(w.Asin)`
        let output = CompileAndRun(source)
        Assert.Equal("X${Environment.NewLine}", output)
    }

    @Fact
    func ObjectInitializer_SetsInitOnlyAndRegularProperties() {
        // Facet 2: object initializer suffix lowers to a synthetic local plus
        // a chain of property assignments. Mixes init-only (Asin) and regular
        // set (Title) — both reach their setters on the constructed instance.
        let source = `package P

import System
import Probe

var w = WithInit() { Asin = "Y", Title = "T" }
Console.WriteLine(w.Asin)
Console.WriteLine(w.Title)`
        let output = CompileAndRun(source)
        Assert.Equal("Y${Environment.NewLine}T${Environment.NewLine}", output)
    }

    @Fact
    func ObjectInitializer_ZeroProperties_IsDegenerateButLegal() {
        let source = `package P

import System
import Probe

var w = WithInit() { }
Console.WriteLine(w.Asin)`
        let output = CompileAndRun(source)
        // Asin defaults to null because the auto-property backing field is
        // never assigned. Console.WriteLine renders that as an empty line.
        Assert.Equal(Environment.NewLine, output)
    }

    @Fact
    func ObjectInitializer_SinglePropertyForm_Parses() {
        let source = `package P

import System
import Probe

var w = WithInit() { Title = "only" }
Console.WriteLine(w.Title)`
        let output = CompileAndRun(source)
        Assert.Equal("only${Environment.NewLine}", output)
    }

    @Fact
    func PlainAssignment_ToRegularSetterProperty_StillWorks() {
        // Regression guard: the modreq encoding now runs for every void
        // setter; this test pins that the no-modreq path still emits a
        // method reference the runtime can resolve.
        let source = `package P

import System
import Probe

var w = WithInit()
w.Title = "Z"
Console.WriteLine(w.Title)`
        let output = CompileAndRun(source)
        Assert.Equal("Z${Environment.NewLine}", output)
    }

    shared {
        /// Compiles the supplied G# source against an in-process
        /// `Probe.WithInit` CLR library, IL-verifies the produced
        /// assembly, then runs it with `dotnet exec` and returns stdout.
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue522_").FullName
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
                } catch {
                    // Best-effort cleanup; the OS will reclaim per-test scratch
                    // directories on the next reboot.

                }
            }
        }

        /// Emits a minimal `ProbeLib.dll` exposing
        /// `Probe.WithInit { public string Asin { get; init; } public string Title { get; set; } }`.
        /// The init-only accessor is materialised by tagging the setter's
        /// return-parameter with `modreq(System.Runtime.CompilerServices.IsExternalInit)`,
        /// matching what the C# compiler emits for a `{ init; }` accessor.
        private func BuildProbeLibrary(dllPath string) {
            let coreAssembly = typeof(object).Assembly
            let asmName = AssemblyName("ProbeLib"){Version = Version(1, 0, 0, 0)}
            let asmBuilder = PersistedAssemblyBuilder(asmName, coreAssembly)
            let moduleBuilder = asmBuilder.DefineDynamicModule("ProbeLib")
            let typeBuilder = moduleBuilder.DefineType(
                "Probe.WithInit",
                TypeAttributes.Public | TypeAttributes.Class | TypeAttributes.AutoLayout | TypeAttributes.BeforeFieldInit,
                parent: typeof(object)
            )
            EmitProperty(typeBuilder, "Asin", typeof(string), initOnly: true)
            EmitProperty(typeBuilder, "Title", typeof(string), initOnly: false)
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

        private func EmitProperty(typeBuilder TypeBuilder, name string, clrType Type, initOnly bool) {
            let field = typeBuilder.DefineField("<" + name + ">k__BackingField", clrType, FieldAttributes.Private)
            let property = typeBuilder.DefineProperty(name, PropertyAttributes.HasDefault, clrType, parameterTypes: nil)
            const accessorAttrs = MethodAttributes.Public | MethodAttributes.SpecialName | MethodAttributes.HideBySig
            let getter = typeBuilder.DefineMethod("get_" + name, accessorAttrs, clrType, Type.EmptyTypes)
            let getterIl = getter.GetILGenerator()
            getterIl.Emit(OpCodes.Ldarg_0)
            getterIl.Emit(OpCodes.Ldfld, field)
            getterIl.Emit(OpCodes.Ret)
            // Init-only setters carry modreq(IsExternalInit) on the void return
            // type. PersistedAssemblyBuilder.DefineMethod's overload taking
            // returnTypeRequiredCustomModifiers encodes this directly into the
            // method's metadata signature — which is exactly what set-property
            // reference resolution in the runtime uses to bind the call.
            let isExternalInit Type? = coreOf(typeof(object)).GetType(
                "System.Runtime.CompilerServices.IsExternalInit",
                throwOnError: false
            )
            let returnRequiredMods = if initOnly && isExternalInit != nil {
                []Type{isExternalInit}
            } else {
                Type.EmptyTypes
            }
            let setter = typeBuilder.DefineMethod(
                "set_" + name,
                accessorAttrs,
                CallingConventions.HasThis,
                returnType: nil,
                returnTypeRequiredCustomModifiers: returnRequiredMods,
                returnTypeOptionalCustomModifiers: nil,
                parameterTypes: []Type{clrType},
                parameterTypeRequiredCustomModifiers: nil,
                parameterTypeOptionalCustomModifiers: nil
            )
            let setterIl = setter.GetILGenerator()
            setterIl.Emit(OpCodes.Ldarg_0)
            setterIl.Emit(OpCodes.Ldarg_1)
            setterIl.Emit(OpCodes.Stfld, field)
            setterIl.Emit(OpCodes.Ret)
            property.SetGetMethod(getter)
            property.SetSetMethod(setter)
        }

        private func coreOf(t Type) Assembly -> t.Assembly

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
