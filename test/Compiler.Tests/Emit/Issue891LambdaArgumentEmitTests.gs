// <copyright file="Issue891LambdaArgumentEmitTests.cs" company="GSharp">
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

/// Issue #891 — arrow lambdas as method/constructor arguments.
///
/// Problem A: an arrow lambda passed as a NAMED argument to a constructor whose
/// parameter is a `Func<...>` delegate (skipping an earlier optional
/// parameter) must target-type to that delegate — including a statement-body
/// lambda that only throws — instead of misrouting to the data-struct
/// `.copy(...)` named-argument path (which reported the misleading
/// "Named arguments are only supported for data-struct .copy(...)").
///
/// Problem B: an un-typed arrow lambda passed to a generic LINQ extension method
/// (`Single<TSource>(this IEnumerable<TSource>, Func<TSource,bool>)`)
/// must infer its parameter type from the delegate parameter so the extension
/// method resolves and the predicate body type-checks to `bool`. A follow-up
/// extends this to selectors whose result type is only inferable from the body
/// (`Select<TSource,TResult>(IEnumerable<TSource>, Func<TSource,TResult>)`).
open class Issue891LambdaArgumentEmitTests {
    @Fact
    func ProblemA_ArrowLambda_AsNamedFuncArgument_ValueReturning_Runs() {
        // System.Lazy<T>(Func<T> valueFactory) exercises the single named-argument
        // routing that previously misrouted to the .copy(...) path.
        let source = `package P
import System

let box = Lazy[int32](valueFactory: () -> 42)
Console.WriteLine(box.Value)`
        let output = CompileAndRun(source)
        Assert.Equal("42${Environment.NewLine}", output)
    }

    @Fact
    func ProblemA_ArrowLambda_AsNamedFuncArgument_ThrowOnlyBody_Runs() {
        // A statement-body arrow lambda that only throws has no natural return
        // value; it must still target-type to Func<string> for the named arg.
        let source = `package P
import System

let box = Lazy[string](valueFactory: () -> {
    throw InvalidOperationException("must not be invoked")
})
Console.WriteLine("ok")`
        let output = CompileAndRun(source)
        Assert.Equal("ok${Environment.NewLine}", output)
    }

    @Fact
    func ProblemA_ArrowLambda_AsNamedFuncArgument_SkippingOptionalParameter_Runs() {
        // Faithful reproduction of the issue's DoctorService-style constructor:
        //   DoctorService(int logger = 0, Func<string> httpClientFactory = null)
        // invoked with only the named Func argument so the leading optional
        // parameter is filled from its default.
        let helperDir = Directory.CreateTempSubdirectory("gs_issue891_helper_").FullName
        try {
            let helperDll = Path.Combine(helperDir, "Issue891Helper.dll")
            EmitDoctorServiceAssembly(helperDll)
            let source = `package P
import System
import Issue891Helper

let svc = DoctorService(httpClientFactory: () -> "made")
Console.WriteLine(svc.Probe())`
            let output = CompileAndRun(source, referencePaths: []string{helperDll})
            Assert.Equal("made${Environment.NewLine}", output)
        } finally {
            try {
                Directory.Delete(helperDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func ProblemA_ArrowLambda_AsNamedFuncArgument_ThrowOnly_SkippingOptionalParameter_Runs() {
        let helperDir = Directory.CreateTempSubdirectory("gs_issue891_helper_throw_").FullName
        try {
            let helperDll = Path.Combine(helperDir, "Issue891Helper.dll")
            EmitDoctorServiceAssembly(helperDll)
            // The factory is never invoked, so the throwing body never runs.
            let source = `package P
import System
import Issue891Helper

let svc = DoctorService(httpClientFactory: () -> {
    throw InvalidOperationException("HTTP must not be invoked when --skip-network is set")
})
Console.WriteLine("constructed")`
            let output = CompileAndRun(source, referencePaths: []string{helperDll})
            Assert.Equal("constructed${Environment.NewLine}", output)
        } finally {
            try {
                Directory.Delete(helperDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func ProblemB_ArrowLambda_AsGenericLinqSinglePredicate_Runs() {
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

let nums = List[int32]()
nums.Add(1)
nums.Add(2)
nums.Add(3)
let found = nums.Single((x) -> x == 2)
Console.WriteLine(found)`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}", output)
    }

    @Fact
    func ProblemB_ArrowLambda_PredicateBody_TypeChecksToBool_OverString() {
        // Mirrors the issue's `report.Checks.Single(c -> c.Id == "audible-api")`
        // shape: the lambda parameter type is inferred from the delegate, and the
        // predicate body comparing a string property type-checks to bool.
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

let ids = List[string]()
ids.Add("audible-api")
ids.Add("network")
let net = ids.Single((c) -> c == "network")
Console.WriteLine(net)`
        let output = CompileAndRun(source)
        Assert.Equal("network${Environment.NewLine}", output)
    }

    @Fact
    func ProblemB_ArrowLambda_AsGenericLinqSelector_BodyInferredResult_Runs() {
        // Follow-up to issue #891: an un-typed arrow lambda passed to
        // Select<TSource,TResult>(IEnumerable<TSource>, Func<TSource,TResult>)
        // must infer its parameter type from the receiver (TSource) even though
        // TResult is only inferable from the lambda body. Previously this
        // reported "Cannot find function Select" / GS0304 and only worked with a
        // typed parameter (`(x int32) -> ...`).
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

let nums = List[int32]()
nums.Add(1)
nums.Add(2)
nums.Add(3)
let doubled = nums.Select((x) -> x * 2).ToList()
Console.WriteLine(doubled.Count)
Console.WriteLine(doubled[2])`
        let output = CompileAndRun(source)
        Assert.Equal("3${Environment.NewLine}6${Environment.NewLine}", output)
    }

    @Fact
    func ProblemB_ArrowLambda_AsGenericLinqSelector_ProjectsToDifferentType_Runs() {
        // The selector's result type (TResult) is inferred from the body: a
        // string-valued body must yield a HashSet[string], not HashSet[object].
        // Mirrors the issue's `report.Checks.Select((c) -> c.Id).ToHashSet()`
        // shape where the projection accesses a member of the inferred element.
        let source = `package P
import System
import System.Linq
import System.Collections.Generic

let words = List[string]()
words.Add("audible-api")
words.Add("net")
words.Add("audible-api")
let ids = words.Select((w) -> w.ToUpper()).ToHashSet()
Console.WriteLine(ids.Count)
Console.WriteLine(ids.Contains("NET"))`
        let output = CompileAndRun(source)
        Assert.Equal("2${Environment.NewLine}True${Environment.NewLine}", output)
    }

    shared {
        /// Emits a tiny assembly `Issue891Helper` exposing a
        /// `DoctorService` class whose constructor mirrors the issue:
        /// `DoctorService(int logger = 0, Func<string> httpClientFactory = null)`,
        /// plus a `string Probe()` instance method that invokes the factory
        /// (or returns `"none"` when it was not supplied).
        /// @param outputPath Where to write the emitted assembly.
        private func EmitDoctorServiceAssembly(outputPath string) {
            let asmName = AssemblyName("Issue891Helper")
            let ab = PersistedAssemblyBuilder(asmName, typeof(object).Assembly)
            let module = ab.DefineDynamicModule("Issue891Helper")
            let type = module.DefineType("Issue891Helper.DoctorService", TypeAttributes.Public | TypeAttributes.Class)
            let factoryType = typeof(() -> string)
            let factoryField = type.DefineField("_factory", factoryType, FieldAttributes.Private)
            let ctor = type.DefineConstructor(
                MethodAttributes.Public,
                CallingConventions.HasThis,
                []Type{typeof(int32), factoryType}
            )
            let loggerParam = ctor.DefineParameter(
                1,
                ParameterAttributes.Optional | ParameterAttributes.HasDefault,
                "logger"
            )
            loggerParam.SetConstant(0)
            let factoryParam = ctor.DefineParameter(
                2,
                ParameterAttributes.Optional | ParameterAttributes.HasDefault,
                "httpClientFactory"
            )
            factoryParam.SetConstant(nil)
            let ctorIl = ctor.GetILGenerator()
            ctorIl.Emit(OpCodes.Ldarg_0)
            ctorIl.Emit(OpCodes.Call, typeof(object).GetConstructor(Type.EmptyTypes)!!)
            ctorIl.Emit(OpCodes.Ldarg_0)
            ctorIl.Emit(OpCodes.Ldarg_2)
            ctorIl.Emit(OpCodes.Stfld, factoryField)
            ctorIl.Emit(OpCodes.Ret)
            let probe = type.DefineMethod("Probe", MethodAttributes.Public, typeof(string), Type.EmptyTypes)
            let probeIl = probe.GetILGenerator()
            let noneLabel = probeIl.DefineLabel()
            probeIl.Emit(OpCodes.Ldarg_0)
            probeIl.Emit(OpCodes.Ldfld, factoryField)
            probeIl.Emit(OpCodes.Brfalse_S, noneLabel)
            probeIl.Emit(OpCodes.Ldarg_0)
            probeIl.Emit(OpCodes.Ldfld, factoryField)
            probeIl.Emit(OpCodes.Callvirt, factoryType.GetMethod("Invoke")!!)
            probeIl.Emit(OpCodes.Ret)
            probeIl.MarkLabel(noneLabel)
            probeIl.Emit(OpCodes.Ldstr, "none")
            probeIl.Emit(OpCodes.Ret)
            type.CreateType()
            ab.Save(outputPath)
        }

        private func CompileAndRun(source string, referencePaths[]?string = nil) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue891_emit_").FullName
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
