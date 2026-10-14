// <copyright file="Issue3085PrimitiveStaticParseEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3085: canonical primitive type receivers bind imported CLR static
/// methods, and an already-invalid argument does not add a misleading call
/// resolution diagnostic.
open class Issue3085PrimitiveStaticParseEmitTests {
    @Fact
    func Int32Parse_CanonicalReceiver_CompilesAndRuns() {
        const source = `package Issue3085
import System

Console.WriteLine(int32.Parse("314159"))`
        let compilation = Compile(source, executable: true)
        try {
            Assert.True(compilation.ExitCode == 0, compilation.Output)
            IlVerifier.Verify(compilation.AssemblyPath)
            Assert.Equal("314159${Environment.NewLine}", Run(compilation.AssemblyPath, compilation.WorkDirectory))
        } finally {
            DeleteDirectory(compilation.WorkDirectory)
        }
    }

    @Fact
    func InvalidStaticCallArgument_DoesNotCascadeCannotFindFunction() {
        const source = `package Issue3085

class Host {
    shared {
        func Run() int32 {
            return int32.Parse(Host.Missing)
        }
    }
}`
        let compilation = Compile(source, executable: false)
        try {
            Assert.NotEqual(0, compilation.ExitCode)
            Assert.Contains("GS0158", compilation.Output, StringComparison.Ordinal)
            Assert.DoesNotContain("Cannot find function Parse", compilation.Output, StringComparison.Ordinal)
        } finally {
            DeleteDirectory(compilation.WorkDirectory)
        }
    }

    shared {
        private func Compile(source string, executable bool)(
            WorkDirectory string,
            AssemblyPath string,
            ExitCode int32,
            Output string
        ) {
            let workDirectory = Path.Combine(AppContext.BaseDirectory, "issue3085", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDirectory)
            let sourcePath = Path.Combine(workDirectory, "test.gs")
            let assemblyPath = Path.Combine(workDirectory, "test.dll")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{
                        "/out:" + assemblyPath,
                        if executable {
                            "/target:exe"
                        } else {
                            "/target:library"
                        },
                        "/targetframework:net10.0",
                        sourcePath
                    }
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return (workDirectory, assemblyPath, exitCode, stdout.ToString() + stderr.ToString())
        }

        private func Run(assemblyPath string, workDirectory string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workDirectory
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start compiled program.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "Compiled program timed out.")
            Assert.True(process.ExitCode == 0, (`Program exited ` + "${process.ExitCode}" + `:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        private func DeleteDirectory(path string) {
            try {
                Directory.Delete(path, recursive: true)
            } catch { }
        }
    }
}
