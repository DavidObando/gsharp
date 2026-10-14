// <copyright file="DotnetProcessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Compiler
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Threading.Tasks
import Xunit

class DotnetProcessTests {
    @Fact
    async func Timeout_KillsProcessTreeAndReportsCommandContext() {
        let directory = Path.Combine(AppContext.BaseDirectory, "DotnetProcessTests", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let childSourcePath = Path.Combine(directory, "child.gs")
            let childAssemblyPath = Path.Combine(directory, "child.dll")
            File.WriteAllText(childSourcePath, "for {\n}")
            Assert.Equal(
                0,
                GSharp
                    .Compiler
                    .Program
                    .Main(
                    []string{"/out:" + childAssemblyPath, "/target:exe", "/targetframework:net10.0", childSourcePath}
                )
            )
            let parentSourcePath = Path.Combine(directory, "parent.gs")
            let parentAssemblyPath = Path.Combine(directory, "parent.dll")
            File.WriteAllText(parentSourcePath, `import System
import System.Diagnostics

let startInfo = ProcessStartInfo("dotnet")
startInfo.UseShellExecute = false
startInfo.ArgumentList.Add("child.dll")
let child Process = Process.Start(startInfo) ?? throw InvalidOperationException("child failed")
Console.WriteLine(child.Id)
for {
}`)
            Assert.Equal(
                0,
                GSharp
                    .Compiler
                    .Program
                    .Main(
                    []string{"/out:" + parentAssemblyPath, "/target:exe", "/targetframework:net10.0", parentSourcePath}
                )
            )
            let error = await Assert.ThrowsAsync[TimeoutException](
                func () Task {
                    return DotnetProcess.RunAsync(directory, []string{parentAssemblyPath}, TimeSpan.FromSeconds(2))
                }
            )
            Assert.Contains("timed out; pid=", error.Message, StringComparison.Ordinal)
            Assert.Contains("cwd=" + directory, error.Message, StringComparison.Ordinal)
            Assert.Contains("args=" + parentAssemblyPath, error.Message, StringComparison.Ordinal)
            Assert.Contains("stdout:", error.Message, StringComparison.Ordinal)
            Assert.Contains("stderr:", error.Message, StringComparison.Ordinal)
            let childPid = int32.Parse(
                error
                    .Message
                    .Split("stdout:\n", StringSplitOptions.None)[1]
                    .Split('\n', StringSplitOptions.RemoveEmptyEntries)
                    .First()
            )
            await AssertProcessExitedAsync(childPid)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private async func AssertProcessExitedAsync(processId int32) {
            for var i = 0; i < 50; i++ {
                try {
                    using let process = Process.GetProcessById(processId)
                    if process.HasExited {
                        return
                    }
                } catch (ArgumentException) {
                    return
                }
                await Task.Delay(100)
            }
            Assert.Fail("Child process $processId was not terminated.")
        }
    }
}
