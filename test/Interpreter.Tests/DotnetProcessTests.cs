// <copyright file="DotnetProcessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Xunit;

namespace GSharp.Interpreter.Tests;

public sealed class DotnetProcessTests
{
    [Fact]
    public async Task Timeout_KillsProcessTreeAndReportsCommandContext()
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(DotnetProcessTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var childSourcePath = Path.Combine(directory, "child.gs");
            var childAssemblyPath = Path.Combine(directory, "child.dll");
            File.WriteAllText(childSourcePath, "for {\n}");
            Assert.Equal(
                0,
                GSharp.Compiler.Program.Main(
                    ["/out:" + childAssemblyPath, "/target:exe", "/targetframework:net10.0", childSourcePath]));

            var parentSourcePath = Path.Combine(directory, "parent.gs");
            var parentAssemblyPath = Path.Combine(directory, "parent.dll");
            File.WriteAllText(
                parentSourcePath,
                """
                import System
                import System.Diagnostics

                let startInfo = ProcessStartInfo("dotnet")
                startInfo.UseShellExecute = false
                startInfo.ArgumentList.Add("child.dll")
                let child Process = Process.Start(startInfo) ?? throw InvalidOperationException("child failed")
                Console.WriteLine(child.Id)
                for {
                }
                """);
            Assert.Equal(
                0,
                GSharp.Compiler.Program.Main(
                    ["/out:" + parentAssemblyPath, "/target:exe", "/targetframework:net10.0", parentSourcePath]));

            var error = await Assert.ThrowsAsync<TimeoutException>(
                () => DotnetProcess.RunAsync(
                    directory,
                    [parentAssemblyPath],
                    TimeSpan.FromSeconds(2)));

            Assert.Contains("timed out; pid=", error.Message, StringComparison.Ordinal);
            Assert.Contains("cwd=" + directory, error.Message, StringComparison.Ordinal);
            Assert.Contains("args=" + parentAssemblyPath, error.Message, StringComparison.Ordinal);
            Assert.Contains("stdout:", error.Message, StringComparison.Ordinal);
            Assert.Contains("stderr:", error.Message, StringComparison.Ordinal);

            var childPid = int.Parse(error.Message
                .Split("stdout:\n", StringSplitOptions.None)[1]
                .Split('\n', StringSplitOptions.RemoveEmptyEntries)
                .First());
            await AssertProcessExitedAsync(childPid);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static async Task AssertProcessExitedAsync(int processId)
    {
        for (var i = 0; i < 50; i++)
        {
            try
            {
                using var process = Process.GetProcessById(processId);
                if (process.HasExited)
                {
                    return;
                }
            }
            catch (ArgumentException)
            {
                return;
            }

            await Task.Delay(100);
        }

        Assert.Fail($"Child process {processId} was not terminated.");
    }
}
