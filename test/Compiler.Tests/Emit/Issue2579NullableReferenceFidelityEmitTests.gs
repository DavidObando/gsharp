// <copyright file="Issue2579NullableReferenceFidelityEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

class Issue2579NullableReferenceFidelityEmitTests {
    @Fact
    func GuardedNullableReferences_ExecuteAcrossMemberArgumentIndexAndForeachBoundaries() {
        let output = CompileAndRun(`package Issue2579
import System
import System.Collections.Generic

func Length(value string) int32 -> value.Length

// A call may assign a top-level variable (ADR-0208 R11), so the guarded variables are locals.
func Run() int32 {
    var value string? = "key"
    var list = List[string]()
    list.Add("a")
    list.Add("b")
    var values IEnumerable[string]? = list
    var dict = Dictionary[string, int32]()
    var total = 0

    if value != nil {
        var assigned string = value
        total += Length(value)
        dict[value] = assigned.Length
    }

    if !String.IsNullOrEmpty(value) {
        total += Length(value)
    }

    if values != nil {
        for item in values {
            total += item.Length
        }
    }

    total += Length(value!!)
    return total
}

Console.WriteLine(Run())`)
        Assert.Equal("11${Environment.NewLine}", output)
    }

    shared {
        private func CompileAndRun(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue2579_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                let args = List[string]{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0"}
                for reference in TrustedPlatformAssemblies() {
                    args.Add("/reference:" + reference)
                }
                args.Add("/nowarn:GS9100")
                args.Add(sourcePath)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let previousOut = Console.Out
                let previousErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
` + "$compileOut" + `
` + "$compileErr"))
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
                using let process = Process.Start(startInfo) ??
                    throw InvalidOperationException("Failed to start emitted program.")
                let stdout = process.StandardOutput.ReadToEnd()
                let stderr = process.StandardError.ReadToEnd()
                Assert.True(process.WaitForExit(30_000), "Emitted program timed out.")
                Assert.True(process.ExitCode == 0, stderr)
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }

        private func TrustedPlatformAssemblies() sequence[string] {
            let assemblies string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(assemblies) {
                yield break
            }
            for path in assemblies.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }
    }
}
