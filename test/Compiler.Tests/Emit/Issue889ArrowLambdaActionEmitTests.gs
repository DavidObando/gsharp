// <copyright file="Issue889ArrowLambdaActionEmitTests.cs" company="GSharp">
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

/// Issue #889 — an arrow lambda `() -> expr` whose trailing expression
/// yields a value (so its natural type is a `Func<...>`) can be
/// passed where a void-returning delegate (`System.Action` /
/// `Action<...>` or a named void delegate) is expected. The binder
/// target-types the literal to the delegate parameter, discarding the trailing
/// value, exactly as the `func() { ... }` statement-body form does. These
/// tests exercise variable assignment, user-function arguments, imported-CLR
/// (static method) arguments, and confirm that value-returning
/// `func(...) T` delegates keep their natural typing.
open class Issue889ArrowLambdaActionEmitTests {
    @Fact
    func ArrowLambda_ToActionVariable_DiscardsValue_AndRuns() {
        let source = `package P
import System

var called = 0
let act Action = () -> called = called + 1
act()
act()
Console.WriteLine(called)`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func ArrowLambda_CompoundAssignment_ToActionVariable_Runs() {
        let source = `package P
import System

var called = 0
let act Action = () -> called += 1
act()
Console.WriteLine(called)`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func ArrowLambda_PassedToUserFunctionExpectingAction_Runs() {
        let source = `package P
import System

func register(restore Action) {
  restore()
}

var called = 0
register(() -> called = called + 1)
Console.WriteLine(called)`
        let output = CompileAndRun(source)
        Assert.Equal("1${Environment.NewLine}", output)
    }

    @Fact
    func ArrowLambda_WithParameter_PassedToUserFunctionExpectingActionOfInt_Runs() {
        let source = `package P
import System

func apply(a func(int32), v int32) {
  a(v)
}

var total = 0
apply((x int32) -> total = total + x, 42)
Console.WriteLine(total)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func ArrowLambda_ValueReturning_KeepsNaturalFuncTyping() {
        // Natural typing is preserved: a value-returning func type still works
        // (the void-izing only kicks in when the *target* is a void delegate).
        let source = `package P
import System

let f func() int32 = () -> 41 + 1
Console.WriteLine(f())`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func ArrowLambda_PassedToImportedStaticMethodExpectingAction_Runs() {
        // Mirrors the exact issue scenario: a CLR static method whose sole
        // parameter is System.Action, invoked from G# with an arrow lambda
        // whose body yields a value.
        let helperDir = Directory.CreateTempSubdirectory("gs_issue889_helper_").FullName
        try {
            let helperDll = Path.Combine(helperDir, "Issue889Helper.dll")
            EmitActionRunnerAssembly(helperDll)
            let source = `package P
import System
import Issue889Helper

var called = 0
Runner.RunIt(() -> called = called + 1)
Console.WriteLine(called)`
            let output = CompileAndRun(source, referencePaths: []string{helperDll})
            Assert.Equal("1${Environment.NewLine}", output)
        } finally {
            try {
                Directory.Delete(helperDir, recursive: true)
            } catch { }
        }
    }

    shared {
        /// Emits a tiny assembly `Issue889Helper` exposing
        /// `public static class Runner { public static void RunIt(Action a) => a(); }`
        /// so the imported-CLR static-call path can be exercised against a real
        /// `System.Action` parameter.
        /// @param outputPath Where to write the emitted assembly.
        private func EmitActionRunnerAssembly(outputPath string) {
            let asmName = AssemblyName("Issue889Helper")
            let ab = PersistedAssemblyBuilder(asmName, typeof(object).Assembly)
            let module = ab.DefineDynamicModule("Issue889Helper")
            let type = module.DefineType(
                "Issue889Helper.Runner",
                TypeAttributes.Public | TypeAttributes.Abstract | TypeAttributes.Sealed
            )
            let method = type.DefineMethod(
                "RunIt",
                MethodAttributes.Public | MethodAttributes.Static,
                typeof(Void),
                []Type{typeof(() -> void)}
            )
            method.DefineParameter(1, ParameterAttributes.None, "a")
            let il = method.GetILGenerator()
            il.Emit(OpCodes.Ldarg_0)
            il.Emit(OpCodes.Callvirt, typeof(() -> void).GetMethod("Invoke")!!)
            il.Emit(OpCodes.Ret)
            type.CreateType()
            ab.Save(outputPath)
        }

        private func CompileAndRun(source string, referencePaths[]?string = nil) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue889_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                if referencePaths != nil {
                    for reference in referencePaths {
                        args.Add("/reference:" + reference)
                        // Co-locate the reference next to the emitted exe so the
                        // runtime can load it from the application base directory.
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
