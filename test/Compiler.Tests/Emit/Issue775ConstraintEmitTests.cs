// <copyright file="Issue775ConstraintEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0097 / issue #775: end-to-end emit + IL-verify coverage for the
/// new G# spelling of <c>class</c> / <c>struct</c> / <c>new()</c>
/// type-parameter constraints. Each test:
/// <list type="number">
/// <item>compiles a tiny program containing a generic function with the
/// constraint;</item>
/// <item>asks <see cref="IlVerifier.Verify"/> to confirm the produced
/// IL passes formal verification;</item>
/// <item>inspects the emitted assembly metadata to confirm the
/// <see cref="GenericParameterAttributes"/> flag bits were written
/// exactly as ECMA-335 II.10.1.7 mandates; and</item>
/// <item>runs the produced binary under the CoreCLR JIT to confirm
/// the constraint is enforced at run time as well.</item>
/// </list>
/// </summary>
public class Issue775ConstraintEmitTests
{
    [Fact]
    public void ClassConstraint_Emits_ReferenceTypeConstraint_Flag()
    {
        var source = """
            package P
            import System

            func Pick[T class](x T) T { return x }
            Console.WriteLine(Pick[string]("hi"))
            """;

        var outPath = CompileAndRun(source, out var output);
        Assert.Equal("hi\n", output);

        var attrs = ReadGenericParamAttrs(outPath, "Pick");
        Assert.True((attrs & GenericParameterAttributes.ReferenceTypeConstraint) != 0,
            $"expected ReferenceTypeConstraint, got {attrs}");
        Assert.True((attrs & GenericParameterAttributes.NotNullableValueTypeConstraint) == 0,
            $"unexpected NotNullableValueTypeConstraint, got {attrs}");
        Assert.True((attrs & GenericParameterAttributes.DefaultConstructorConstraint) == 0,
            $"unexpected DefaultConstructorConstraint, got {attrs}");
    }

    [Fact]
    public void StructConstraint_Emits_ValueType_And_DefaultCtor_Flags()
    {
        var source = """
            package P
            import System

            func Pick[T struct](x T) T { return x }
            Console.WriteLine(Pick[int32](42))
            """;

        var outPath = CompileAndRun(source, out var output);
        Assert.Equal("42\n", output);

        var attrs = ReadGenericParamAttrs(outPath, "Pick");
        Assert.True((attrs & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0,
            $"expected NotNullableValueTypeConstraint, got {attrs}");
        // ECMA-335 II.10.1.7 — `struct` implies `new()` at the CLR level.
        Assert.True((attrs & GenericParameterAttributes.DefaultConstructorConstraint) != 0,
            $"expected DefaultConstructorConstraint (struct implies it), got {attrs}");
        Assert.True((attrs & GenericParameterAttributes.ReferenceTypeConstraint) == 0,
            $"unexpected ReferenceTypeConstraint, got {attrs}");
    }

    [Fact]
    public void NewConstraint_Emits_DefaultCtor_Flag_Only()
    {
        var source = """
            package P
            import System

            class Box {}
            func Make[T new()](x T) T { return x }
            Console.WriteLine(Make(Box()))
            """;

        var outPath = CompileAndRun(source, out _);
        var attrs = ReadGenericParamAttrs(outPath, "Make");
        Assert.True((attrs & GenericParameterAttributes.DefaultConstructorConstraint) != 0,
            $"expected DefaultConstructorConstraint, got {attrs}");
        Assert.True((attrs & GenericParameterAttributes.ReferenceTypeConstraint) == 0,
            $"unexpected ReferenceTypeConstraint, got {attrs}");
        Assert.True((attrs & GenericParameterAttributes.NotNullableValueTypeConstraint) == 0,
            $"unexpected NotNullableValueTypeConstraint, got {attrs}");
    }

    [Fact]
    public void ClassAndNew_Combined_Emits_Both_Flags()
    {
        var source = """
            package P
            import System

            class Box {}
            func Make[T class new()](x T) T { return x }
            Console.WriteLine(Make(Box()))
            """;

        var outPath = CompileAndRun(source, out _);
        var attrs = ReadGenericParamAttrs(outPath, "Make");
        Assert.True((attrs & GenericParameterAttributes.ReferenceTypeConstraint) != 0,
            $"expected ReferenceTypeConstraint, got {attrs}");
        Assert.True((attrs & GenericParameterAttributes.DefaultConstructorConstraint) != 0,
            $"expected DefaultConstructorConstraint, got {attrs}");
    }

    private static GenericParameterAttributes ReadGenericParamAttrs(string assemblyPath, string methodName)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        var md = pe.GetMetadataReader();

        foreach (var mh in md.MethodDefinitions)
        {
            var mdef = md.GetMethodDefinition(mh);
            var name = md.GetString(mdef.Name);
            if (name != methodName)
            {
                continue;
            }

            var gps = mdef.GetGenericParameters();
            Assert.True(gps.Count >= 1, $"no generic parameters on '{methodName}'");
            var gpHandle = gps.First();
            var gp = md.GetGenericParameter(gpHandle);
            return gp.Attributes;
        }

        throw new Xunit.Sdk.XunitException($"could not find method '{methodName}' in '{assemblyPath}'");
    }

    private static string CompileAndRun(string source, out string output)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue775_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

            // Stash the produced assembly outside the temp dir so the
            // caller can inspect metadata after the temp dir is cleaned.
            var keepDir = Directory.CreateTempSubdirectory("gs_issue775_keep_").FullName;
            var keepPath = Path.Combine(keepDir, Path.GetFileName(outPath));
            File.Copy(outPath, keepPath);

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

            output = stdout.Replace("\r\n", "\n");
            return keepPath;
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
