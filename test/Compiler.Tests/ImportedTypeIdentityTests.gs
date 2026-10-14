// <copyright file="ImportedTypeIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis.Symbols
import Spectre.Console
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

open class ImportedTypeIdentityTests {
    @Fact
    func QualifiedImportedConstructor_WithObjectInitializer_BindsExactOahuSiteDespiteLocalTypeCollision() {
        let source = `package Oahu.Cli.Commands
import System
import Spectre.Console
import Spectre.Console.Rendering

class Rule {}

class UiPreviewCommand {
    shared {
        func RenderPreview(console IAnsiConsole, args string) {
            let rule = Spectre.Console.Rule(args){Justification = Justify.Left}
            console.Write(rule!!)
        }
    }
}

UiPreviewCommand.RenderPreview(AnsiConsole.Console, "Theme")`
        let spectrePath = typeof(Rule).Assembly.Location
        let (exitCode, output) = Compile(
            source,
            spectrePath,
            Path.Combine(Path.GetDirectoryName(spectrePath)!!, "Spectre.Console.Ansi.dll")
        )
        Assert.True(exitCode == 0, output)
        Assert.DoesNotContain("GS0157", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS0159", output, StringComparison.Ordinal)
    }

    @Fact
    func FullyQualifiedAndImportedExternalType_Unify() {
        let source = `package P
import System
import System.Text

func take(value StringBuilder) string {
    return value.ToString()
}

let value StringBuilder = System.Text.StringBuilder()
Console.WriteLine(take(value))`
        let (exitCode, output) = Compile(source)
        Assert.True(exitCode == 0, output)
        Assert.DoesNotContain("GS0155", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS0158", output, StringComparison.Ordinal)
    }

    @Fact
    func TypeIdentityComparer_MatchesReresolvedType() {
        let references = TrustedPlatformAssemblies().ToList()
        if references.Count == 0 {
            return
        }
        using let first = ReferenceResolver.WithReferences(references)
        using let second = ReferenceResolver.WithReferences(references)
        Assert.True(first.TryResolveType("System.Text.StringBuilder", out var left))
        Assert.True(second.TryResolveType("System.Text.StringBuilder", out var right))
        Assert.NotSame(left, right)
        let comparerType Type? = typeof(ReferenceResolver).Assembly.GetType(
            "GSharp.Core.CodeAnalysis.Emit.TypeIdentityComparer"
        )
        let comparer object? = comparerType?.GetField("Instance", BindingFlags.Public | BindingFlags.Static)?.GetValue(
            nil
        )
        let dictionary = Dictionary[Type, string](Assert.IsAssignableFrom[IEqualityComparer[Type]](comparer)){
            [left] = "hit"
        }
        Assert.True(dictionary.TryGetValue(right, out var value))
        Assert.Equal("hit", value)
    }

    shared {
        private func Compile(source string, references ...string)(ExitCode int32, Output string) {
            let workDir = CreateTestDirectory("gs_identity_test_")
            try {
                let srcPath = Path.Combine(workDir, "test.gs")
                let outPath = Path.Combine(workDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                for reference in TrustedPlatformAssemblies() {
                    args.Add("/reference:" + reference)
                }
                for reference in references {
                    args.Add("/reference:" + reference)
                }
                args.Add(srcPath)
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousErr = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                try {
                    return (Program.Main(args.ToArray()), stdout.ToString() + stderr.ToString())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousErr)
                }
            } finally {
                try {
                    Directory.Delete(workDir, recursive: true)
                } catch { }
            }
        }

        private func CreateTestDirectory(prefix string) string {
            let root = Path.Combine(Environment.CurrentDirectory, "TestArtifacts")
            Directory.CreateDirectory(root)
            let path = Path.Combine(root, prefix + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(path)
            return path
        }

        private func TrustedPlatformAssemblies() sequence[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                yield break
            }
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }
    }
}
