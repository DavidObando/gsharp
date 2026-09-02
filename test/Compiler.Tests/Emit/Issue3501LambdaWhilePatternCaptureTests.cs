// <copyright file="Issue3501LambdaWhilePatternCaptureTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3501: a `while value is T binding { … }` inside a function literal
/// crashed emit with GS9998 ("Variable 'binding' has no local slot"). The
/// loop's bound shape places the body before the controlling condition, so
/// the lambda capture collector walked the pattern binding's reads before
/// <c>RewritePattern</c> recorded the declaration and misclassified the
/// binding as an enclosing-scope capture — the same order dependency inline
/// out-vars had (issue #1451). Pattern bindings are now pre-seeded.
/// </summary>
public class Issue3501LambdaWhilePatternCaptureTests
{
    [Fact]
    public void WhilePatternBindingInLambda_RunsCorrectly()
    {
        const string Source = """
            package Issue3501
            import System

            class Box {
                let Inner object
                init(inner object) { Inner = inner }
            }

            func Unwrap(value object) object {
                let unwrapCore = func (start object) object {
                    var current = start
                    while current is Box inner {
                        current = inner.Inner
                    }
                    return current
                }
                return unwrapCore(value)
            }

            func Main() {
                Console.WriteLine(Unwrap(Box(Box("x"))).ToString())
            }
            """;

        Assert.Equal($"x{Environment.NewLine}", CompileAndRun(Source));
    }

    [Fact]
    public void WhilePatternBindingInCapturingLambda_RunsCorrectly()
    {
        const string Source = """
            package Issue3501
            import System

            class Box {
                let Inner object
                init(inner object) { Inner = inner }
            }

            func Unwrap(value object, depthLimit int32) object {
                var limit = depthLimit
                let unwrapCore = func (start object) object {
                    var current = start
                    while current is Box inner && limit > 0 {
                        current = inner.Inner
                        limit = limit - 1
                    }
                    return current
                }
                return unwrapCore(value)
            }

            func Main() {
                Console.WriteLine(Unwrap(Box(Box("x")), 1).ToString())
            }
            """;

        // depthLimit 1 unwraps exactly one Box; the result is the inner Box,
        // whose ToString is the class name.
        Assert.Equal($"Issue3501.Box{Environment.NewLine}", CompileAndRun(Source));
    }

    private static string CompileAndRun(string source)
    {
        var outputDirectory = Path.Combine(AppContext.BaseDirectory, "issue3501lambda", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);
        try
        {
            var sourcePath = Path.Combine(outputDirectory, "Program.gs");
            var outputPath = Path.Combine(outputDirectory, "Issue3501Lambda.dll");
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
