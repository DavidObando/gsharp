// <copyright file="Issue698DeinitEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #698 / ADR-0068: end-to-end emit tests for the Swift-style
/// <c>deinit { … }</c> destructor.
/// </summary>
/// <remarks>
/// Each test compiles via <c>gsc</c>, runs <c>ilverify</c>, and then either
/// reflects on the produced assembly or executes it under <c>dotnet exec</c>
/// to assert behavior.
/// </remarks>
public class Issue698DeinitEmitTests
{
    [Fact]
    public void Deinit_EmitsProtectedVirtualFinalizeOverride()
    {
        var source = """
            package Probe
            import System

            type Resource class {
                var Tag string = ""
                deinit {
                    Console.WriteLine(Tag)
                }
            }

            var _ = Resource()
            """;

        WithCompiledAssembly(source, asmPath =>
        {
            // Load the produced assembly in a fresh AppDomain-ish reflection
            // context so we can inspect the emitted Finalize method.
            var asm = Assembly.LoadFile(asmPath);
            var resource = asm.GetTypes().Single(t => t.Name == "Resource");
            var finalize = resource.GetMethod(
                "Finalize",
                BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);

            Assert.NotNull(finalize);
            Assert.Equal(typeof(void), finalize.ReturnType);
            Assert.Empty(finalize.GetParameters());
            Assert.True(finalize.IsFamily, "Finalize must be `protected` (Family)");
            Assert.True(finalize.IsVirtual);
            Assert.True(finalize.IsHideBySig);

            // The emitted override must resolve back to System.Object.Finalize.
            var baseDef = finalize.GetBaseDefinition();
            Assert.Equal("Finalize", baseDef.Name);
            Assert.Equal(typeof(object), baseDef.DeclaringType);
        });
    }

    [Fact]
    public void Deinit_RunsUserBody_WhenGCCollects()
    {
        var source = """
            package Probe
            import System

            type Resource class {
                var Tag string = ""
                init(tag string) {
                    Tag = tag
                }
                deinit {
                    Console.WriteLine("deinit: " + Tag)
                }
            }

            func Allocate() {
                var _ = Resource("alpha")
            }

            Allocate()
            GC.Collect()
            GC.WaitForPendingFinalizers()
            Console.WriteLine("done")
            """;

        var output = CompileAndRun(source);
        Assert.Contains("deinit: alpha", output);
        Assert.Contains("done", output);
    }

    [Fact]
    public void Deinit_OnSubclass_RunsBothFinalizers()
    {
        var source = """
            package Probe
            import System

            type Resource open class(Tag string) {
                deinit {
                    Console.WriteLine("base: " + Tag)
                }
            }

            type CachedResource class : Resource {
                var Key string = ""
                init(tag string, key string) : base(tag) {
                    Key = key
                }
                deinit {
                    Console.WriteLine("derived: " + Key)
                }
            }

            func Allocate() {
                var _ = CachedResource("db", "users")
            }

            Allocate()
            GC.Collect()
            GC.WaitForPendingFinalizers()
            Console.WriteLine("done")
            """;

        var output = CompileAndRun(source);

        // The derived-class Finalize runs first, then chains into the base
        // Finalize via the wrapping `finally { base.Finalize(); }`.
        Assert.Contains("derived: users", output);
        Assert.Contains("base: db", output);
        var dIdx = output.IndexOf("derived: users", StringComparison.Ordinal);
        var bIdx = output.IndexOf("base: db", StringComparison.Ordinal);
        Assert.InRange(dIdx, 0, int.MaxValue);
        Assert.InRange(bIdx, 0, int.MaxValue);
        Assert.True(dIdx < bIdx, "derived deinit must run before base deinit");
    }

    [Fact]
    public void Deinit_OnStruct_FailsToCompile()
    {
        var source = """
            package Probe
            type Point struct {
                var X int32 = 0
                deinit {
                }
            }
            """;

        var errors = CompileExpectingErrors(source);
        Assert.Contains(errors, e => e.Contains("GS0289"));
    }

    [Fact]
    public void Deinit_AssemblyPassesIlVerify()
    {
        var source = """
            package Probe
            import System

            type Resource open class(Tag string) {
                deinit {
                    Console.WriteLine("dispose: " + Tag)
                }
            }

            type CachedResource class : Resource {
                init(tag string) : base(tag) {
                }
                deinit {
                    Console.WriteLine("cached gone")
                }
            }

            var _ = CachedResource("x")
            """;

        // CompileAndRun already invokes IlVerifier.Verify on the produced
        // assembly. Just calling it is the assertion.
        var output = CompileAndRun(source);
        Assert.NotNull(output);
    }

    private static void WithCompiledAssembly(string source, Action<string> probe)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue698_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
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
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);
            probe(outPath);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // ignored
            }
        }
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue698_run_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
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
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

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
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // ignored
            }
        }
    }

    private static System.Collections.Generic.List<string> CompileExpectingErrors(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue698_err_").FullName;
        try
        {
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

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
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

            Assert.True(compileExit != 0, "expected gsc to report errors but it succeeded");
            var combined = compileOut.ToString() + compileErr.ToString();
            return combined.Split('\n').Where(l => !string.IsNullOrWhiteSpace(l)).ToList();
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // ignored
            }
        }
    }
}
