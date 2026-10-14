// <copyright file="NoAutoImportTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Extensions.Tests

import GSharp.Compiler
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Per ADR-0084: nothing under `Gsharp.Extensions.*` is auto-imported,
/// even with the implicit-imports compiler option enabled. This fixture
/// drives `gsc.dll` end-to-end and asserts the diagnostic on the
/// no-import path, then the success path with the explicit import added.
open class NoAutoImportTests {
    @Fact
    func FirstOrNil_WithoutImport_FailsBinding() {
        let (exit, stdout, stderr) = CompileSnippet(SnippetWithoutImport)
        Assert.NotEqual(0, exit)
        let combined = stdout + "\n" + stderr
        Assert.Contains("FirstOrNil", combined, StringComparison.Ordinal)
    }

    @Fact
    func FirstOrNil_WithImport_CompilesCleanly() {
        let (exit, stdout, stderr) = CompileSnippet(SnippetWithImport)
        Assert.True(exit == 0, (`expected clean compile with explicit import:
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
    }

    shared {
        private const SnippetWithoutImport string = `
package GSharp.Extensions.Tests.AutoImportProbe

import System

let names []string = []string { "alpha", "beta" }
let head = names.FirstOrNil()
Console.WriteLine(head ?? "<none>")
`

        private const SnippetWithImport string = `
package GSharp.Extensions.Tests.AutoImportProbe

import System
import Gsharp.Extensions.Sequences

let names []string = []string { "alpha", "beta" }
let head = names.FirstOrNil()
Console.WriteLine(head ?? "<none>")
`

        private func CompileSnippet(source string)(exit int32, stdout string, stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_noautoimport_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "snippet.gs")
                File.WriteAllText(srcPath, source)
                let outPath = Path.Combine(tempDir, "snippet.dll")
                let extensionsAssembly string? = LocateGsharpExtensionsAssembly()
                Assert.True(
                    extensionsAssembly != nil && File.Exists(extensionsAssembly),
                    "Gsharp.Extensions.dll must be built before running this test (run `dotnet build`)."
                )
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/r:" + extensionsAssembly,
                    srcPath
                }
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                var exit int32
                try {
                    exit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                return (exit, stdout.ToString(), stderr.ToString())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // best-effort cleanup

                }
            }
        }

        private func LocateGsharpExtensionsAssembly() string? {
            var dir DirectoryInfo? = DirectoryInfo(Path.GetDirectoryName(typeof(NoAutoImportTests).Assembly.Location)!!)
            while dir != nil {
                if RepositoryRootMarker.IsRoot(dir.FullName) {
                    for cfg in[]string{"Debug", "Release"} {
                        let candidate = Path.Combine(
                            dir.FullName,
                            "out",
                            "bin",
                            cfg,
                            "Gsharp.Extensions",
                            "Gsharp.Extensions.dll"
                        )
                        if File.Exists(candidate) {
                            return candidate
                        }
                    }
                    return nil
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
