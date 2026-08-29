// <copyright file="Issue3627VariadicCarrierEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0173 / issue #3627: a variadic parameter with a non-array carrier
/// (<c>...List[T]</c>, <c>...ReadOnlySpan[T]</c>, …) emits the carrier as
/// the CLR parameter type and stamps C#13's
/// <c>[ParamCollectionAttribute]</c>, so C# consumers see exactly
/// <c>params X&lt;T&gt;</c>; the array family keeps
/// <c>[ParamArrayAttribute]</c>. Runtime behavior is pinned end to end
/// (verified IL, expanded packing, pass-through).
/// </summary>
public class Issue3627VariadicCarrierEmitTests
{
    [Fact]
    public void CarrierParameters_EmitCollectionAttributeAndCarrierSignature()
    {
        var assembly = CompileToAssembly("""
            package P
            import System
            import System.Collections.Generic

            class Totals {
                shared {
                    func Span(values ...ReadOnlySpan[int32]) int32 {
                        var t = 0
                        for v in values { t = t + v }
                        return t
                    }

                    func Lst(values ...List[int32]) int32 {
                        var t = 0
                        for v in values { t = t + v }
                        return t
                    }

                    func Seq(values ...IEnumerable[string]) int32 {
                        var n = 0
                        for v in values { n = n + v.Length }
                        return n
                    }

                    func Classic(values ...int32) int32 {
                        var t = 0
                        for v in values { t = t + v }
                        return t
                    }
                }
            }
            """);

        var totals = assembly.GetTypes().Single(t => t.Name == "Totals");

        AssertParam(totals, "Span", "ReadOnlySpan`1", "ParamCollectionAttribute");
        AssertParam(totals, "Lst", "List`1", "ParamCollectionAttribute");
        AssertParam(totals, "Seq", "IEnumerable`1", "ParamCollectionAttribute");
        AssertParam(totals, "Classic", "Int32[]", "ParamArrayAttribute");

        // Runtime witness through the List carrier (spans cannot box through
        // reflection): the pack really produced a List the body could Count.
        var lst = totals.GetMethod("Lst")!;
        Assert.Equal(9, lst.Invoke(null, new object[] { new System.Collections.Generic.List<int> { 4, 5 } }));
    }

    [Fact]
    public void CarrierCalls_RunEndToEnd()
    {
        var output = CompileAndRun("""
            package P
            import System
            import System.Collections.Generic

            func totalSpan(values ...ReadOnlySpan[int32]) int32 {
                var t = 0
                for v in values { t = t + v }
                return t
            }

            func totalList(values ...List[int32]) int32 {
                var t = 0
                for v in values { t = t + v }
                return t + values.Count
            }

            func run() {
                Console.WriteLine(totalSpan(1, 2, 3))
                Console.WriteLine(totalList(4, 5))
                let existing = List[int32]()
                existing.Add(10)
                Console.WriteLine(totalList(existing))
            }

            run()
            """);

        Assert.Equal($"6{Environment.NewLine}11{Environment.NewLine}11{Environment.NewLine}", output);
    }

    private static void AssertParam(Type type, string methodName, string expectedParamTypeName, string expectedAttribute)
    {
        var parameter = type.GetMethod(methodName)!.GetParameters()[0];
        Assert.Equal(expectedParamTypeName, parameter.ParameterType.Name + (parameter.ParameterType.IsArray ? string.Empty : string.Empty));
        Assert.Contains(
            parameter.GetCustomAttributesData(),
            a => a.AttributeType.Name == expectedAttribute);
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_vcarrier_emit_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);
        RunGsc(new[] { "/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath });
        IlVerifier.Verify(outPath);
        return Assembly.Load(File.ReadAllBytes(outPath));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_vcarrier_run_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            RunGsc(new[] { "/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath });
            IlVerifier.Verify(outPath);

            var psi = new System.Diagnostics.ProcessStartInfo("dotnet")
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

            using var proc = System.Diagnostics.Process.Start(psi)!;
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(proc.ExitCode == 0, $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static void RunGsc(string[] args)
    {
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
    }
}
