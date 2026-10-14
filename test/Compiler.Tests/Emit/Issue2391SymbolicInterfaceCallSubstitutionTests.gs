// <copyright file="Issue2391SymbolicInterfaceCallSubstitutionTests.cs" company="GSharp">
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

/// Issue #2391: calls through an imported generic interface closed over a
/// same-compilation source type must substitute parameter and return positions
/// from the same symbolic receiver mapping.
open class Issue2391SymbolicInterfaceCallSubstitutionTests {
    @Fact
    func SourceEnum_NullableParameterAndReturnThroughInterface_CompilesRunsAndVerifies() {
        let source = `package Issue2391Enum
import System
import Issue2391.Contracts

enum Color { Red, Green, Blue }

class ColorRepo : IRepo[Color] {
    func Find() Color? { return Color.Green }
    func Echo(value Color?) Color? { return value }
}

func Read(repo IRepo[Color]) Color? {
    return repo.Find()
}

func Main() {
    var repo IRepo[Color] = ColorRepo()
    var found Color? = Read(repo)
    var input Color? = Color.Blue
    var echoed Color? = repo.Echo(input)
    Console.WriteLine(found == Color.Green)
    Console.WriteLine(echoed == Color.Blue)
}`
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", CompileAndRunWithContracts(source))
    }

    @Fact
    func SourceStruct_NullableParameterAndReturnThroughInterface_CompilesRunsAndVerifies() {
        let source = `package Issue2391Struct
import System
import Issue2391.Contracts

struct Token {
    var Value int32
}

class TokenRepo : IRepo[Token] {
    func Find() Token? { return Token{ Value: 41 } }
    func Echo(value Token?) Token? { return value }
}

func Main() {
    var repo IRepo[Token] = TokenRepo()
    var input Token? = Token{ Value: 42 }
    var found Token? = repo.Find()
    var echoed Token? = repo.Echo(input)
    Console.WriteLine((found!!).Value)
    Console.WriteLine((echoed!!).Value)
}`
        Assert.Equal("41${Environment.NewLine}42${Environment.NewLine}", CompileAndRunWithContracts(source))
    }

    @Fact
    func SymbolicInterfaceReturn_DoesNotConvertToUnrelatedSourceType() {
        let source = `package Issue2391Negative
import Issue2391.Contracts

enum Color { Red, Green }
enum Other { A, B }

class ColorRepo : IRepo[Color] {
    func Find() Color? { return Color.Green }
    func Echo(value Color?) Color? { return value }
}

func Bad(repo IRepo[Color]) Other? {
    return repo.Find()
}`
        let (exitCode, stdout, stderr) = CompileWithContracts(source, run: false)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0155", stdout + stderr, StringComparison.Ordinal)
    }

    @Fact
    func SymbolicInterfaceParameter_DoesNotAcceptUnrelatedSourceType() {
        let source = `package Issue2391ParameterNegative
import Issue2391.Contracts

enum Color { Red, Green }
enum Other { A, B }

class ColorRepo : IRepo[Color] {
    func Find() Color? { return Color.Green }
    func Echo(value Color?) Color? { return value }
}

func Bad(repo IRepo[Color], value Other?) Color? {
    return repo.Echo(value)
}`
        let (exitCode, stdout, stderr) = CompileWithContracts(source, run: false)
        Assert.NotEqual(0, exitCode)
        Assert.Contains("GS0155", stdout + stderr, StringComparison.Ordinal)
    }

    @Fact
    func ClosedBclTypeArgument_ControlStillRuns() {
        let source = `package Issue2391Control
import System
import Issue2391.Contracts

class GuidRepo : IRepo[Guid] {
    func Find() Guid? { return nil }
    func Echo(value Guid?) Guid? { return value }
}

func Main() {
    var value Guid = Guid.NewGuid()
    var repo IRepo[Guid] = GuidRepo()
    Console.WriteLine(repo.Echo(value) == value)
}`
        Assert.Equal("True${Environment.NewLine}", CompileAndRunWithContracts(source))
    }

    shared {
        private const CSharpContracts string = `namespace Issue2391.Contracts
{
    public interface IRepo<T>
        where T : struct
    {
        T? Find();

        T? Echo(T? value);
    }
}`

        private func CompileAndRunWithContracts(source string) string {
            let (exitCode, stdout, stderr) = CompileWithContracts(source, run: true)
            Assert.True(exitCode == 0, (`exited ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CompileWithContracts(source string, run bool)(ExitCode int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2391_").FullName
            try {
                let contractPath = EmitCSharpContracts(tempDir)
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    if run {
                        "/target:exe"
                    } else {
                        "/target:library"
                    },
                    "/targetframework:net10.0",
                    "/reference:" + contractPath,
                    "/nowarn:GS9100"
                }
                for reference in BclReferences.Value {
                    args.Add("/reference:" + reference)
                }
                args.Add(srcPath)
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
                if compileExit != 0 || !run {
                    return (compileExit, compileOut.ToString(), compileErr.ToString())
                }
                IlVerifier.Verify(outPath, additionalReferences: []string{contractPath})
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                startInfo.ArgumentList.Add(outPath)
                using let process = Process.Start(startInfo) ??
                    throw InvalidOperationException("Failed to start dotnet exec.")
                let stdout = process.StandardOutput.ReadToEnd()
                let stderr = process.StandardError.ReadToEnd()
                Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
                return (
                    process.ExitCode,
                    stdout.ReplaceLineEndings(Environment.NewLine),
                    stderr.ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func EmitCSharpContracts(outputDirectory string) string {
            let outputPath = Path.Combine(outputDirectory, "Issue2391.Contracts.dll")
            let syntaxTree = CSharpSyntaxTree.ParseText(CSharpContracts, CSharpParseOptions(LanguageVersion.Latest))
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                "Issue2391.Contracts",
                []SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = File.Create(outputPath)
            let result = compilation.Emit(stream)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return outputPath
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let value string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            return if string.IsNullOrEmpty(value) {
                Enumerable.Empty[string]()
            } else {
                value!!.Split(Path.PathSeparator).Where(File.Exists)
            }
        }

        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            () -> {
                let runtimeDirectory string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
                return if string.IsNullOrEmpty(runtimeDirectory) || !Directory.Exists(runtimeDirectory) {
                    cast[IReadOnlyList[string]](Array.Empty[string]())
                } else {
                    cast[IReadOnlyList[string]](
                        Directory.EnumerateFiles(runtimeDirectory!!, "*.dll", SearchOption.TopDirectoryOnly).ToList()
                    )
                }
            }
        )
    }
}
