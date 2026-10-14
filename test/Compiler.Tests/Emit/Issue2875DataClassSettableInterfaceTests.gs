// <copyright file="Issue2875DataClassSettableInterfaceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Issue #2875: an init-only positional data member cannot implement an
/// interface property that requires an ordinary setter.
open class Issue2875DataClassSettableInterfaceTests {
    @Fact
    func PositionalDataClassMember_SettableInterfaceProperty_ReportsGS0502AndDoesNotEmit() {
        const source = `package S1

interface IBox {
    prop Value int32 { get; set; }
}

data class Box(Value int32) : IBox`
        let output = CompileExpectingFailure(source)
        Assert.Contains("GS0502", output, StringComparison.Ordinal)
        Assert.Contains(
            "Type 'Box' cannot use positional member 'Value' to implement interface property 'IBox.Value' because the member uses accessor 'init' but the interface requires 'set'; declare property 'Value' explicitly with a 'set' accessor.",
            output,
            StringComparison.Ordinal
        )
    }

    @Fact
    func ExplicitSettableProperty_StillVerifiesAndRuns() {
        const source = `package S2
import System

interface IBox2 {
    prop Value int32 { get; set; }
}

data class Box2 : IBox2 {
    prop Value int32 { get; set; }
}

func Main() {
    let box IBox2 = Box2()
    box.Value = 7
    Console.WriteLine(box.Value)
}`
        Assert.Equal("7${Environment.NewLine}", CompileVerifyAndRun(source))
    }

    @Fact
    func PositionalDataClassMember_GetOnlyInterfaceProperty_StillVerifiesAndRuns() {
        const source = `package S3
import System

interface IBox3 {
    prop Value int32 { get; }
}

data class Box3(Value int32) : IBox3

func Main() {
    let box IBox3 = Box3(11)
    Console.WriteLine(box.Value)
}`
        Assert.Equal("11${Environment.NewLine}", CompileVerifyAndRun(source))
    }

    @Fact
    func PositionalDataStructMember_SettableInterfaceProperty_ReportsGS0502AndDoesNotEmit() {
        const source = `package S4

interface IBox4 {
    prop Value int32 { get; set; }
}

data struct Box4(Value int32) : IBox4`
        let output = CompileExpectingFailure(source)
        Assert.Contains("GS0502", output, StringComparison.Ordinal)
        Assert.Contains("positional member 'Value'", output, StringComparison.Ordinal)
        Assert.Contains("IBox4.Value", output, StringComparison.Ordinal)
    }

    @Fact
    func PositionalDataClassMember_GenericSettableInterfaceProperty_ReportsGS0502AndDoesNotEmit() {
        const source = `package S5

interface IBox[T] {
    prop Value T { get; set; }
}

data class Box(Value int32) : IBox[int32]`
        let output = CompileExpectingFailure(source)
        Assert.Contains("GS0502", output, StringComparison.Ordinal)
        Assert.Contains("IBox[int32].Value", output, StringComparison.Ordinal)
    }

    @Fact
    func ImportedInitOnlyInterfaces_OrdinarySetters_ReportGS0502AndDoNotEmit() {
        const source = `package S6
import CsInit

class Box : IBox {
    prop Value int32 { get; set; }
}

class Item {
}

class GenericBox : IGenericBox[Item] {
    prop Value Item { get; set; }
}`
        let fixtureDirectory = CreateWorkDirectory()
        try {
            let referencePath = CompileCSharpFixture(fixtureDirectory, `namespace CsInit;
public interface IBox
{
    int Value { get; init; }
}

public interface IGenericBox<T>
{
    T Value { get; init; }
}`)
            let output = CompileExpectingFailure(source, referencePath)
            Assert.Equal(2, output.Split("GS0502", StringSplitOptions.None).Length - 1)
            Assert.Contains("uses accessor 'set'", output, StringComparison.Ordinal)
            Assert.Contains("requires 'init'", output, StringComparison.Ordinal)
            Assert.Contains("interface property 'CsInit.IGenericBox[Item].Value'", output, StringComparison.Ordinal)
            Assert.DoesNotContain("CsInit.IGenericBox`1[[", output, StringComparison.Ordinal)
        } finally {
            Directory.Delete(fixtureDirectory, recursive: true)
        }
    }

    @Fact
    func ImportedGSharpConstructedGenericInterface_DiagnosticUsesGSharpTypeSyntax() {
        const library = `package GLib2

interface IBase[T] {
    func BaseEcho(v T) T;
}

interface IGBox[T] : IBase[T] {
    prop V T { get; init; }
    prop OnlyGet T { get; }
    func Echo(v T) T;
    func Take(v IBase[T]) void;
}`
        const source = `package Consumer
import GLib2

class Box : IGBox[int32] {
    prop V int32 { get; set; }
}`
        let directory = CreateWorkDirectory()
        try {
            let librarySourcePath = Path.Combine(directory, "GLib2.gs")
            let libraryPath = Path.Combine(directory, "GLib2.dll")
            File.WriteAllText(librarySourcePath, library)
            let (libraryExitCode, libraryOutput) = Compile(
                "/out:" + libraryPath,
                "/target:library",
                "/targetframework:net10.0",
                librarySourcePath
            )
            Assert.True(libraryExitCode == 0, "gsc failed:\n" + libraryOutput)
            let output = CompileExpectingFailure(source, libraryPath)
            Assert.Contains("interface property 'GLib2.IGBox[int32].V'", output, StringComparison.Ordinal)
            Assert.Contains(
                "Class 'Box' does not implement interface method 'GLib2.IGBox[int32].OnlyGet'.",
                output,
                StringComparison.Ordinal
            )
            Assert.Contains(
                "Class 'Box' does not implement interface method 'GLib2.IGBox[int32].Echo(int32)'.",
                output,
                StringComparison.Ordinal
            )
            Assert.Contains(
                "Class 'Box' does not implement interface method 'GLib2.IGBox[int32].Take(GLib2.IBase[int32])'.",
                output,
                StringComparison.Ordinal
            )
            Assert.Contains(
                "Class 'Box' does not implement interface method 'GLib2.IBase[int32].BaseEcho(int32)'.",
                output,
                StringComparison.Ordinal
            )
            Assert.DoesNotContain("GLib2.IGBox`1[[", output, StringComparison.Ordinal)
            Assert.DoesNotContain("GLib2.IBase`1[[", output, StringComparison.Ordinal)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func SymbolicImportedGenericInterface_DiagnosticUsesSymbolicTypeArgument() {
        const source = `package Symbolic
import System

class Shape : IEquatable[Shape] {
}`
        let output = CompileExpectingFailure(source)
        Assert.Contains(
            "Class 'Shape' does not implement interface method 'System.IEquatable[Shape].Equals(T)'.",
            output,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("System.IEquatable`1[[", output, StringComparison.Ordinal)
    }

    @Fact
    func ImportedConstructedGenericConstraint_DiagnosticUsesGSharpTypeSyntax() {
        const source = `package Constraint
import System.Collections.Generic

func F[T List[int32]](value T) {
}

func Use() {
    F[string]("x")
}`
        let output = CompileExpectingFailure(source)
        Assert.Contains(
            "Type argument 'string' for type parameter 'T' does not satisfy the 'System.Collections.Generic.List[int32]' constraint.",
            output,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("System.Collections.Generic.List`1[[", output, StringComparison.Ordinal)
    }

    @Fact
    func GSharpInitOnlyInterface_ValidImplementationsVerifyAndLoad() {
        const source = `package S7

interface IBox {
    prop Value int32 { get; init; }
}

class ImplicitBox : IBox {
    prop Value int32 { get; init; }
}

class ExplicitBox : IBox {
    private prop (IBox) Value int32 { get; init; }
}

data class PositionalBox(Value int32) : IBox`
        CompileVerifyAndLoad(source)
    }

    shared {
        private func CompileExpectingFailure(source string, referencePath string? = nil) string {
            let directory = CreateWorkDirectory()
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                let arguments = List[string]{"/out:" + outputPath, "/target:library", "/targetframework:net10.0"}
                if referencePath != nil {
                    arguments.Add("/r:" + referencePath)
                }
                arguments.Add(sourcePath)
                let (exitCode, output) = Compile(arguments.ToArray())
                Assert.NotEqual(0, exitCode)
                Assert.False(File.Exists(outputPath), "gsc must not emit an assembly after GS0502")
                return output
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func CompileCSharpFixture(directory string, source string) string {
            let outputPath = Path.Combine(directory, "CsInit.dll")
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))).Split(Path.PathSeparator)
                .Select((path string) -> MetadataReference.CreateFromFile(path))
            let compilation = CSharpCompilation.Create(
                "CsInit",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let output = File.Create(outputPath)
            let result = compilation.Emit(output)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return outputPath
        }

        private func CompileVerifyAndRun(source string) string {
            let directory = CreateWorkDirectory()
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                let (exitCode, output) = Compile(
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath
                )
                Assert.True(exitCode == 0, "gsc failed:\n" + output)
                IlVerifier.Verify(outputPath)
                let _ = EmittedFixture.Load(outputPath).GetTypes()
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add(outputPath)
                using let process = Process.Start(startInfo) ??
                    throw InvalidOperationException("Failed to start emitted program.")
                let stdout = process.StandardOutput.ReadToEnd()
                let stderr = process.StandardError.ReadToEnd()
                Assert.True(process.WaitForExit(30_000), "Emitted program timed out.")
                Assert.True(process.ExitCode == 0, (`Program exited ` + "${process.ExitCode}" + `:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func CompileVerifyAndLoad(source string) {
            let directory = CreateWorkDirectory()
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                let (exitCode, output) = Compile(
                    "/out:" + outputPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    sourcePath
                )
                Assert.True(exitCode == 0, "gsc failed:\n" + output)
                IlVerifier.Verify(outputPath)
                let _ = EmittedFixture.Load(outputPath).GetTypes()
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func Compile(arguments ...string)(ExitCode int32, Output string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(arguments)
                return (exitCode, stdout.ToString() + stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func CreateWorkDirectory() string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2875", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            return directory
        }
    }
}
