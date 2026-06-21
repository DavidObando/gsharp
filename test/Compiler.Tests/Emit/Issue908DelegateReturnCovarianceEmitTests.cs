// <copyright file="Issue908DelegateReturnCovarianceEmitTests.cs" company="GSharp">
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
/// Issue #908 — an arrow lambda (or explicit-but-derived-return <c>func</c>
/// literal) whose body yields a <em>derived</em> reference type must bind where
/// a <c>Func&lt;TBase&gt;</c> delegate parameter is expected, on CLR static AND
/// instance method calls. Two compounding gaps are exercised:
/// <list type="number">
/// <item><description>
/// Delegate return-type covariance in conversion / overload resolution: a
/// function value of type <c>() -&gt; TDerived</c> satisfies a parameter typed
/// <c>() -&gt; TBase</c> (mirroring C#/CLR reference-preserving delegate
/// covariance). This covers the explicit <c>func() TDerived { ... }</c> form
/// whose declared return type is not overridden by target-typing.
/// </description></item>
/// <item><description>
/// Target-typing of lambda arguments on plain CLR static and instance method
/// calls (previously wired only into the constructor path), so the arrow
/// lambda's return type is pinned from the parameter's delegate type before
/// overload resolution rather than from its body.
/// </description></item>
/// </list>
/// The covariance scenario uses BCL <c>Stream</c> / <c>MemoryStream</c>
/// (<c>MemoryStream : Stream</c>) so the produced delegate is created over a
/// method whose return is covariance-compatible and the emitted IL verifies.
/// </summary>
public class Issue908DelegateReturnCovarianceEmitTests
{
    [Fact]
    public void ArrowLambda_DerivedBody_ToStaticFuncBaseParameter_Runs()
    {
        RunWithHelper("""
            package P
            import System
            import System.IO
            import Issue908Helper

            let r = Factory.CreateStatic(() -> MemoryStream())
            Console.WriteLine(r)
            """, "MemoryStream\n");
    }

    [Fact]
    public void ExplicitDerivedReturnFuncLiteral_ToStaticFuncBaseParameter_Runs()
    {
        RunWithHelper("""
            package P
            import System
            import System.IO
            import Issue908Helper

            let r = Factory.CreateStatic(func() MemoryStream { return MemoryStream() })
            Console.WriteLine(r)
            """, "MemoryStream\n");
    }

    [Fact]
    public void ArrowLambda_DerivedBody_ToInstanceFuncBaseParameter_Runs()
    {
        RunWithHelper("""
            package P
            import System
            import System.IO
            import Issue908Helper

            let f = Factory()
            let r = f.CreateInstance(() -> MemoryStream())
            Console.WriteLine(r)
            """, "MemoryStream\n");
    }

    [Fact]
    public void ExplicitDerivedReturnFuncLiteral_ToInstanceFuncBaseParameter_Runs()
    {
        RunWithHelper("""
            package P
            import System
            import System.IO
            import Issue908Helper

            let f = Factory()
            let r = f.CreateInstance(func() MemoryStream { return MemoryStream() })
            Console.WriteLine(r)
            """, "MemoryStream\n");
    }

    private static void RunWithHelper(string source, string expected)
    {
        var helperDir = Directory.CreateTempSubdirectory("gs_issue908_helper_").FullName;
        try
        {
            var helperDll = Path.Combine(helperDir, "Issue908Helper.dll");
            EmitFactoryAssembly(helperDll);
            var output = CompileAndRun(source, referencePaths: new[] { helperDll });
            Assert.Equal(expected, output);
        }
        finally
        {
            try { Directory.Delete(helperDir, recursive: true); } catch { }
        }
    }

    /// <summary>
    /// Emits a tiny assembly <c>Issue908Helper</c> exposing a <c>Factory</c>
    /// class with a public parameterless constructor, a static
    /// <c>string CreateStatic(Func&lt;Stream&gt;)</c> method, and an instance
    /// <c>string CreateInstance(Func&lt;Stream&gt;)</c> method. Each invokes the
    /// supplied factory and returns the runtime type name of the produced
    /// stream (e.g. <c>"MemoryStream"</c>).
    /// </summary>
    /// <param name="outputPath">Where to write the emitted assembly.</param>
    private static void EmitFactoryAssembly(string outputPath)
    {
        var asmName = new AssemblyName("Issue908Helper");
        var ab = new PersistedAssemblyBuilder(asmName, typeof(object).Assembly);
        var module = ab.DefineDynamicModule("Issue908Helper");
        var type = module.DefineType(
            "Issue908Helper.Factory",
            TypeAttributes.Public | TypeAttributes.Class);

        var factoryType = typeof(Func<Stream>);
        var invoke = factoryType.GetMethod("Invoke")!;
        var getType = typeof(object).GetMethod("GetType", Type.EmptyTypes)!;
        var getName = typeof(Type).GetProperty("Name")!.GetGetMethod()!;

        // public Factory() { }
        var ctor = type.DefineConstructor(
            MethodAttributes.Public,
            CallingConventions.HasThis,
            Type.EmptyTypes);
        var ctorIl = ctor.GetILGenerator();
        ctorIl.Emit(OpCodes.Ldarg_0);
        ctorIl.Emit(OpCodes.Call, typeof(object).GetConstructor(Type.EmptyTypes)!);
        ctorIl.Emit(OpCodes.Ret);

        // public static string CreateStatic(Func<Stream> f) => f().GetType().Name;
        var createStatic = type.DefineMethod(
            "CreateStatic",
            MethodAttributes.Public | MethodAttributes.Static,
            typeof(string),
            new[] { factoryType });
        createStatic.DefineParameter(1, ParameterAttributes.None, "f");
        var staticIl = createStatic.GetILGenerator();
        staticIl.Emit(OpCodes.Ldarg_0);
        staticIl.Emit(OpCodes.Callvirt, invoke);
        staticIl.Emit(OpCodes.Callvirt, getType);
        staticIl.Emit(OpCodes.Callvirt, getName);
        staticIl.Emit(OpCodes.Ret);

        // public string CreateInstance(Func<Stream> f) => f().GetType().Name;
        var createInstance = type.DefineMethod(
            "CreateInstance",
            MethodAttributes.Public,
            typeof(string),
            new[] { factoryType });
        createInstance.DefineParameter(1, ParameterAttributes.None, "f");
        var instanceIl = createInstance.GetILGenerator();
        instanceIl.Emit(OpCodes.Ldarg_1);
        instanceIl.Emit(OpCodes.Callvirt, invoke);
        instanceIl.Emit(OpCodes.Callvirt, getType);
        instanceIl.Emit(OpCodes.Callvirt, getName);
        instanceIl.Emit(OpCodes.Ret);

        type.CreateType();
        ab.Save(outputPath);
    }

    private static string CompileAndRun(string source, string[] referencePaths = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue908_emit_").FullName;
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
