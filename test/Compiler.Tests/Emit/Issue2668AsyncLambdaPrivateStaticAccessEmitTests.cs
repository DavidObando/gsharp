// <copyright file="Issue2668AsyncLambdaPrivateStaticAccessEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #2668: async lambdas nested in a user type must retain access to its private static methods.</summary>
public class Issue2668AsyncLambdaPrivateStaticAccessEmitTests
{
    [Fact]
    public void ExactCliServerLambdaFingerprints_AreNestedVerifyAndRun()
    {
        var source = """
            package Oahu.Cli.Server
            import System
            import System.Threading.Tasks

            class HttpEndpoints {
                shared {
                    private func Args(value int32) Task[int32] -> Task.FromResult(value + 1)

                    private async func WriteSseAsync(value int32) int32 {
                        await Task.Yield()
                        return value + 1
                    }

                    func Run() int32 {
                        let f1 = () -> 1
                        let f2 = () -> 2
                        let f3 = () -> 3
                        let f4 = () -> 4
                        let f5 = () -> 5
                        let f6 = () -> 6
                        let f7 = () -> 7
                        let f8 = () -> 8
                        let f9 = () -> 9
                        let f10 = () -> 10
                        let f11 = () -> 11
                        let f12 = () -> 12
                        let f13 = () -> 13
                        let f14 = () -> 14
                        let f15 = () -> 15
                        let f16 = async () -> await HttpEndpoints.Args(15)
                        let f17 = () -> 17
                        let f18 = () -> 18
                        let f19 = () -> 19
                        let f20 = () -> 20
                        let f21 = () -> 21
                        let f22 = async () -> await HttpEndpoints.Args(21)
                        let f23 = () -> 23
                        let f24 = () -> 24
                        let f25 = () -> 25
                        let f26 = () -> 26
                        let f27 = () -> 27
                        let f28 = () -> 28
                        let f29 = () -> 29
                        let f30 = async () -> await HttpEndpoints.WriteSseAsync(29)
                        return f16().Result + f22().Result + f30().Result
                    }
                }
            }

            Console.WriteLine(HttpEndpoints.Run())
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_issue2668_").FullName;
        try
        {
            var sourcePath = Path.Combine(tempDir, "HttpEndpoints.gs");
            var outputPath = Path.Combine(tempDir, "Oahu.Cli.Server.dll");
            File.WriteAllText(sourcePath, source);

            Assert.Equal(0, Compile(sourcePath, outputPath));
            IlVerifier.Verify(outputPath);

            var assembly = Assembly.Load(File.ReadAllBytes(outputPath));
            var httpEndpoints = assembly.GetType("Oahu.Cli.Server.HttpEndpoints", throwOnError: true)!;
            var nestedNames = httpEndpoints.GetNestedTypes(BindingFlags.NonPublic)
                .Select(type => type.Name)
                .ToArray();

            var exactFingerprints = new[]
            {
                (Lambda: "<lambda16>", Sha256: "d1576a415ead4daa965d6225e3c9b158f13c99ceaf01d5025aaeee7d2cd8ce19"),
                (Lambda: "<lambda22>", Sha256: "c040e4a307620db64054bdd544e384e7b1d03ebf64b845c345049bee56852bdd"),
                (Lambda: "<lambda30>", Sha256: "00e7a319e5dace6c0f40766c2c72f2045dd4e8f5bfc8c3f7c7045a2437c38aaa"),
            };
            foreach (var fingerprint in exactFingerprints)
            {
                Assert.True(
                    nestedNames.Any(name => name.Contains(fingerprint.Lambda, StringComparison.Ordinal)),
                    $"missing nested host for {fingerprint.Lambda} ({fingerprint.Sha256})");
                Assert.DoesNotContain(
                    assembly.GetTypes(),
                    type => type.FullName == $"Oahu.Cli.Server.<Program>+<{fingerprint.Lambda}>d__0");
            }

            var args = httpEndpoints.GetMethod("Args", BindingFlags.NonPublic | BindingFlags.Static)!;
            var writeSseAsync = httpEndpoints.GetMethod("WriteSseAsync", BindingFlags.NonPublic | BindingFlags.Static)!;
            Assert.True(args.IsPrivate);
            Assert.True(writeSseAsync.IsPrivate);

            Assert.Equal("68\n", Run(outputPath, tempDir));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static int Compile(string sourcePath, string outputPath)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(new[]
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
            Assert.True(exitCode == 0, $"gsc failed:\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return exitCode;
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string Run(string outputPath, string workingDirectory)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDirectory,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(outputPath);

        using var process = Process.Start(startInfo)!;
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.Replace("\r\n", "\n");
    }
}
