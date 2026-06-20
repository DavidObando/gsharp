// <copyright file="Issue891LambdaArgumentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Reflection.Emit;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #891 — arrow lambdas as method/constructor arguments.
/// <para>
/// Problem A: an arrow lambda passed as a NAMED argument to a constructor whose
/// parameter is a <c>Func&lt;...&gt;</c> delegate (skipping an earlier optional
/// parameter) must target-type to that delegate — including a statement-body
/// lambda that only throws — instead of misrouting to the data-struct
/// <c>.copy(...)</c> named-argument path (which reported the misleading
/// "Named arguments are only supported for data-struct .copy(...)").
/// </para>
/// <para>
/// Problem B: an un-typed arrow lambda passed to a generic LINQ extension method
/// (<c>Single&lt;TSource&gt;(this IEnumerable&lt;TSource&gt;, Func&lt;TSource,bool&gt;)</c>)
/// must infer its parameter type from the delegate parameter so the extension
/// method resolves and the predicate body type-checks to <c>bool</c>. A follow-up
/// extends this to selectors whose result type is only inferable from the body
/// (<c>Select&lt;TSource,TResult&gt;(IEnumerable&lt;TSource&gt;, Func&lt;TSource,TResult&gt;)</c>).
/// </para>
/// </summary>
public class Issue891LambdaArgumentEmitTests
{
    [Fact]
    public void ProblemA_ArrowLambda_AsNamedFuncArgument_ValueReturning_Runs()
    {
        // System.Lazy<T>(Func<T> valueFactory) exercises the single named-argument
        // routing that previously misrouted to the .copy(...) path.
        var source = """
            package P
            import System

            let box = Lazy[int32](valueFactory: () -> 42)
            Console.WriteLine(box.Value)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void ProblemA_ArrowLambda_AsNamedFuncArgument_ThrowOnlyBody_Runs()
    {
        // A statement-body arrow lambda that only throws has no natural return
        // value; it must still target-type to Func<string> for the named arg.
        var source = """
            package P
            import System

            let box = Lazy[string](valueFactory: () -> {
                throw InvalidOperationException("must not be invoked")
            })
            Console.WriteLine("ok")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("ok\n", output);
    }

    [Fact]
    public void ProblemA_ArrowLambda_AsNamedFuncArgument_SkippingOptionalParameter_Runs()
    {
        // Faithful reproduction of the issue's DoctorService-style constructor:
        //   DoctorService(int logger = 0, Func<string> httpClientFactory = null)
        // invoked with only the named Func argument so the leading optional
        // parameter is filled from its default.
        var helperDir = Directory.CreateTempSubdirectory("gs_issue891_helper_").FullName;
        try
        {
            var helperDll = Path.Combine(helperDir, "Issue891Helper.dll");
            EmitDoctorServiceAssembly(helperDll);

            var source = """
                package P
                import System
                import Issue891Helper

                let svc = DoctorService(httpClientFactory: () -> "made")
                Console.WriteLine(svc.Probe())
                """;

            var output = CompileAndRun(source, referencePaths: new[] { helperDll });
            Assert.Equal("made\n", output);
        }
        finally
        {
            try { Directory.Delete(helperDir, recursive: true); } catch { }
        }
    }

    [Fact]
    public void ProblemA_ArrowLambda_AsNamedFuncArgument_ThrowOnly_SkippingOptionalParameter_Runs()
    {
        var helperDir = Directory.CreateTempSubdirectory("gs_issue891_helper_throw_").FullName;
        try
        {
            var helperDll = Path.Combine(helperDir, "Issue891Helper.dll");
            EmitDoctorServiceAssembly(helperDll);

            // The factory is never invoked, so the throwing body never runs.
            var source = """
                package P
                import System
                import Issue891Helper

                let svc = DoctorService(httpClientFactory: () -> {
                    throw InvalidOperationException("HTTP must not be invoked when --skip-network is set")
                })
                Console.WriteLine("constructed")
                """;

            var output = CompileAndRun(source, referencePaths: new[] { helperDll });
            Assert.Equal("constructed\n", output);
        }
        finally
        {
            try { Directory.Delete(helperDir, recursive: true); } catch { }
        }
    }

    [Fact]
    public void ProblemB_ArrowLambda_AsGenericLinqSinglePredicate_Runs()
    {
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            let nums = List[int32]()
            nums.Add(1)
            nums.Add(2)
            nums.Add(3)
            let found = nums.Single((x) -> x == 2)
            Console.WriteLine(found)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void ProblemB_ArrowLambda_PredicateBody_TypeChecksToBool_OverString()
    {
        // Mirrors the issue's `report.Checks.Single(c -> c.Id == "audible-api")`
        // shape: the lambda parameter type is inferred from the delegate, and the
        // predicate body comparing a string property type-checks to bool.
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            let ids = List[string]()
            ids.Add("audible-api")
            ids.Add("network")
            let net = ids.Single((c) -> c == "network")
            Console.WriteLine(net)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("network\n", output);
    }

    [Fact]
    public void ProblemB_ArrowLambda_AsGenericLinqSelector_BodyInferredResult_Runs()
    {
        // Follow-up to issue #891: an un-typed arrow lambda passed to
        // Select<TSource,TResult>(IEnumerable<TSource>, Func<TSource,TResult>)
        // must infer its parameter type from the receiver (TSource) even though
        // TResult is only inferable from the lambda body. Previously this
        // reported "Cannot find function Select" / GS0304 and only worked with a
        // typed parameter (`(x int32) -> ...`).
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            let nums = List[int32]()
            nums.Add(1)
            nums.Add(2)
            nums.Add(3)
            let doubled = nums.Select((x) -> x * 2).ToList()
            Console.WriteLine(doubled.Count)
            Console.WriteLine(doubled[2])
            """;

        var output = CompileAndRun(source);
        Assert.Equal("3\n6\n", output);
    }

    [Fact]
    public void ProblemB_ArrowLambda_AsGenericLinqSelector_ProjectsToDifferentType_Runs()
    {
        // The selector's result type (TResult) is inferred from the body: a
        // string-valued body must yield a HashSet[string], not HashSet[object].
        // Mirrors the issue's `report.Checks.Select((c) -> c.Id).ToHashSet()`
        // shape where the projection accesses a member of the inferred element.
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            let words = List[string]()
            words.Add("audible-api")
            words.Add("net")
            words.Add("audible-api")
            let ids = words.Select((w) -> w.ToUpper()).ToHashSet()
            Console.WriteLine(ids.Count)
            Console.WriteLine(ids.Contains("NET"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\nTrue\n", output);
    }

    /// <summary>
    /// Emits a tiny assembly <c>Issue891Helper</c> exposing a
    /// <c>DoctorService</c> class whose constructor mirrors the issue:
    /// <c>DoctorService(int logger = 0, Func&lt;string&gt; httpClientFactory = null)</c>,
    /// plus a <c>string Probe()</c> instance method that invokes the factory
    /// (or returns <c>"none"</c> when it was not supplied).
    /// </summary>
    /// <param name="outputPath">Where to write the emitted assembly.</param>
    private static void EmitDoctorServiceAssembly(string outputPath)
    {
        var asmName = new AssemblyName("Issue891Helper");
        var ab = new PersistedAssemblyBuilder(asmName, typeof(object).Assembly);
        var module = ab.DefineDynamicModule("Issue891Helper");
        var type = module.DefineType(
            "Issue891Helper.DoctorService",
            TypeAttributes.Public | TypeAttributes.Class);

        var factoryType = typeof(Func<string>);
        var factoryField = type.DefineField("_factory", factoryType, FieldAttributes.Private);

        var ctor = type.DefineConstructor(
            MethodAttributes.Public,
            CallingConventions.HasThis,
            new[] { typeof(int), factoryType });
        var loggerParam = ctor.DefineParameter(1, ParameterAttributes.Optional | ParameterAttributes.HasDefault, "logger");
        loggerParam.SetConstant(0);
        var factoryParam = ctor.DefineParameter(2, ParameterAttributes.Optional | ParameterAttributes.HasDefault, "httpClientFactory");
        factoryParam.SetConstant(null);

        var ctorIl = ctor.GetILGenerator();
        ctorIl.Emit(OpCodes.Ldarg_0);
        ctorIl.Emit(OpCodes.Call, typeof(object).GetConstructor(Type.EmptyTypes)!);
        ctorIl.Emit(OpCodes.Ldarg_0);
        ctorIl.Emit(OpCodes.Ldarg_2);
        ctorIl.Emit(OpCodes.Stfld, factoryField);
        ctorIl.Emit(OpCodes.Ret);

        var probe = type.DefineMethod(
            "Probe",
            MethodAttributes.Public,
            typeof(string),
            Type.EmptyTypes);
        var probeIl = probe.GetILGenerator();
        var noneLabel = probeIl.DefineLabel();
        probeIl.Emit(OpCodes.Ldarg_0);
        probeIl.Emit(OpCodes.Ldfld, factoryField);
        probeIl.Emit(OpCodes.Brfalse_S, noneLabel);
        probeIl.Emit(OpCodes.Ldarg_0);
        probeIl.Emit(OpCodes.Ldfld, factoryField);
        probeIl.Emit(OpCodes.Callvirt, factoryType.GetMethod("Invoke")!);
        probeIl.Emit(OpCodes.Ret);
        probeIl.MarkLabel(noneLabel);
        probeIl.Emit(OpCodes.Ldstr, "none");
        probeIl.Emit(OpCodes.Ret);

        type.CreateType();
        ab.Save(outputPath);
    }

    private static string CompileAndRun(string source, string[] referencePaths = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue891_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new System.Collections.Generic.List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            if (referencePaths != null)
            {
                foreach (var reference in referencePaths)
                {
                    args.Add("/reference:" + reference);
                    File.Copy(reference, Path.Combine(tempDir, Path.GetFileName(reference)), overwrite: true);
                }
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath, additionalReferences: referencePaths);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
