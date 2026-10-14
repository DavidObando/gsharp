// <copyright file="Issue2614ImportedInheritedInstanceMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

class Issue2614ImportedInheritedInstanceMethodEmitTests {
    @Fact
    func ConcurrentQueueOfSourceType_TryDequeue_Runs() {
        const source = `import System
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
}`
        Assert.Equal("2614${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue2614_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                let exitCode = Program.Main(
                    []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
                Assert.Equal(0, exitCode)
                IlVerifier.Verify(outputPath)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
                startInfo.ArgumentList.Add(outputPath)
                using let process Process? = Process.Start(startInfo)
                let stdout = process!!.StandardOutput.ReadToEnd()
                let stderr = process!!.StandardError.ReadToEnd()
                Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(process!!.ExitCode == 0, (`exited ` + "${process!!.ExitCode}" + `
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
