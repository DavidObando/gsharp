// <copyright file="Issue3838SourceOpenGenericDelegateTypeOfEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3838 end-to-end: <c>typeof(Mapper[_])</c> over a NAMED GENERIC
/// DELEGATE declared in the compilation being built must bind and emit an
/// <c>ldtoken</c> that loads.
/// <para>
/// Two independent halves, both required. The binder's declared-type fallback
/// for the explicit-arity unbound-generic spelling (#3678/#3677) only
/// recognised <c>StructSymbol</c> and <c>InterfaceSymbol</c> definitions, so a
/// source generic delegate reported GS0113 carrying the arity-mangled metadata
/// name the caller never wrote. Fixing only that half compiles and then dies at
/// run time with <see cref="BadImageFormatException"/>, because the emitter's
/// open-generic-definition <c>ldtoken</c> arm had the same missing case and
/// fell back to the generic-REFERENCE TypeSpec (<c>Mapper&lt;!0&gt;</c>), whose
/// VAR slot has no binding in that scope. That is why this test EXECUTES the
/// emitted assembly rather than asserting on binding alone.
/// </para>
/// </summary>
public class Issue3838SourceOpenGenericDelegateTypeOfEmitTests
{
    [Fact]
    public void SourceOpenGenericDelegateTypeOf_VerifiesAndRuns()
    {
        const string Source = """
            package Demo
            import System

            delegate Mapper[T](value T) int32;
            delegate Pair[A, B](a A, b B) string;
            delegate Plain(value int32) int32;

            Console.WriteLine(typeof(Mapper[_]).FullName)
            Console.WriteLine(typeof(Mapper[_]).IsGenericTypeDefinition)
            Console.WriteLine(typeof(Pair[_, _]).FullName)
            Console.WriteLine(typeof(Mapper[_]).MakeGenericType(typeof(string)).GetGenericArguments()[0].FullName)

            // Anti-vacuity: these spellings already worked before #3838 and must
            // keep working — the fix must not disturb the bound or non-generic
            // delegate paths.
            Console.WriteLine(typeof(Plain).FullName)
            Console.WriteLine(typeof(Mapper[int32]).IsGenericTypeDefinition)
            """;

        var expected = string.Join(
            Environment.NewLine,
            "Demo.Mapper`1",
            "True",
            "Demo.Pair`2",
            "System.String",
            "Demo.Plain",
            "False") + Environment.NewLine;

        Assert.Equal(expected, CompileVerifyAndRun(Source));
    }

    private static string CompileVerifyAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue3838_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(stdout);
            Console.SetError(stderr);
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

            Assert.True(exitCode == 0, $"gsc failed:\n{stdout}\n{stderr}");
            IlVerifier.Verify(outputPath);

            var startInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory,
            };
            startInfo.ArgumentList.Add("exec");
            startInfo.ArgumentList.Add("--runtimeconfig");
            startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"));
            startInfo.ArgumentList.Add(outputPath);

            using var process = Process.Start(startInfo);
            var runtimeOutput = process!.StandardOutput.ReadToEnd();
            var runtimeError = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, $"runtime failed:\n{runtimeOutput}\n{runtimeError}");
            return runtimeOutput.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
