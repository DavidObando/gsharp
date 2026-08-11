// <copyright file="DotnetProcess.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace GSharp.Interpreter.Tests;

internal static class DotnetProcess
{
    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan CleanupTimeout = TimeSpan.FromSeconds(5);

    public static DotnetProcessResult Run(string workingDirectory, params string[] arguments)
        => RunAsync(workingDirectory, arguments).GetAwaiter().GetResult();

    public static async Task<DotnetProcessResult> RunAsync(
        string workingDirectory,
        IEnumerable<string> arguments,
        TimeSpan? timeout = null)
    {
        var argumentList = arguments.ToArray();
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDirectory,
        };
        foreach (var argument in argumentList)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start dotnet.");
        var standardOutput = new StringBuilder();
        var standardError = new StringBuilder();
        var outputPump = PumpAsync(process.StandardOutput, standardOutput);
        var errorPump = PumpAsync(process.StandardError, standardError);

        try
        {
            try
            {
                await process.WaitForExitAsync().WaitAsync(timeout ?? DefaultTimeout);
            }
            catch (TimeoutException)
            {
                await TerminateAsync(process);
                await StopPumpsAsync(process, outputPump, errorPump);
                throw new TimeoutException(FormatFailure(
                    process,
                    argumentList,
                    workingDirectory,
                    "timed out",
                    standardOutput,
                    standardError));
            }

            try
            {
                await Task.WhenAll(outputPump, errorPump).WaitAsync(CleanupTimeout);
            }
            catch (TimeoutException)
            {
                await StopPumpsAsync(process, outputPump, errorPump);
                throw new TimeoutException(FormatFailure(
                    process,
                    argumentList,
                    workingDirectory,
                    "exited but output streams did not close",
                    standardOutput,
                    standardError));
            }

            return new DotnetProcessResult(
                process.ExitCode,
                Snapshot(standardOutput),
                Snapshot(standardError));
        }
        finally
        {
            if (!process.HasExited)
            {
                await TerminateAsync(process);
            }
        }
    }

    private static async Task PumpAsync(StreamReader reader, StringBuilder output)
    {
        var buffer = new char[4096];
        try
        {
            while (await reader.ReadAsync(buffer.AsMemory()) is var count && count > 0)
            {
                lock (output)
                {
                    output.Append(buffer, 0, count);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
        }
    }

    private static async Task StopPumpsAsync(Process process, Task outputPump, Task errorPump)
    {
        process.StandardOutput.Dispose();
        process.StandardError.Dispose();
        try
        {
            await Task.WhenAll(outputPump, errorPump).WaitAsync(CleanupTimeout);
        }
        catch (TimeoutException)
        {
        }
    }

    private static async Task TerminateAsync(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (InvalidOperationException) when (process.HasExited)
        {
        }

        try
        {
            await process.WaitForExitAsync().WaitAsync(CleanupTimeout);
        }
        catch (TimeoutException)
        {
        }
    }

    private static string FormatFailure(
        Process process,
        IReadOnlyList<string> arguments,
        string workingDirectory,
        string reason,
        StringBuilder standardOutput,
        StringBuilder standardError)
        => $"dotnet process {reason}; pid={process.Id}; cwd={workingDirectory}; args={string.Join(" ", arguments)}"
            + $"\nstdout:\n{Snapshot(standardOutput)}\nstderr:\n{Snapshot(standardError)}";

    private static string Snapshot(StringBuilder output)
    {
        lock (output)
        {
            return output.ToString();
        }
    }
}

internal sealed record DotnetProcessResult(int ExitCode, string StandardOutput, string StandardError)
{
    public string Combined => StandardOutput + StandardError;
}
