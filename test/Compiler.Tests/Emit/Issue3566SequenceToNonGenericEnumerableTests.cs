// <copyright file="Issue3566SequenceToNonGenericEnumerableTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3566 (emit side): the <c>sequence[T]</c> → non-generic
/// <c>System.Collections.IEnumerable</c> upcast the binder's semantic arm
/// admits must emit as a no-op reference conversion. Without the matching
/// <c>IsReferenceCompatible</c> arm the emitter threw NotSupportedException
/// (GS9998) for exactly the conversions the classifier had just accepted.
/// </summary>
public class Issue3566SequenceToNonGenericEnumerableTests
{
    [Fact]
    public void SequenceUpcastToIEnumerable_EmitsAndRuns()
    {
        const string Source = """
            package Issue3566
            import System
            import System.Collections
            import System.Linq

            func Flatten(xs sequence[string]) IEnumerable {
                return xs
            }

            func Main() {
                let seq = []string{"a", "b", "c"}.AsEnumerable()
                var count = 0
                for item in Flatten(seq) {
                    count = count + 1
                }
                Console.WriteLine(count.ToString())
            }
            """;

        Assert.Equal($"3{Environment.NewLine}", CompileAndRun(Source));
    }

    [Fact]
    public void OfTypeOnSequenceReceiver_EmitsAndRuns()
    {
        const string Source = """
            package Issue3566
            import System
            import System.Linq

            func CountStrings(xs sequence[object]) int32 {
                return xs.OfType[string]().Count()
            }

            func Main() {
                let items = []object{"a", 1, "b"}.AsEnumerable()
                Console.WriteLine(CountStrings(items).ToString())
            }
            """;

        Assert.Equal($"2{Environment.NewLine}", CompileAndRun(Source));
    }

    private static string CompileAndRun(string source)
    {
        var outputDirectory = Path.Combine(AppContext.BaseDirectory, "issue3566", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);
        try
        {
            var sourcePath = Path.Combine(outputDirectory, "Program.gs");
            var outputPath = Path.Combine(outputDirectory, "Issue3566.dll");
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
