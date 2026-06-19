// <copyright file="Issue889ArrowLambdaActionEmitTests.cs" company="GSharp">
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
/// Issue #889 — an arrow lambda <c>() -&gt; expr</c> whose trailing expression
/// yields a value (so its natural type is a <c>Func&lt;...&gt;</c>) can be
/// passed where a void-returning delegate (<c>System.Action</c> /
/// <c>Action&lt;...&gt;</c> or a named void delegate) is expected. The binder
/// target-types the literal to the delegate parameter, discarding the trailing
/// value, exactly as the <c>func() { ... }</c> statement-body form does. These
/// tests exercise variable assignment, user-function arguments, imported-CLR
/// (static method) arguments, and confirm that value-returning
/// <c>func(...) T</c> delegates keep their natural typing.
/// </summary>
public class Issue889ArrowLambdaActionEmitTests
{
    [Fact]
    public void ArrowLambda_ToActionVariable_DiscardsValue_AndRuns()
    {
        var source = """
            package P
            import System

            var called = 0
            let act Action = () -> called = called + 1
            act()
            act()
            Console.WriteLine(called)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n", output);
    }

    [Fact]
    public void ArrowLambda_CompoundAssignment_ToActionVariable_Runs()
    {
        var source = """
            package P
            import System

            var called = 0
            let act Action = () -> called += 1
            act()
            Console.WriteLine(called)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void ArrowLambda_PassedToUserFunctionExpectingAction_Runs()
    {
        var source = """
            package P
            import System

            func register(restore Action) {
              restore()
            }

            var called = 0
            register(() -> called = called + 1)
            Console.WriteLine(called)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n", output);
    }

    [Fact]
    public void ArrowLambda_WithParameter_PassedToUserFunctionExpectingActionOfInt_Runs()
    {
        var source = """
            package P
            import System

            func apply(a func(int32), v int32) {
              a(v)
            }

            var total = 0
            apply((x int32) -> total = total + x, 42)
            Console.WriteLine(total)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void ArrowLambda_ValueReturning_KeepsNaturalFuncTyping()
    {
        // Natural typing is preserved: a value-returning func type still works
        // (the void-izing only kicks in when the *target* is a void delegate).
        var source = """
            package P
            import System

            let f func() int32 = () -> 41 + 1
            Console.WriteLine(f())
            """;

        var output = CompileAndRun(source);
        Assert.Equal("42\n", output);
    }

    [Fact]
    public void ArrowLambda_PassedToImportedStaticMethodExpectingAction_Runs()
    {
        // Mirrors the exact issue scenario: a CLR static method whose sole
        // parameter is System.Action, invoked from G# with an arrow lambda
        // whose body yields a value.
        var helperDir = Directory.CreateTempSubdirectory("gs_issue889_helper_").FullName;
        try
        {
            var helperDll = Path.Combine(helperDir, "Issue889Helper.dll");
            EmitActionRunnerAssembly(helperDll);

            var source = """
                package P
                import System
                import Issue889Helper

                var called = 0
                Runner.RunIt(() -> called = called + 1)
                Console.WriteLine(called)
                """;

            var output = CompileAndRun(source, referencePaths: new[] { helperDll });
            Assert.Equal("1\n", output);
        }
        finally
        {
            try { Directory.Delete(helperDir, recursive: true); } catch { }
        }
    }

    /// <summary>
    /// Emits a tiny assembly <c>Issue889Helper</c> exposing
    /// <c>public static class Runner { public static void RunIt(Action a) =&gt; a(); }</c>
    /// so the imported-CLR static-call path can be exercised against a real
    /// <c>System.Action</c> parameter.
    /// </summary>
    /// <param name="outputPath">Where to write the emitted assembly.</param>
    private static void EmitActionRunnerAssembly(string outputPath)
    {
        var asmName = new AssemblyName("Issue889Helper");
        var ab = new PersistedAssemblyBuilder(asmName, typeof(object).Assembly);
        var module = ab.DefineDynamicModule("Issue889Helper");
        var type = module.DefineType(
            "Issue889Helper.Runner",
            TypeAttributes.Public | TypeAttributes.Abstract | TypeAttributes.Sealed);

        var method = type.DefineMethod(
            "RunIt",
            MethodAttributes.Public | MethodAttributes.Static,
            typeof(void),
            new[] { typeof(Action) });
        method.DefineParameter(1, ParameterAttributes.None, "a");

        var il = method.GetILGenerator();
        il.Emit(OpCodes.Ldarg_0);
        il.Emit(OpCodes.Callvirt, typeof(Action).GetMethod("Invoke")!);
        il.Emit(OpCodes.Ret);

        type.CreateType();
        ab.Save(outputPath);
    }

    private static string CompileAndRun(string source, string[] referencePaths = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue889_emit_").FullName;
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

                    // Co-locate the reference next to the emitted exe so the
                    // runtime can load it from the application base directory.
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
