// <copyright file="Issue538ForInEnumerableEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Regression tests for issue #538: <c>for x in expr</c> where <c>expr</c> is
/// typed as an interface (<c>IReadOnlyList&lt;T&gt;</c>, <c>IEnumerable&lt;T&gt;</c>,
/// <c>ICollection&lt;T&gt;</c>) silently crashed the emit phase with MSB4181
/// because the lowerer could not resolve <c>GetEnumerator()</c> on interface types.
///
/// The fix teaches <c>Lowerer.ResolveGetEnumerator</c> to search implemented
/// interfaces when the type itself does not directly declare the method.
/// </summary>
public class Issue538ForInEnumerableEmitTests
{
    [Fact]
    public void ForIn_IReadOnlyList_String_CountAndContents()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue538_rolist_").FullName;
        try
        {
            var helperPath = BuildProbeAssembly(tempDir);

            var source = """
                package P
                import System
                import Probe

                var items = EnumerableSource.GetReadOnlyList()
                var n = 0
                for s in items {
                  Console.WriteLine(s)
                  n = n + 1
                }
                Console.WriteLine(n)
                """;

            var output = CompileAndRunWithHelper(source, tempDir, helperPath);
            Assert.Equal("alpha\nbeta\ngamma\n3\n", output);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    [Fact]
    public void ForIn_IEnumerable_Int_TypedValueType()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue538_ienum_").FullName;
        try
        {
            var helperPath = BuildProbeAssembly(tempDir);

            var source = """
                package P
                import System
                import Probe

                var nums = EnumerableSource.GetNumbers()
                var sum = 0
                for n in nums {
                  sum = sum + n
                }
                Console.WriteLine(sum)
                """;

            var output = CompileAndRunWithHelper(source, tempDir, helperPath);
            Assert.Equal("15\n", output);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    [Fact]
    public void ForIn_ICollection_String()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue538_icoll_").FullName;
        try
        {
            var helperPath = BuildProbeAssembly(tempDir);

            var source = """
                package P
                import System
                import Probe

                var coll = EnumerableSource.GetCollection()
                var n = 0
                for s in coll {
                  Console.WriteLine(s)
                  n = n + 1
                }
                Console.WriteLine(n)
                """;

            var output = CompileAndRunWithHelper(source, tempDir, helperPath);
            Assert.Equal("x\ny\n2\n", output);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    [Fact]
    public void ForIn_EmptyIReadOnlyList_ZeroIterations()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue538_empty_").FullName;
        try
        {
            var helperPath = BuildProbeAssembly(tempDir);

            var source = """
                package P
                import System
                import Probe

                var items = EnumerableSource.GetEmptyReadOnlyList()
                var n = 0
                for s in items { n = n + 1 }
                Console.WriteLine(n)
                """;

            var output = CompileAndRunWithHelper(source, tempDir, helperPath);
            Assert.Equal("0\n", output);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    [Fact]
    public void ForIn_CustomIEnumerable_DispatchesCorrectly()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue538_custom_").FullName;
        try
        {
            var helperPath = BuildProbeAssembly(tempDir);

            var source = """
                package P
                import System
                import Probe

                var custom = EnumerableSource.GetCustomEnumerable()
                var n = 0
                for v in custom {
                  Console.WriteLine(v)
                  n = n + 1
                }
                Console.WriteLine(n)
                """;

            var output = CompileAndRunWithHelper(source, tempDir, helperPath);
            Assert.Equal("10\n20\n30\n3\n", output);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    [Fact]
    public void ForIn_ConcreteList_RegressionGuard()
    {
        // Concrete List<T> should still use the existing fast path.
        var source = """
            package P
            import System
            import System.Collections.Generic

            var list = List[string]()
            list.Add("a")
            list.Add("b")
            var n = 0
            for s in list {
              Console.WriteLine(s)
              n = n + 1
            }
            Console.WriteLine(n)
            """;

        var output = CompileAndRun(source);
        Assert.Equal("a\nb\n2\n", output);
    }

    [Fact]
    public void ForIn_ClrArray_RegressionGuard()
    {
        var source = """
            package P
            import System

            var arr = "hello world".Split(' ')
            for s in arr {
              Console.WriteLine(s)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("hello\nworld\n", output);
    }

    [Fact]
    public void ForIn_String_RegressionGuard()
    {
        var source = """
            package P
            import System

            for c in "abc" {
              Console.WriteLine(int32(c))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("97\n98\n99\n", output);
    }

    /// <summary>
    /// Builds the Probe.dll assembly with:
    /// - EnumerableSource.GetReadOnlyList() -> IReadOnlyList&lt;string&gt;
    /// - EnumerableSource.GetNumbers() -> IEnumerable&lt;int&gt;
    /// - EnumerableSource.GetCollection() -> ICollection&lt;string&gt;
    /// - EnumerableSource.GetEmptyReadOnlyList() -> IReadOnlyList&lt;string&gt;
    /// - EnumerableSource.GetCustomEnumerable() -> IEnumerable&lt;int&gt; (custom impl)
    /// </summary>
    private static string BuildProbeAssembly(string dir)
    {
        // Build the probe in a subdirectory to avoid interaction between the
        // project file, intermediate build artifacts, and the test files that
        // are written into `dir` by CompileAndRunImpl. This matches the
        // pattern used by Issue529 tests which reliably passes on CI (Linux).
        var csDir = Path.Combine(dir, "csref");
        Directory.CreateDirectory(csDir);

        var csSource = """
            using System;
            using System.Collections;
            using System.Collections.Generic;

            namespace Probe
            {
                public static class EnumerableSource
                {
                    public static IReadOnlyList<string> GetReadOnlyList()
                        => new[] { "alpha", "beta", "gamma" };

                    public static IEnumerable<int> GetNumbers()
                        => new[] { 1, 2, 3, 4, 5 };

                    public static ICollection<string> GetCollection()
                        => ["x", "y"];

                    public static IReadOnlyList<string> GetEmptyReadOnlyList()
                        => Array.Empty<string>();

                    public static IEnumerable<int> GetCustomEnumerable()
                        => new CustomEnumerable();
                }

                public class CustomEnumerable : IEnumerable<int>
                {
                    private readonly int[] data = new[] { 10, 20, 30 };

                    public IEnumerator<int> GetEnumerator() => new CustomEnumerator(data);

                    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
                }

                public class CustomEnumerator : IEnumerator<int>
                {
                    private readonly int[] data;
                    private int index = -1;

                    public CustomEnumerator(int[] data) { this.data = data; }

                    public int Current => data[index];

                    object IEnumerator.Current => Current;

                    public bool MoveNext() => ++index < data.Length;

                    public void Reset() => index = -1;

                    public void Dispose() { }
                }
            }
            """;

        File.WriteAllText(Path.Combine(csDir, "Probe.cs"), csSource);
        File.WriteAllText(Path.Combine(csDir, "Probe.csproj"), """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Library</OutputType>
                <TargetFramework>net10.0</TargetFramework>
                <AssemblyName>Probe</AssemblyName>
                <RootNamespace>Probe</RootNamespace>
              </PropertyGroup>
            </Project>
            """);

        RunDotnet(csDir, "restore");
        RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore");

        var probeDll = Path.Combine(csDir, "bin", "Release", "net10.0", "Probe.dll");
        Assert.True(File.Exists(probeDll), $"Probe.dll not found at {probeDll}");
        return probeDll;
    }

    private static void RunDotnet(string workingDir, params string[] args)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDir,
        };
        foreach (var a in args)
        {
            psi.ArgumentList.Add(a);
        }

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException($"failed to start dotnet {string.Join(" ", args)}");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(120_000), $"dotnet {args[0]} timed out");
        Assert.True(
            proc.ExitCode == 0,
            $"dotnet {string.Join(" ", args)} failed (exit {proc.ExitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue538_").FullName;
        try
        {
            return CompileAndRunImpl(source, tempDir, helperPath: null);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRunWithHelper(string source, string tempDir, string helperPath)
    {
        return CompileAndRunImpl(source, tempDir, helperPath);
    }

    private static string CompileAndRunImpl(string source, string tempDir, string helperPath)
    {
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
        };

        if (helperPath != null)
        {
            args.Add("/reference:" + helperPath);
            foreach (var reference in TrustedPlatformAssemblies())
            {
                args.Add("/reference:" + reference);
            }

            args.Add("/nowarn:GS9100");
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

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        var extraRefs = helperPath != null ? new[] { helperPath } : null;
        IlVerifier.Verify(outPath, extraRefs);

        // Copy the helper assembly next to the output so the runtime can
        // resolve it when `dotnet exec` loads the compiled test assembly.
        if (helperPath != null)
        {
            File.Copy(helperPath, Path.Combine(tempDir, Path.GetFileName(helperPath)), overwrite: true);
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
        psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
        psi.ArgumentList.Add(outPath);

        using var proc = Process.Start(psi);
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(
            proc.ExitCode == 0,
            $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

        return stdout.Replace("\r\n", "\n");
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }
}
