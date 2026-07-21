// <copyright file="Issue2614ImportedInheritedInstanceMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue2614ImportedInheritedInstanceMethodEmitTests
{
    [Fact]
    public void ConcurrentQueueOfSourceType_TryDequeue_Runs()
    {
        const string source = """
            import System
            import System.Collections.Concurrent

            class ModalRequest {
                var Value int32 = 0
            }

            var queued = ModalRequest()
            queued.Value = 2614
            var queue = ConcurrentQueue[ModalRequest]()
            queue.Enqueue(queued)
            var request ModalRequest? = nil
            if queue.TryDequeue(&request) {
                Console.WriteLine(request!!.Value)
            }
            """;

        Assert.Equal("2614\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2614_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            var exitCode = Program.Main(new[]
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
            Assert.Equal(0, exitCode);
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
            var stdout = process.StandardOutput.ReadToEnd();
            var stderr = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}\n{stderr}");
            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
