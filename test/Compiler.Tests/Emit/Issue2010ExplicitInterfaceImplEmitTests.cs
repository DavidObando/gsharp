// <copyright file="Issue2010ExplicitInterfaceImplEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2010 (follow-up to #1911 / PR #1994): a C# explicit interface
/// implementation (<c>string IFoo.Bar() { ... }</c>) has no G# spelling
/// (ADR-0091 rejected an `IFoo.M(this)` surface syntax). The #1911 fix
/// collapsed two same-name/same-signature explicit implementations of
/// DIFFERENT interfaces onto a single surviving method body (dropping the
/// other, reported via an <c>Unsupported</c> diagnostic).
/// <para>
/// This fix instead lets each explicit implementation keep its own distinct
/// body as a separate G# method whose name follows the reserved
/// <c>__explicit_&lt;Interface&gt;__&lt;Member&gt;</c> mangled convention. The
/// binder links each such method to the specific interface member it
/// implements (<see cref="GSharp.Core.CodeAnalysis.Symbols.FunctionSymbol.ExplicitInterfaceMember"/>)
/// and the emitter binds an explicit CLR <c>MethodImpl</c> row (mirroring the
/// ADR-0089 static-virtual / issue #985 bridge machinery) so each interface's
/// dispatch slot routes to its own method body — full fidelity, zero drops.
/// </para>
/// </summary>
public class Issue2010ExplicitInterfaceImplEmitTests
{
    private const string ReproSource = """
        package GapCheck

        interface IFoo {
            func Bar() string;
        }

        interface IBaz {
            func Bar() string;
        }

        class Both : IFoo, IBaz {
            func __explicit_GapCheck_IFoo__Bar() string {
                return "foo"
            }

            func __explicit_GapCheck_IBaz__Bar() string {
                return "baz"
            }
        }
        """;

    [Fact]
    public void CollidingExplicitImpls_Compile_EmitDistinctMethodsAndMethodImplRows_IlVerifies()
    {
        var dllPath = CompileLibrary(ReproSource);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            TypeDefinition both = default;
            bool foundBoth = false;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(typeHandle);
                if (reader.GetString(td.Name) == "Both")
                {
                    both = td;
                    foundBoth = true;
                    break;
                }
            }

            Assert.True(foundBoth, "expected to find the Both type");

            // (1) Two distinct MethodDef rows survive — no drop.
            int fooBody = 0;
            int bazBody = 0;
            foreach (var mh in both.GetMethods())
            {
                var md = reader.GetMethodDefinition(mh);
                var name = reader.GetString(md.Name);
                if (name == "__explicit_GapCheck_IFoo__Bar")
                {
                    fooBody++;
                }
                else if (name == "__explicit_GapCheck_IBaz__Bar")
                {
                    bazBody++;
                }
            }

            Assert.Equal(1, fooBody);
            Assert.Equal(1, bazBody);

            // (2) Two MethodImpl rows binding each mangled method to its own
            // interface's Bar() slot.
            int methodImplRows = 0;
            foreach (var miHandle in both.GetMethodImplementations())
            {
                reader.GetMethodImplementation(miHandle);
                methodImplRows++;
            }

            Assert.Equal(2, methodImplRows);
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void CollidingExplicitImpls_DispatchToDistinctBodiesThroughEachInterface()
    {
        // End-to-end: each interface-typed reference reaches its OWN body,
        // proving no collapse/drop of either explicit implementation.
        var source = ReproSource + """


            var obj = Both{}
            var asFoo IFoo = obj
            var asBaz IBaz = obj
            Console.WriteLine(asFoo.Bar())
            Console.WriteLine(asBaz.Bar())
            """;

        Assert.Equal("foo\nbaz\n", CompileAndRun(source));
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2010_lib_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new[]
        {
            "/out:" + outPath,
            "/target:library",
            "/targetframework:net10.0",
            srcPath,
        };

        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
        int compileExit;
        try
        {
            compileExit = Program.Main(args);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2010_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static void TryCleanup(string dllPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(dllPath);
            if (dir != null && Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
        }
    }
}
