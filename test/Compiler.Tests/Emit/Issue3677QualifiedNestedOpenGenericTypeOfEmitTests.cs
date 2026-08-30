// <copyright file="Issue3677QualifiedNestedOpenGenericTypeOfEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3677 end-to-end: the qualified (<c>typeof(A.B[_, _])</c>) and nested
/// (<c>typeof(Outer[_].Inner[_])</c>) open-generic spellings over types declared
/// in the compilation being built must bind AND emit an <c>ldtoken</c> that
/// loads. #3678 showed the two halves are independent: an open user generic
/// definition emitted through the generic-REFERENCE TypeSpec path encodes
/// <c>Name&lt;!0&gt;</c>, whose VAR slot has no binding in that scope, so the PE
/// compiles and then dies with <c>BadImageFormatException</c> the moment the
/// <c>typeof</c> runs. This test verifies the IL mechanically and then EXECUTES
/// the emitted assembly, asserting the <see cref="Type"/> each spelling yields
/// is the expected open generic definition.
/// </summary>
public class Issue3677QualifiedNestedOpenGenericTypeOfEmitTests
{
    [Fact]
    public void QualifiedAndNestedSourceOpenGenericTypeOf_VerifiesAndRuns()
    {
        const string Source = """
            package Demo
            import System

            class Fixtures {
                interface IQuery[T] {}
                interface IChain[A, B, C, D] {}
            }

            class Outer[T] {
                class Inner[U] {}
                class PlainInner {}
            }

            Console.WriteLine(typeof(Fixtures.IQuery[_]).FullName)
            Console.WriteLine(typeof(Fixtures.IQuery[_]).IsGenericTypeDefinition)
            Console.WriteLine(typeof(Fixtures.IChain[_, _, _, _]).FullName)
            Console.WriteLine(typeof(Demo.Fixtures.IChain[_, _, _, _]).FullName)
            Console.WriteLine(typeof(Fixtures.IQuery[_]).MakeGenericType(typeof(int32)).GetGenericArguments()[0].FullName)
            Console.WriteLine(typeof(Outer[_].Inner[_]).FullName)
            Console.WriteLine(typeof(Outer[_].Inner[_]).GetGenericArguments().Length)
            Console.WriteLine(typeof(Outer[_].PlainInner).FullName)
            Console.WriteLine(typeof(Outer[_].PlainInner).IsGenericTypeDefinition)
            Console.WriteLine(typeof(Fixtures3677.IPackaged[_]).FullName)
            Console.WriteLine(typeof(Fixtures3677.PackagedOuter[_].Inner[_]).FullName)
            """;

        // The shape migrated code actually has: in C# the qualifier is a
        // NAMESPACE, spelled relative to the referencing one.
        const string PackagedSource = """
            package Demo.Fixtures3677

            interface IPackaged[T] {}

            class PackagedOuter[T] {
                class Inner[U] {}
            }
            """;

        var expected = string.Join(
            Environment.NewLine,
            "Demo.Fixtures+IQuery`1",
            "True",
            "Demo.Fixtures+IChain`4",
            "Demo.Fixtures+IChain`4",
            "System.Int32",
            "Demo.Outer`1+Inner`1",
            "2",
            "Demo.Outer`1+PlainInner",
            "True",
            "Demo.Fixtures3677.IPackaged`1",
            "Demo.Fixtures3677.PackagedOuter`1+Inner`1") + Environment.NewLine;

        Assert.Equal(expected, CompileVerifyAndRun(Source, PackagedSource));
    }

    private static string CompileVerifyAndRun(string source, string packagedSource)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue3677_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var packagedPath = Path.Combine(directory, "fixtures.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);
            File.WriteAllText(packagedPath, packagedSource);

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
                    packagedPath,
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
