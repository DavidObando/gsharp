// <copyright file="Issue2807AnonymousFunctionParameterAttributeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #2807: anonymous functions preserve parameter attributes in emitted metadata.</summary>
public class Issue2807AnonymousFunctionParameterAttributeEmitTests
{
    [Fact]
    public void AnonymousFunctionParameters_PreserveAttributes()
    {
        var source = """
            package P

            import System

            class MarkerAttribute : Attribute {
            }

            func attributeCount(handler Func[int32, int32]) int32 {
                return handler.Method.GetParameters()[0].GetCustomAttributes(false).Length
            }

            func stringAttributeCount(handler Func[string, string?]) int32 {
                return handler.Method.GetParameters()[0].GetCustomAttributes(false).Length
            }

            let functionLiteral Func[int32, int32] = func(@Marker value int32) int32 {
                return value + 1
            }
            let arrowLambda Func[int32, int32] = (@Marker value int32) -> value + 1
            let widenedAdapter Func[string, string?] = func(@Marker value string) string {
                return value
            }

            Console.WriteLine(attributeCount(functionLiteral))
            Console.WriteLine(attributeCount(arrowLambda))
            Console.WriteLine(stringAttributeCount(widenedAdapter))
            """;

        Assert.Equal($"1{Environment.NewLine}1{Environment.NewLine}1{Environment.NewLine}", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2807_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var previousOut = Console.Out;
            var previousErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

            var processInfo = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            processInfo.ArgumentList.Add("exec");
            processInfo.ArgumentList.Add("--runtimeconfig");
            processInfo.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            processInfo.ArgumentList.Add(outPath);

            using var process = Process.Start(processInfo);
            var stdout = process!.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

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
}
