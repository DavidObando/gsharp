// <copyright file="DotnetProcess.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import System.Threading.Tasks

internal shared class DotnetProcess {
    private let DefaultTimeout TimeSpan = TimeSpan.FromSeconds(30)
    private let CleanupTimeout TimeSpan = TimeSpan.FromSeconds(5)
    func Run(workingDirectory string, arguments ...string) DotnetProcessResult -> RunAsync(workingDirectory, arguments)
        .GetAwaiter().GetResult()

    async func RunAsync(
        workingDirectory string,
        arguments IEnumerable[string],
        timeout TimeSpan? = nil
    ) DotnetProcessResult {
        let argumentList = arguments.ToArray()
        let startInfo = ProcessStartInfo("dotnet"){
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDirectory
        }
        for argument in argumentList {
            startInfo.ArgumentList.Add(argument)
        }
        using let process = Process.Start(startInfo) ?? throw InvalidOperationException("Failed to start dotnet.")
        let standardOutput = StringBuilder()
        let standardError = StringBuilder()
        let outputPump = PumpAsync(process.StandardOutput, standardOutput)
        let errorPump = PumpAsync(process.StandardError, standardError)
        try {
            try {
                await process.WaitForExitAsync().WaitAsync(timeout ?? DefaultTimeout)
            } catch (TimeoutException) {
                await TerminateAsync(process)
                await StopPumpsAsync(process, outputPump, errorPump)
                throw TimeoutException(
                    FormatFailure(process, argumentList, workingDirectory, "timed out", standardOutput, standardError)
                )
            }
            try {
                await Task.WhenAll(outputPump, errorPump).WaitAsync(CleanupTimeout)
            } catch (TimeoutException) {
                await StopPumpsAsync(process, outputPump, errorPump)
                throw TimeoutException(
                    FormatFailure(
                        process,
                        argumentList,
                        workingDirectory,
                        "exited but output streams did not close",
                        standardOutput,
                        standardError
                    )
                )
            }
            return DotnetProcessResult(process.ExitCode, Snapshot(standardOutput), Snapshot(standardError))
        } finally {
            if !process.HasExited {
                await TerminateAsync(process)
            }
        }
    }

    private async func PumpAsync(reader StreamReader, output StringBuilder) {
        let buffer = [4096]char
        try {
            while await reader.ReadAsync(buffer.AsMemory()) is var count && count > 0 {
                lock output {
                    output.Append(buffer, 0, count)
                }
            }
        } catch (ex Exception) when ex is IOException || ex is ObjectDisposedException { }
    }

    private async func StopPumpsAsync(process Process, outputPump Task, errorPump Task) {
        process.StandardOutput.Dispose()
        process.StandardError.Dispose()
        try {
            await Task.WhenAll(outputPump, errorPump).WaitAsync(CleanupTimeout)
        } catch (TimeoutException) { }
    }

    private async func TerminateAsync(process Process) {
        try {
            if !process.HasExited {
                process.Kill(entireProcessTree: true)
            }
        } catch (InvalidOperationException) when process.HasExited { }
        try {
            await process.WaitForExitAsync().WaitAsync(CleanupTimeout)
        } catch (TimeoutException) { }
    }

    private func FormatFailure(
        process Process,
        arguments IReadOnlyList[string],
        workingDirectory string,
        reason string,
        standardOutput StringBuilder,
        standardError StringBuilder
    ) string -> "dotnet process $reason; pid=${process.Id}; cwd=$workingDirectory; args=${string.Join(" ", arguments)}" +
        (`
stdout:
` + "${Snapshot(standardOutput)}" + `
stderr:
` + "${Snapshot(standardError)}")

    private func Snapshot(output StringBuilder) string {
        lock output {
            return output.ToString()
        }
    }
}

internal data class DotnetProcessResult(ExitCode int32, StandardOutput string, StandardError string) : IEquatable[
    DotnetProcessResult
] {
    prop Combined string -> StandardOutput + StandardError
}
