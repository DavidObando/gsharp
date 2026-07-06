// <copyright file="Issue2181GenericExplicitInterfaceImplEmitTests.cs" company="GSharp">
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
/// Issue #2181 (follow-up to #2010): a method using the reserved
/// <c>__explicit_&lt;Interface&gt;__&lt;Member&gt;</c> mangled convention
/// correctly satisfied a NON-generic interface member, but was not recognized
/// when the interface was GENERIC — the class was wrongly reported as not
/// implementing the interface method (GS0187).
/// <para>
/// Two defects were fixed. (1) The binder-side
/// <c>DeclarationBinder.QualifyInterfaceName</c> included the generic
/// type-parameter suffix (<c>ICallback[T, TResult]</c>) in the name it matched
/// against the mangled component, while cs2gs formats that component with
/// <c>SymbolDisplayGenericsOptions.None</c> (simple name only); the suffix is
/// now stripped so the names match. (2) The emitter's
/// <c>EmitExplicitInterfaceMethodImpls</c> looked for the linked interface
/// member on the interface DEFINITION's method table, but for a constructed
/// generic interface the linked member is the SUBSTITUTED instance on the
/// constructed interface — so no <c>MethodImpl</c> row was emitted and the
/// type failed to load. The emitter now matches the constructed instance's
/// methods and maps back to the open slot for token resolution.
/// </para>
/// <para>The non-generic path (issue #2010) is intentionally unchanged.</para>
/// </summary>
public class Issue2181GenericExplicitInterfaceImplEmitTests
{
    private const string GenericReproSource = """
        package Oahu.Aux

        interface ICallback[T, TResult] {
            func Interact(value T) TResult;
        }

        open class Callback[T, TResult] : ICallback[T, TResult] {
            private func __explicit_Oahu_Aux_ICallback__Interact(value T) TResult -> OnInteract(value)

            protected open func OnInteract(value T) TResult {
                return default(TResult)
            }
        }

        open class Doubler : Callback[int32, int32] {
            protected override func OnInteract(value int32) int32 {
                return value * 2
            }
        }
        """;

    private const string NonGenericReproSource = """
        package Oahu.Aux

        interface ICallback2 {
            func Interact(value int32) string;
        }

        open class Callback2 : ICallback2 {
            private func __explicit_Oahu_Aux_ICallback2__Interact(value int32) string -> OnInteract(value)

            protected open func OnInteract(value int32) string {
                return "base"
            }
        }
        """;

    [Fact]
    public void GenericExplicitImpl_Compiles_EmitsMethodImplRow_IlVerifies()
    {
        var dllPath = CompileLibrary(GenericReproSource);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            TypeDefinition callback = default;
            bool foundCallback = false;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(typeHandle);
                if (reader.GetString(td.Name).StartsWith("Callback", StringComparison.Ordinal) &&
                    reader.GetString(td.Name) != "Callback2")
                {
                    callback = td;
                    foundCallback = true;
                    break;
                }
            }

            Assert.True(foundCallback, "expected to find the generic Callback type");

            // The mangled explicit-impl body survives as its own MethodDef.
            int mangledBodies = callback.GetMethods()
                .Select(mh => reader.GetString(reader.GetMethodDefinition(mh).Name))
                .Count(n => n == "__explicit_Oahu_Aux_ICallback__Interact");
            Assert.Equal(1, mangledBodies);

            // Issue #2181: a MethodImpl row must bind the mangled body to the
            // (generic) interface's Interact slot — without it the type fails
            // to load at runtime with a TypeLoadException.
            int methodImplRows = callback.GetMethodImplementations().Count();
            Assert.Equal(1, methodImplRows);
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void GenericExplicitImpl_DispatchesThroughConstructedInterface()
    {
        // End-to-end: an ICallback[int32, int32]-typed reference routes into
        // the mangled explicit implementation, which forwards to the overriding
        // OnInteract body (value * 2). Proves the constructed-generic slot is
        // wired up at the CLR level.
        var source = GenericReproSource + """


            var obj = Doubler{}
            var cb ICallback[int32, int32] = obj
            Console.WriteLine(cb.Interact(21))
            """;

        Assert.Equal("42\n", CompileAndRun(source));
    }

    [Fact]
    public void NonGenericExplicitImpl_StillCompilesAndDispatches()
    {
        // Regression guard: the issue #2010 non-generic path is unchanged.
        var source = NonGenericReproSource + """


            var obj = Callback2{}
            var cb ICallback2 = obj
            Console.WriteLine(cb.Interact(7))
            """;

        Assert.Equal("base\n", CompileAndRun(source));
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2181_lib_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2181_exe_").FullName;
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
