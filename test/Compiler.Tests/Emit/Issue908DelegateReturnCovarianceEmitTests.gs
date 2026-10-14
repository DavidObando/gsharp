// <copyright file="Issue908DelegateReturnCovarianceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Reflection
import System.Reflection.Emit
import Xunit
import Xunit.Sdk

/// Issue #908 — an arrow lambda (or explicit-but-derived-return `func`
/// literal) whose body yields a <em>derived</em> reference type must bind where
/// a `Func<TBase>` delegate parameter is expected, on CLR static AND
/// instance method calls. Two compounding gaps are exercised:
/// 1. Delegate return-type covariance in conversion / overload resolution: a function value of type
/// `() -> TDerived` satisfies a parameter typed `() -> TBase` (mirroring C#/CLR reference-preserving
/// delegate covariance). This covers the explicit `func() TDerived { ... }` form whose declared return
/// type is not overridden by target-typing.
/// 2. Target-typing of lambda arguments on plain CLR static and instance method calls (previously wired
/// only into the constructor path), so the arrow lambda's return type is pinned from the parameter's
/// delegate type before overload resolution rather than from its body.
/// The covariance scenario uses BCL `Stream` / `MemoryStream`
/// (`MemoryStream : Stream`) so the produced delegate is created over a
/// method whose return is covariance-compatible and the emitted IL verifies.
open class Issue908DelegateReturnCovarianceEmitTests {
    @Fact
    func ArrowLambda_DerivedBody_ToStaticFuncBaseParameter_Runs() {
        RunWithHelper(`package P
import System
import System.IO
import Issue908Helper

let r = Factory.CreateStatic(() -> MemoryStream())
Console.WriteLine(r)`, "MemoryStream\n")
    }

    @Fact
    func ExplicitDerivedReturnFuncLiteral_ToStaticFuncBaseParameter_Runs() {
        RunWithHelper(`package P
import System
import System.IO
import Issue908Helper

let r = Factory.CreateStatic(func() MemoryStream { return MemoryStream() })
Console.WriteLine(r)`, "MemoryStream\n")
    }

    @Fact
    func ArrowLambda_DerivedBody_ToInstanceFuncBaseParameter_Runs() {
        RunWithHelper(`package P
import System
import System.IO
import Issue908Helper

let f = Factory()
let r = f.CreateInstance(() -> MemoryStream())
Console.WriteLine(r)`, "MemoryStream\n")
    }

    @Fact
    func ExplicitDerivedReturnFuncLiteral_ToInstanceFuncBaseParameter_Runs() {
        RunWithHelper(`package P
import System
import System.IO
import Issue908Helper

let f = Factory()
let r = f.CreateInstance(func() MemoryStream { return MemoryStream() })
Console.WriteLine(r)`, "MemoryStream\n")
    }

    shared {
        private func RunWithHelper(source string, expected string) {
            let helperDir = Directory.CreateTempSubdirectory("gs_issue908_helper_").FullName
            try {
                let helperDll = Path.Combine(helperDir, "Issue908Helper.dll")
                EmitFactoryAssembly(helperDll)
                let output = CompileAndRun(source, referencePaths: []string{helperDll})
                Assert.Equal(expected, output)
            } finally {
                try {
                    Directory.Delete(helperDir, recursive: true)
                } catch { }
            }
        }

        /// Emits a tiny assembly `Issue908Helper` exposing a `Factory`
        /// class with a public parameterless constructor, a static
        /// `string CreateStatic(Func<Stream>)` method, and an instance
        /// `string CreateInstance(Func<Stream>)` method. Each invokes the
        /// supplied factory and returns the runtime type name of the produced
        /// stream (e.g. `"MemoryStream"`).
        /// @param outputPath Where to write the emitted assembly.
        private func EmitFactoryAssembly(outputPath string) {
            let asmName = AssemblyName("Issue908Helper")
            let ab = PersistedAssemblyBuilder(asmName, typeof(object).Assembly)
            let module = ab.DefineDynamicModule("Issue908Helper")
            let type = module.DefineType("Issue908Helper.Factory", TypeAttributes.Public | TypeAttributes.Class)
            let factoryType = typeof(() -> Stream)
            let invoke = factoryType.GetMethod("Invoke")!!
            let getType = typeof(object).GetMethod("GetType", Type.EmptyTypes)!!
            let getName = typeof(Type).GetProperty("Name")!!.GetGetMethod()!!
            // public Factory() { }
            let ctor = type.DefineConstructor(MethodAttributes.Public, CallingConventions.HasThis, Type.EmptyTypes)
            let ctorIl = ctor.GetILGenerator()
            ctorIl.Emit(OpCodes.Ldarg_0)
            ctorIl.Emit(OpCodes.Call, typeof(object).GetConstructor(Type.EmptyTypes)!!)
            ctorIl.Emit(OpCodes.Ret)
            // public static string CreateStatic(Func<Stream> f) => f().GetType().Name;
            let createStatic = type.DefineMethod(
                "CreateStatic",
                MethodAttributes.Public | MethodAttributes.Static,
                typeof(string),
                []Type{factoryType}
            )
            createStatic.DefineParameter(1, ParameterAttributes.None, "f")
            let staticIl = createStatic.GetILGenerator()
            staticIl.Emit(OpCodes.Ldarg_0)
            staticIl.Emit(OpCodes.Callvirt, invoke)
            staticIl.Emit(OpCodes.Callvirt, getType)
            staticIl.Emit(OpCodes.Callvirt, getName)
            staticIl.Emit(OpCodes.Ret)
            // public string CreateInstance(Func<Stream> f) => f().GetType().Name;
            let createInstance = type.DefineMethod(
                "CreateInstance",
                MethodAttributes.Public,
                typeof(string),
                []Type{factoryType}
            )
            createInstance.DefineParameter(1, ParameterAttributes.None, "f")
            let instanceIl = createInstance.GetILGenerator()
            instanceIl.Emit(OpCodes.Ldarg_1)
            instanceIl.Emit(OpCodes.Callvirt, invoke)
            instanceIl.Emit(OpCodes.Callvirt, getType)
            instanceIl.Emit(OpCodes.Callvirt, getName)
            instanceIl.Emit(OpCodes.Ret)
            type.CreateType()
            ab.Save(outputPath)
        }

        private func CompileAndRun(source string, referencePaths[]?string = nil) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue908_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                if referencePaths != nil {
                    for reference in referencePaths {
                        args.Add("/reference:" + reference)
                        File.Copy(reference, Path.Combine(tempDir, Path.GetFileName(reference)), overwrite: true)
                    }
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
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath, additionalReferences: referencePaths)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
