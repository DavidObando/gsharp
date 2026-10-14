// <copyright file="Issue2704RecordObjectInitializerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Runtime.CompilerServices
import System.Runtime.Loader
import Xunit

/// Issue #2704: data-class literals call init accessors.
class Issue2704RecordObjectInitializerEmitTests {
    @Fact
    func ExactCliMapBook_UsesInitAccessors_AndIlVerifies() {
        const source = `package Oahu.Cli.App.Models

import System

data class LibraryItem {
    prop Asin string { get; init; }
    prop Title string { get; init; }
    private var authors []string = Array.Empty[string]()
    prop Authors []string {
        get -> authors
        init { authors = value }
    }
    private var narrators []string = Array.Empty[string]()
    prop Narrators []string {
        get -> narrators
        init { narrators = value }
    }
}

class CoreLibraryService {
    shared {
        public func MapBook(asin string, title string) LibraryItem ->
            LibraryItem{
                Asin: asin,
                Title: title,
                Authors: []string{"author"},
                Narrators: []string{"narrator"}
            }
    }
}

let item = CoreLibraryService.MapBook("A1", "Book")
Console.WriteLine(item.Asin)
Console.WriteLine(item.Title)
Console.WriteLine(item.Authors[0])
Console.WriteLine(item.Narrators[0])`
        using let result = Compile(source)
        Assert.Equal(
            "A1${Environment.NewLine}Book${Environment.NewLine}author${Environment.NewLine}narrator${Environment.NewLine}",
            Run(result.OutputPath)
        )
        IlVerifier.Verify(result.OutputPath)
        let loadContext = AssemblyLoadContext("issue2704-" + Guid.NewGuid().ToString(), isCollectible: true)
        try {
            let assembly = loadContext.LoadFromAssemblyPath(result.OutputPath)
            let itemType = assembly.GetType("Oahu.Cli.App.Models.LibraryItem", throwOnError: true)!!
            for name in[]string{"Asin", "Title", "Authors", "Narrators"} {
                let property = itemType.GetProperty(name)!!
                Assert.True(
                    property.SetMethod!!.ReturnParameter.GetRequiredCustomModifiers().Contains(typeof(IsExternalInit)),
                    "$name setter must carry modreq(IsExternalInit)."
                )
            }
            let mapBook = assembly.GetType("Oahu.Cli.App.Models.CoreLibraryService", throwOnError: true)!!.GetMethod(
                "MapBook",
                BindingFlags.Public | BindingFlags.Static
            )!!
            let il = mapBook.GetMethodBody()!!.GetILAsByteArray()!!
            Assert.DoesNotContain(unchecked(uint8(OpCodes.Stfld.Value)), il)
            Assert.Equal(4, il.Count((b uint8) -> b == unchecked(uint8(OpCodes.Callvirt.Value))))
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func InitProperty_AssignmentAfterConstruction_RemainsRejected() {
        const source = `package Oahu.Cli.App.Models

data class LibraryItem {
    prop Asin string { get; init; }
}

let item = LibraryItem{Asin: "A1"}
item.Asin = "A2"`
        let tree = SyntaxTree.Parse(SourceText.From(source, "CoreLibraryService.gs"))
        let compilation = Compilation(tree)
        using let pe = MemoryStream()
        let result = compilation.Emit(pe, refStream: nil)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0372")
    }

    private class CompilationResult : IDisposable {
        init(directoryPath string, outputPath string) {
            DirectoryPath = directoryPath
            OutputPath = outputPath
        }

        prop DirectoryPath string {
            get;
        }

        prop OutputPath string {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(DirectoryPath, recursive: true)
            } catch { }
        }
    }

    shared {
        private func Compile(source string) Issue2704RecordObjectInitializerEmitTests.CompilationResult {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue2704-artifacts", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "CoreLibraryService.gs")
            let outputPath = Path.Combine(directory, "Oahu.Cli.App.dll")
            File.WriteAllText(sourcePath, source)
            let args = List[string]{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0"}
            args.AddRange(TrustedPlatformAssemblies().Select((path string) -> ("/reference:" + path)))
            args.Add(sourcePath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(exitCode == 0, (`compile failed (` + "$exitCode" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return Issue2704RecordObjectInitializerEmitTests.CompilationResult(directory, outputPath)
        }

        private func Run(assemblyPath string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start dotnet exec.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
            Assert.True(process.ExitCode == 0, (`exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let value string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            return if string.IsNullOrEmpty(value) {
                Enumerable.Empty[string]()
            } else {
                cast[IEnumerable[string]](value!!.Split(Path.PathSeparator))
            }
        }
    }
}
