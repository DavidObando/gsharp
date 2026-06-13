// <copyright file="PrivateInterfaceHelpersEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0090 / issue #756 — <c>private</c> interface helper methods.
/// Validates the CLR emit shape end-to-end: a private interface helper is
/// emitted as <c>Private | HideBySig</c> (instance), NOT virtual / abstract,
/// and carries an IL body. A sibling default method may call the helper;
/// an implementer that omits both inherits only the public default and
/// cannot see the helper. The library passes ilverify.
/// </summary>
public class PrivateInterfaceHelpersEmitTests
{
    [Fact]
    public void PrivateInterfaceHelper_InterfaceMetadata_IsPrivateHideBySig_NotVirtual()
    {
        var source = """
            package Probe
            import System

            interface ICalc {
                func Double(x int32) int32 { return Helper(x) + Helper(x) }
                private func Helper(x int32) int32 { return x }
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            MethodDefinitionHandle? helperHandle = null;
            MethodDefinitionHandle? doubleHandle = null;
            foreach (var typeHandle in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(typeHandle);
                if (!reader.StringComparer.Equals(td.Name, "ICalc"))
                {
                    continue;
                }

                foreach (var mh in td.GetMethods())
                {
                    var md = reader.GetMethodDefinition(mh);
                    if (reader.StringComparer.Equals(md.Name, "Helper"))
                    {
                        helperHandle = mh;
                    }
                    else if (reader.StringComparer.Equals(md.Name, "Double"))
                    {
                        doubleHandle = mh;
                    }
                }
            }

            Assert.True(helperHandle.HasValue, "expected to find Helper on ICalc");
            Assert.True(doubleHandle.HasValue, "expected to find Double on ICalc");

            var helper = reader.GetMethodDefinition(helperHandle.Value);
            var helperAttrs = helper.Attributes;
            var helperVisibility = helperAttrs & MethodAttributes.MemberAccessMask;
            Assert.True(helperVisibility == MethodAttributes.Private, $"private interface helper must be Private; got {helperVisibility}");
            Assert.True((helperAttrs & MethodAttributes.HideBySig) != 0, "private interface helper must be HideBySig");
            Assert.True((helperAttrs & MethodAttributes.Virtual) == 0, "private interface helper must NOT be virtual");
            Assert.True((helperAttrs & MethodAttributes.Abstract) == 0, "private interface helper must NOT be abstract");
            Assert.True((helperAttrs & MethodAttributes.NewSlot) == 0, "private interface helper must NOT carry NewSlot");
            Assert.True((helperAttrs & MethodAttributes.Static) == 0, "instance private helper must NOT be static");
            Assert.True(helper.RelativeVirtualAddress != 0, "private interface helper must carry a body (non-zero RVA)");

            // The sibling public default is still emitted as Public | Virtual.
            var dbl = reader.GetMethodDefinition(doubleHandle.Value);
            var dblVisibility = dbl.Attributes & MethodAttributes.MemberAccessMask;
            Assert.Equal(MethodAttributes.Public, dblVisibility);
            Assert.True((dbl.Attributes & MethodAttributes.Virtual) != 0, "sibling public default must be Virtual");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void EndToEnd_PublicDefaultCallsPrivateHelper_RuntimeDispatchWorks()
    {
        // ADR-0090: a default method on an interface may call its private
        // helper via implicit `this`. The implementer that omits both
        // inherits the public default, which transparently delegates to the
        // helper at runtime.
        var source = """
            package Probe
            import System

            interface ICalc {
                func Double(x int32) int32 { return Helper(x) + Helper(x) }
                private func Helper(x int32) int32 { return x }
            }

            class C : ICalc {
            }

            func Main() {
                var c ICalc = C{}
                Console.WriteLine(c.Double(7))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("14\n", output);
    }

    [Fact]
    public void EndToEnd_ImplementerCannotSeeHelper_FromOutsideInterface()
    {
        // ADR-0090: external code (a class accessor) cannot call the private
        // helper through an interface-typed receiver — GS0334 fires during
        // compilation.
        var source = """
            package Probe
            import System

            interface ICalc {
                func Double(x int32) int32 { return x + x }
                private func Helper(x int32) int32 { return x }
            }

            class C : ICalc {
            }

            func Main() {
                var c ICalc = C{}
                Console.WriteLine(c.Helper(3))
            }
            """;

        var (exit, stdout, stderr) = CompileExpectingFailure(source);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0334", stdout + stderr);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_pih_lib_").FullName;
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
        var tempDir = Directory.CreateTempSubdirectory("gs_pih_exe_").FullName;
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

    private static (int Exit, string Stdout, string Stderr) CompileExpectingFailure(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_pih_fail_").FullName;
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

            return (compileExit, stdoutWriter.ToString(), stderrWriter.ToString());
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
