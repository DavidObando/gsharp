// <copyright file="Issue987AbstractMethodEmitTests.cs" company="GSharp">
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
/// Issue #987: end-to-end CLR emit + ilverify coverage for abstract members. A
/// no-body <c>open func F() R;</c> on an <c>open class</c> is the canonical G#
/// spelling of a C# <c>abstract</c> method. Validates that the original GS9998
/// emit ICE is gone, that the declaring type is emitted with
/// <c>TypeAttributes.Abstract</c> and the method with
/// <c>MethodAttributes.Abstract | Virtual | NewSlot</c> (no IL body), that a
/// concrete override makes the type constructible with working virtual
/// dispatch, and that the GS0386 (cannot instantiate abstract type) and GS0387
/// (concrete class missing an inherited abstract override) diagnostics fire.
/// </summary>
public class Issue987AbstractMethodEmitTests
{
    [Fact]
    public void AbstractMethod_ReproCompiles_TypeAndMethodAreAbstract()
    {
        var source = """
            package T
            open class Shape {
                open func Area() float64;
            }
            """;

        var dllPath = CompileLibrary(source);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            TypeDefinition? shape = null;
            foreach (var th in reader.TypeDefinitions)
            {
                var td = reader.GetTypeDefinition(th);
                if (reader.StringComparer.Equals(td.Name, "Shape"))
                {
                    shape = td;
                }
            }

            Assert.True(shape.HasValue, "expected to find type Shape");
            Assert.True(
                shape.Value.Attributes.HasFlag(TypeAttributes.Abstract),
                "Shape must be emitted with TypeAttributes.Abstract");
            Assert.False(
                shape.Value.Attributes.HasFlag(TypeAttributes.Sealed),
                "an abstract class must not be Sealed");

            MethodDefinition? area = null;
            foreach (var mh in shape.Value.GetMethods())
            {
                var md = reader.GetMethodDefinition(mh);
                if (reader.StringComparer.Equals(md.Name, "Area"))
                {
                    area = md;
                }
            }

            Assert.True(area.HasValue, "expected to find Shape::Area");
            Assert.True(area.Value.Attributes.HasFlag(MethodAttributes.Abstract), "Area must be Abstract");
            Assert.True(area.Value.Attributes.HasFlag(MethodAttributes.Virtual), "Area must be Virtual");
            Assert.True(area.Value.Attributes.HasFlag(MethodAttributes.NewSlot), "Area must be NewSlot");
            Assert.False(area.Value.Attributes.HasFlag(MethodAttributes.Final), "an abstract method must not be Final");
            Assert.True(area.Value.RelativeVirtualAddress == 0, "an abstract method must carry no IL body");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void EndToEnd_ConcreteOverride_PrintsAreaViaVirtualDispatch()
    {
        var source = """
            package T
            import System
            open class Shape { open func Area() float64; }
            class Circle(R float64) : Shape { override func Area() float64 { return 3.14159 * R * R } }
            let s Shape = Circle(2.0)
            Console.WriteLine(s.Area().ToString())
            """;

        var output = CompileAndRun(source);
        var first = output.Replace("\r\n", "\n").Split('\n')[0];
        var value = double.Parse(first, System.Globalization.CultureInfo.InvariantCulture);
        Assert.True(Math.Abs(value - 12.566) < 0.01, $"expected area ≈ 12.566 via virtual dispatch but got {value}");
    }

    [Fact]
    public void ConstructingAbstractType_FailsWithGS0386()
    {
        var source = """
            package T
            open class Shape { open func Area() float64; }
            let bad = Shape()
            """;

        var (exit, stdout) = TryCompileLibrary(source);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0386", stdout);
    }

    [Fact]
    public void ConcreteDerivedMissingOverride_FailsWithGS0387()
    {
        var source = """
            package T
            open class Shape { open func Area() float64; }
            class Circle(R float64) : Shape { }
            """;

        var (exit, stdout) = TryCompileLibrary(source);
        Assert.NotEqual(0, exit);
        Assert.Contains("GS0387", stdout);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_abs_lib_").FullName;
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

        var (exit, stdout, stderr) = RunGsc(args);
        Assert.True(exit == 0, $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");

        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static (int Exit, string Stdout) TryCompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_abs_neg_").FullName;
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

            var (exit, stdout, _) = RunGsc(args);
            return (exit, stdout);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static (int Exit, string Stdout, string Stderr) RunGsc(string[] args)
    {
        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
        int exit;
        try
        {
            exit = Program.Main(args);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return (exit, stdoutWriter.ToString(), stderrWriter.ToString());
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_abs_exe_").FullName;
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

            var (exit, stdout, stderr) = RunGsc(args);
            Assert.True(exit == 0, $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");

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
            var procOut = proc.StandardOutput.ReadToEnd();
            var procErr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(proc.ExitCode == 0, $"exited {proc.ExitCode}\nstdout:\n{procOut}\nstderr:\n{procErr}");

            return procOut.Replace("\r\n", "\n");
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
