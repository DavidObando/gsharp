// <copyright file="Issue3501SpanForeachTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3501: `for x in span` over a <c>Span[T]</c> / <c>ReadOnlySpan[T]</c>.
/// The span enumerator's <c>Current</c> returns <c>ref T</c>, so the element
/// read must auto-dereference (ADR-0056 §1) — both in the binder (loop
/// variable types as <c>T</c>, not <c>T@</c>) and in the lowered IL
/// (<c>ldind</c> after <c>get_Current</c>). The enumerator is also byref-like:
/// on runtimes where ref structs implement <c>IDisposable</c> the disposal
/// wrap must be skipped because interface dispatch would box.
/// </summary>
public class Issue3501SpanForeachTests
{
    [Fact]
    public void SpanForeach_ElementValuesAndSlice_RunCorrectly()
    {
        const string Source = """
            package Issue3501
            import System

            func Main() {
                var arr = []uint8{1, 2, 3, 42, 5}
                let span = arr.AsSpan()
                var sum = 0
                var hits = 0
                for b in span {
                    if b != 42 {
                        sum = sum + int32(b)
                    } else {
                        hits = hits + 1
                    }
                }
                let tail = span.Slice(1)
                var tsum = 0
                for b in tail {
                    tsum = tsum + int32(b)
                }
                Console.WriteLine(sum.ToString() + " " + hits.ToString() + " " + tsum.ToString())
            }
            """;

        Assert.Equal($"11 1 52{Environment.NewLine}", CompileAndRun(Source));
    }

    [Fact]
    public void ReadOnlySpanForeach_SumsElements()
    {
        const string Source = """
            package Issue3501
            import System

            func Total(data System.ReadOnlySpan[int32]) int32 {
                var total = 0
                for value in data {
                    total = total + value
                }
                return total
            }

            func Main() {
                var arr = []int32{10, 20, 12}
                Console.WriteLine(Total(arr.AsSpan()).ToString())
            }
            """;

        Assert.Equal($"42{Environment.NewLine}", CompileAndRun(Source));
    }

    private static string CompileAndRun(string source)
    {
        var outputDirectory = Path.Combine(AppContext.BaseDirectory, "issue3501", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);
        try
        {
            var sourcePath = Path.Combine(outputDirectory, "Program.gs");
            var outputPath = Path.Combine(outputDirectory, "Issue3501.dll");
            File.WriteAllText(sourcePath, source);

            using var standardOut = new StringWriter();
            using var standardError = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(standardOut);
            Console.SetError(standardError);
            int exitCode;
            try
            {
                exitCode = Program.Main(new[]
                {
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.True(
                exitCode == 0,
                $"gsc failed:\nstdout:\n{standardOut}\nstderr:\n{standardError}");
            IlVerifier.Verify(outputPath);
            var assembly = EmittedFixture.Load(outputPath);
            _ = assembly.GetTypes();
            var entryPoint = assembly.EntryPoint
                ?? throw new InvalidOperationException("Emitted assembly has no entry point.");

            previousOut = Console.Out;
            using var output = new StringWriter();
            Console.SetOut(output);
            try
            {
                entryPoint.Invoke(
                    null,
                    entryPoint.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(previousOut);
            }

            return output.ToString();
        }
        finally
        {
            try
            {
                Directory.Delete(outputDirectory, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
