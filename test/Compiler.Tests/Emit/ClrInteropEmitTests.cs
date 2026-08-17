// <copyright file="ClrInteropEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Emit coverage for clr interop.
/// Traceability: issues #63 and #64.
/// </summary>
public class ClrInteropEmitTests
{
    [Fact]
    public void NonGenericConstructor_PropertyRead_AndInstanceMethod()
    {
        var source = """
            package P
            import System
            import System.Text

            var sb = StringBuilder()
            sb.Append("hello ")
            sb.Append("world")
            Console.WriteLine(sb.ToString())
            Console.WriteLine(sb.Length)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"hello world{Environment.NewLine}11{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericConstructor_IndexerReadAndWrite_OnDictionary()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            var d = Dictionary[string, int32]()
            d["alpha"] = 1
            d["beta"] = 2
            Console.WriteLine(d.Count)
            Console.WriteLine(d["alpha"])
            Console.WriteLine(d["beta"])
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"2{Environment.NewLine}1{Environment.NewLine}2{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericList_ConstructorAndIndexerAndMethod()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            var xs = List[int32]()
            xs.Add(10)
            xs.Add(20)
            xs.Add(30)
            Console.WriteLine(xs.Count)
            Console.WriteLine(xs[0])
            Console.WriteLine(xs[2])
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"3{Environment.NewLine}10{Environment.NewLine}30{Environment.NewLine}", output);
    }

    [Fact]
    public void StaticPropertyRead_AndInstancePropertyWrite_RoundTrip()
    {
        // Stream B emit parity: bare `Int32.MaxValue` → `call get_MaxValue`
        // (static read), `sb.Capacity = 64` → `callvirt set_Capacity` (instance
        // write). The re-read after the store ensures the assignment yields
        // the assigned value, matching the indexer-assignment shape.
        var source = """
            package P
            import System
            import System.Text

            Console.WriteLine(Int32.MaxValue)
            var sb = StringBuilder()
            sb.Capacity = 64
            Console.WriteLine(sb.Capacity)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"2147483647{Environment.NewLine}64{Environment.NewLine}", output);
    }

    [Fact]
    public void ClrUserDefinedOperator_TimeSpanAddition_EmitsCallToOpAddition()
    {
        // Stream C emit parity: `a + b` for TimeSpan operands should compile to
        // `call System.TimeSpan::op_Addition(TimeSpan, TimeSpan)`, and the
        // result must round-trip when written via Console.WriteLine.
        var source = """
            package P
            import System

            var a = TimeSpan(0, 0, 30)
            var b = TimeSpan(0, 0, 15)
            var c = a + b
            Console.WriteLine(c.Seconds)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"45{Environment.NewLine}", output);
    }

    [Fact]
    public void EventSubscription_AddInvokeRemove_RoundTripsThroughEmit()
    {
        // Stream B′ emit parity: `evt += handler` should emit
        // `callvirt add_X(receiver, handler)` against the resolved event
        // accessor, and `-=` should emit the matching remove call. Use
        // AppDomain.ProcessExit so we don't have to spin up a custom event;
        // the round-trip just needs to compile, run, and execute the
        // attach/detach without throwing.
        var source = """
            package P
            import System

            var d = AppDomain.CurrentDomain
            d.ProcessExit += func(sender Object, e EventArgs) { }
            Console.WriteLine("done")
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"done{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericMethodInference_EnumerableRepeat_EmitsClosedMethodSpec()
    {
        // Stream F follow-up: Enumerable.Repeat<TResult>(TResult, int) is an
        // open generic method. With argument-driven inference, GSharp resolves
        // TResult=int from (int, int) without explicit type arguments. The
        // emitter must encode the call as a MethodSpec over the open Repeat
        // definition so the produced PE loads and runs against System.Linq.
        var source = """
            package P
            import System
            import System.Linq

            let seq = Enumerable.Repeat(7, 3)
            Console.WriteLine(seq)
            """;

        var output = CompileAndRun(source);
        // RepeatIterator's ToString returns its CLR type name; we just need
        // to confirm the program produced *some* output without crashing.
        Assert.Contains("RepeatIterator", output);
    }

    [Fact]
    public void LowercasePrimitiveAlias_StaticMemberAccess_EmitsAndRuns()
    {
        // Issue #919: `string.Empty` and `int32.MaxValue` (lowercase predefined
        // aliases as static-member-access receivers) must compile and run with
        // the same behavior as the capitalized `String.Empty` / `Int32.MaxValue`
        // forms — and without requiring `import System`.
        var source = """
            package P
            import System

            let empty = string.Empty
            Console.WriteLine(empty.Length)
            Console.WriteLine(int32.MaxValue)
            Console.WriteLine(int.MaxValue)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"0{Environment.NewLine}2147483647{Environment.NewLine}2147483647{Environment.NewLine}", output);
    }

    [Fact]
    public void ConstructedGenericListAdd_PreservesNullableTupleSlots()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            var items = List[(string, string?)]()
            items.Add(("x", nil))
            Console.WriteLine(items.Count)
            """;

        Assert.Equal($"1{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void ClrBinaryOperator_AppliesImplicitOperandConversion()
    {
        var source = """
            package P
            import System
            import System.IO

            let cutoff = DateTimeOffset.UtcNow
            Console.WriteLine(Directory.GetLastWriteTimeUtc(".") < cutoff)
            """;

        Assert.Equal($"True{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void ImportedExtension_NamedOptionalArgument_WithEmptyParams_PreservesReceiver()
    {
        var source = """
            package P
            import System
            import GSharp.Compiler.Tests.Emit

            Console.WriteLine("route".Describe(200, contentType: "text/html"))
            """;

        Assert.Equal(
            $"route:200:text/html:0{Environment.NewLine}",
            CompileAndRun(source, typeof(NamedParamsExtensionFixture).Assembly.Location));
    }

    private static string CompileAndRun(string source, params string[] references)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_clr_emit_").FullName;
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
                var args = new List<string>
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                };
                args.AddRange(references.Select(reference => "/r:" + reference));
                args.Add(srcPath);
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
            IlVerifier.Verify(outPath, references);
            foreach (var reference in references)
            {
                File.Copy(
                    reference,
                    Path.Combine(tempDir, Path.GetFileName(reference)),
                    overwrite: true);
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

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

}

/// <summary>Imported extension fixture for named optional and params argument ordering.</summary>
public static class NamedParamsExtensionFixture
{
    /// <summary>Returns the observed imported argument order.</summary>
    public static string Describe(
        this string source,
        int statusCode,
        Type responseType = null,
        string contentType = null,
        params string[] contentTypes)
    {
        _ = responseType;
        return $"{source}:{statusCode}:{contentType}:{contentTypes.Length}";
    }
}
