// <copyright file="Issue2640ImportedInterpolatedStringHandlerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #2640: imported interpolated-string-handler overloads.
open class Issue2640ImportedInterpolatedStringHandlerEmitTests {
    @Fact
    func MetadataCompilation_AlignedStringCreate_DoesNotMixRuntimeTypes() {
        const Source = `package Oahu.Cli.Tui
import System
import System.Globalization

func FormatPercent(value float64) string {
    return String.Create(CultureInfo.InvariantCulture, "${int(Math.Round(value * 100.0)),3}%")
}`
        using let resolver = ReferenceResolver.WithReferences(BclReferences.Value)
        Assert.True(
            resolver.TryResolveType(
                "System.Runtime.CompilerServices.DefaultInterpolatedStringHandler",
                out var handlerType
            )
        )
        Assert.Throws[ArgumentException](
            func () object? {
                return handlerType.GetMethod("AppendLiteral", []Type{typeof(string)})
            }
        )
        let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(Source))){IsLibrary = true}
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func OahuJobsScreen_FormatPercent_EmitsVerifiesAndRuns() {
        const Source = `package Oahu.Cli.Tui
import System
import System.Globalization

func FormatPercent(p float64?) string -> if p != nil { String.Create(CultureInfo.InvariantCulture, "${int32(Math.Round(p * float64(100.0))),3}%") } else { "  …" }

Console.Write(FormatPercent(0.42))`
        let (exitCode, diagnostics, outputPath, directory) = Compile(Source)
        try {
            Assert.DoesNotContain("Cannot find function Create", diagnostics, StringComparison.Ordinal)
            Assert.DoesNotContain("Cannot find function Round", diagnostics, StringComparison.Ordinal)
            Assert.True(exitCode == 0, diagnostics)
            IlVerifier.Verify(outputPath)
            Assert.Equal(" 42%", Run(outputPath, directory))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func StringCreate_AlignmentAndFormat_EmitsVerifiesAndRuns() {
        const Source = `package Formatted
import System
import System.Globalization

let value = 42
Console.Write(String.Create(CultureInfo.InvariantCulture, "${value,6:0000}"))`
        let (exitCode, diagnostics, outputPath, directory) = Compile(Source)
        try {
            Assert.True(exitCode == 0, diagnostics)
            IlVerifier.Verify(outputPath)
            Assert.Equal("  0042", Run(outputPath, directory))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func StringCreate_PlainString_DoesNotBindHandlerOverload() {
        const Source = `package Negative
import System
import System.Globalization

let value = String.Create(CultureInfo.InvariantCulture, "Oahu")`
        let (exitCode, diagnostics, _, directory) = Compile(Source)
        try {
            Assert.Equal(1, exitCode)
            Assert.Contains("GS0159", diagnostics, StringComparison.Ordinal)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func Compile(source string)(ExitCode int32, Diagnostics string, OutputPath string, Directory string) {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue2640", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let outputPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            let args = List[string]{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
            args.AddRange(BclReferences.Value.Select((path string) -> ("/r:" + path)))
            args.Add(sourcePath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(args.ToArray())
                return (exitCode, stdout.ToString() + stderr.ToString(), outputPath, directory)
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func Run(outputPath string, directory string) string {
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
                throw InvalidOperationException("Failed to start dotnet exec")
            let output = process.StandardOutput.ReadToEnd()
            let error = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(process.ExitCode == 0, "exited ${process.ExitCode}: $error")
            return output
        }

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                let runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
                let dotnetRoot = Directory.GetParent(runtimeDirectory)!!.Parent!!.Parent!!.FullName
                let tfm = "net${Environment.Version.Major}.0"
                let packsRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref")
                let referenceDirectory = Directory
                    .EnumerateDirectories(packsRoot, Environment.Version.Major.ToString() + ".*")
                    .OrderByDescending((path string) -> path, StringComparer.Ordinal)
                    .Select((path string) -> Path.Combine(path, "ref", tfm))
                    .First(Directory.Exists)
                return Directory.EnumerateFiles(referenceDirectory, "*.dll").ToList()
            }
        )
    }
}
