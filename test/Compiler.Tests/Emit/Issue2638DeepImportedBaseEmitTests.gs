// <copyright file="Issue2638DeepImportedBaseEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

class Issue2638DeepImportedBaseEmitTests {
    @Fact
    func CrossAssemblyDeepPublicMethod_Runs() {
        using let fixture = Issue2638DeepImportedBaseEmitTests.Fixture()
        let result = fixture.CompileGSharp(`package Issue2638.Consumer
import System
import Issue2638.Library

Console.WriteLine(Leaf().Apply(Rule(2638)))`, "exe")
        Assert.Equal(0, result.ExitCode)
        IlVerifier.Verify(result.OutputPath, additionalReferences: []string{fixture.LibraryPath})
        Assert.Equal("deep:2638${Environment.NewLine}", fixture.Run(result.OutputPath))
    }

    @Fact
    func CrossAssemblyDeepNonPublicMethods_ReportGS0159() {
        using let fixture = Issue2638DeepImportedBaseEmitTests.Fixture()
        let result = fixture.CompileGSharp(`package Issue2638.Consumer
import Issue2638.Library

func Probe(value Leaf) {
    value.ProtectedOnly()
    value.InternalOnly()
    value.PrivateOnly()
}`, "library")
        Assert.NotEqual(0, result.ExitCode)
        Assert.Equal(3, Count(result.Output, "GS0159"))
    }

    private class Fixture : IDisposable {
        private let directory string = Path.Combine(
            AppContext.BaseDirectory,
            "Issue2638DeepImportedBaseEmitTests",
            Guid.NewGuid().ToString("N")
        )

        init() {
            Directory.CreateDirectory(directory)
            LibraryPath = Path.Combine(directory, "Issue2638.Library.dll")
            EmitCSharpLibrary(LibraryPath)
        }

        prop LibraryPath string {
            get;
        }

        func CompileGSharp(source string, target string) Issue2638DeepImportedBaseEmitTests.CompileResult {
            let sourcePath = Path.Combine(directory, "Consumer.gs")
            let outputPath = Path.Combine(directory, "Consumer.dll")
            File.WriteAllText(sourcePath, source)
            let args = List[string]{
                "/out:" + outputPath,
                "/target:" + target,
                "/targetframework:net10.0",
                "/r:" + LibraryPath,
                sourcePath
            }
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
            return Issue2638DeepImportedBaseEmitTests.CompileResult(
                exitCode,
                outputPath,
                stdout.ToString() + stderr.ToString()
            )
        }

        func Run(assemblyPath string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add(assemblyPath)
            using let process Process? = Process.Start(startInfo)
            let stdout = process!!.StandardOutput.ReadToEnd()
            let stderr = process!!.StandardError.ReadToEnd()
            Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(process!!.ExitCode == 0, (`exit ` + "${process!!.ExitCode}" + `
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        func Dispose() {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }

        shared {
            private func EmitCSharpLibrary(path string) {
                let references = (
                    (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                        Array.Empty[string]()
                )
                    .Where(File.Exists).Select((file string) -> MetadataReference.CreateFromFile(file))
                let compilation = CSharpCompilation.Create(
                    "Issue2638.Library",
                    []SyntaxTree{
                        CSharpSyntaxTree.ParseText(
                            Issue2638DeepImportedBaseEmitTests.LibrarySource,
                            CSharpParseOptions(LanguageVersion.Latest)
                        )
                    },
                    references,
                    CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                )
                using let stream = File.Create(path)
                let result = compilation.Emit(stream)
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
        }
    }

    private data class CompileResult(ExitCode int32, OutputPath string, Output string) : IEquatable[
        Issue2638DeepImportedBaseEmitTests.CompileResult
    ] { }

    shared {
        private const LibrarySource string = `namespace Issue2638.Library;

public sealed class Rule
{
    public Rule(int value) => Value = value;
    public int Value { get; }
}

public class Root
{
    public string Apply(Rule rule) => "deep:" + rule.Value;
    protected string ProtectedOnly() => "protected";
    internal string InternalOnly() => "internal";
    private string PrivateOnly() => "private";
}

public class Mid : Root
{
    public string Distractor() => "distractor";
}

public sealed class Leaf : Mid
{
    public string Own() => "own";
}`

        private func Count(text string, value string) int32 {
            var count = 0
            for var index = 0;
                (index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0;
                index += value.Length {
                count++
            }
            return count
        }
    }
}
