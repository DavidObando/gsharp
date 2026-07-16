// <copyright file="Issue2385NullableSameCompilationStructGenericArgEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2385 (deferred finding from #2381): an imported generic collection
/// closed over a <em>nullable same-compilation struct/enum</em> (e.g.
/// <c>List[Point?]</c>) produced <c>System.InvalidProgramException</c> at
/// runtime. <see cref="GSharp.Core.CodeAnalysis.Binding.ConversionClassifier
/// .TrySubstituteParameterTypeFromReceiver"/> recovers the substituted
/// parameter type for a call on an imported generic receiver (e.g.
/// <c>List[T].Add(!0)</c>) whose type argument is a same-compilation user
/// type, so the correct conversion (<c>T -&gt; Nullable&lt;T&gt;</c>) is
/// bound instead of the erased/boxing shape. Its gate previously only
/// matched a receiver type argument that was DIRECTLY a
/// <c>StructSymbol</c>/<c>InterfaceSymbol</c>/<c>EnumSymbol</c>/
/// <c>DelegateTypeSymbol</c> (or nested <c>ImportedTypeSymbol</c>) — a
/// <c>NullableTypeSymbol</c> wrapping one of those (the actual shape of
/// <c>List[Point?]</c>'s type argument) matched none of those cases, so the
/// whole substitution was skipped and the call fell back to the erased CLR
/// parameter type (<c>object</c>), misclassifying the argument as boxing.
/// The emitted <c>box</c>/bare <c>ldnull</c> IL is invalid against what is
/// actually a value-type <c>Nullable&lt;T&gt;</c> generic parameter slot,
/// producing <c>InvalidProgramException</c> at runtime (no compile-time
/// diagnostic — <see cref="IlVerifier"/> is what catches this class of
/// defect).
/// <para>
/// The fix replaces the narrow ad hoc predicate with
/// <c>TypeSymbol.ContainsSameCompilationUserType</c> — the general,
/// already-established predicate (reused from the analogous #2381 fix) that
/// recurses uniformly through <c>NullableTypeSymbol</c> (and
/// <c>SliceTypeSymbol</c>/<c>ArrayTypeSymbol</c>/<c>TupleTypeSymbol</c>/nested
/// <c>ImportedTypeSymbol</c>), so it additionally and for-free generalizes to
/// same-compilation ENUMS wrapped in <c>Nullable&lt;T&gt;</c>.
/// </para>
/// </summary>
public class Issue2385NullableSameCompilationStructGenericArgEmitTests
{
    [Fact]
    public void ListOfNullableUserStruct_AddConcreteAndNil_RunsAndVerifies()
    {
        const string source = """
            package i2385struct
            import System
            import System.Collections.Generic

            struct Point2385(X int32, Y int32) { }

            func main() {
                let list = List[Point2385?]()
                list.Add(Point2385(1, 2))
                list.Add(nil)
                let first = list[0] ?? Point2385(0, 0)
                let second = list[1] ?? Point2385(-1, -1)
                Console.WriteLine(list.Count)
                Console.WriteLine(first.X)
                Console.WriteLine(second.X)
            }

            main()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n1\n-1\n", output);
    }

    [Fact]
    public void ListOfNullableUserEnum_AddConcreteAndNil_RunsAndVerifies()
    {
        const string source = """
            package i2385enum
            import System
            import System.Collections.Generic

            enum Color2385 { Red, Green, Blue }

            func main() {
                let list = List[Color2385?]()
                list.Add(Color2385.Blue)
                list.Add(nil)
                let first = list[0] ?? Color2385.Red
                let second = list[1] ?? Color2385.Red
                Console.WriteLine(list.Count)
                Console.WriteLine(first)
                Console.WriteLine(second)
            }

            main()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n2\n0\n", output);
    }

    [Fact]
    public void DictionaryValueNullableUserStruct_IndexerSetAndGet_RunsAndVerifies()
    {
        const string source = """
            package i2385dict
            import System
            import System.Collections.Generic

            struct Point2385Dict(X int32, Y int32) { }

            func main() {
                let dict = Dictionary[string, Point2385Dict?]()
                dict["a"] = Point2385Dict(3, 4)
                dict["b"] = nil
                let a = dict["a"] ?? Point2385Dict(0, 0)
                let b = dict["b"] ?? Point2385Dict(-1, -1)
                Console.WriteLine(dict.Count)
                Console.WriteLine(a.X)
                Console.WriteLine(b.X)
            }

            main()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n3\n-1\n", output);
    }

    [Fact]
    public void ListOfNonNullableUserStruct_AddConcreteValue_RegressionStillRuns()
    {
        // Regression control: the pre-existing (#765) DIRECT (non-nullable)
        // same-compilation struct type argument must keep working exactly
        // as before the widened gate.
        const string source = """
            package i2385directstruct
            import System
            import System.Collections.Generic

            struct Point2385Direct(X int32, Y int32) { }

            func main() {
                let list = List[Point2385Direct]()
                list.Add(Point2385Direct(5, 6))
                Console.WriteLine(list.Count)
                Console.WriteLine(list[0].X)
            }

            main()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("1\n5\n", output);
    }

    [Fact]
    public void ListOfNullablePrimitive_AddConcreteValueAndNil_RegressionStillRuns()
    {
        // Regression control: a BUILT-IN nullable value type (Nullable<int32>)
        // is unaffected by the widened gate (it never reached
        // TrySubstituteParameterTypeFromReceiver's same-compilation-only
        // substitution path in the first place).
        const string source = """
            package i2385primitive
            import System
            import System.Collections.Generic

            func main() {
                let list = List[int32?]()
                list.Add(42)
                list.Add(nil)
                let first = list[0] ?? -1
                let second = list[1] ?? -1
                Console.WriteLine(list.Count)
                Console.WriteLine(first)
                Console.WriteLine(second)
            }

            main()
            """;

        var output = CompileAndRun(source);
        Assert.Equal("2\n42\n-1\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2385_exe_").FullName;
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
}
