// <copyright file="Issue3100FieldOffsetDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis
import GSharp.Repl
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.InteropServices
import Xunit

/// Issues #3100 and #3115: explicit field layout must match the CLR across
/// bare `gsc`, explicit-output `gsc`, and `gsi` emitted drivers.
@Collection("ConsoleIo")
open class Issue3100FieldOffsetDriverTests {
    @Theory
    @MemberData("LayoutCases")
    func FieldLayout_AgreesAcrossEmittedDrivers(layoutCase string) {
        let source = SourceFor(layoutCase)
        let root = CreateEmptyDirectory(layoutCase)
        try {
            let bare = RunBareGsc(source, CreateEmptyDirectory(root, "bare"))
            let emitted = RunEmitted(source, layoutCase, CreateEmptyDirectory(root, "emit"))
            let gsi = RunGsi(source, CreateEmptyDirectory(root, "gsi"))
            let expected = if layoutCase == "FullOverlap" || layoutCase == "PartialOverlap" {
                "2${Environment.NewLine}11${Environment.NewLine}22${Environment.NewLine}33${Environment.NewLine}44${Environment.NewLine}44"
            } else {
                "1${Environment.NewLine}11${Environment.NewLine}22${Environment.NewLine}33${Environment.NewLine}33${Environment.NewLine}44"
            }
            Assert.Equal(expected, emitted)
            Assert.Equal(emitted, bare)
            Assert.Equal(emitted, gsi)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Theory
    @InlineData(int32(0), "int64")
    @InlineData(int32(4), "int32")
    func ReferenceAndPrimitiveOverlapReportsGs0518AcrossEmittedDrivers(primitiveOffset int32, primitiveType string) {
        let source = (`package Issue3115Invalid
import System
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Explicit, Size: 8)
struct Bad {
    @FieldOffset(0) var Text string
    @FieldOffset(` + "$primitiveOffset" + `) var Bits ` + "$primitiveType" + `
}

var value = Bad{Text: "x", Bits: 0}
Console.WriteLine(value.Bits)`)
        AssertGs0518AcrossEmittedDrivers(source, "ReferencePrimitiveOverlap")
    }

    @Fact
    func ForwardDeclaredValueTypeOverlapReportsGs0518AcrossEmittedDrivers() {
        const Source = `package Issue3115ForwardOverlap
import System
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Explicit, Size: 16)
struct Bad {
    @FieldOffset(8) var Text string
    @FieldOffset(4) var Bits Payload
}
struct Payload { var Value int64 }

var value = Bad{Text: "x", Bits: Payload{Value: 0}}
Console.WriteLine(value.Bits.Value)`
        AssertGs0518AcrossEmittedDrivers(Source, "ForwardValueOverlap")
    }

    @Fact
    func NestedStructOverlapReportsGs0518AcrossEmittedDrivers() {
        const Source = `package Issue3115NestedOverlap
import System
import System.Runtime.InteropServices
struct Outer {
    @StructLayout(LayoutKind.Explicit, Size: 8)
    struct Inner {
        @FieldOffset(0) var Text string
        @FieldOffset(0) var Bits int64
    }
}
var value = 11
Console.WriteLine(value)`
        AssertGs0518AcrossEmittedDrivers(Source, "NestedOverlap", 8, 29, 33)
    }

    @Theory
    @InlineData(int32(0), int32(6))
    @InlineData(int32(24), int32(30))
    func MisalignedReferenceReportsGs0518WithRealLocationAcrossEmittedDrivers(paddingLines int32, expectedLine int32) {
        let source = string.Join(
            "\n",
            []string{"package Issue3115MisalignedReference", "import System", "import System.Runtime.InteropServices"}
                .Concat(Enumerable.Repeat("// padding", paddingLines)).Concat(
                []string{
                    "@StructLayout(LayoutKind.Explicit, Size: 16)",
                    "struct Bad {",
                    "    @FieldOffset(4) var Text string",
                    "    @FieldOffset(12) var Bits int32",
                    "}",
                    "var value = Bad{Text: \"x\", Bits: 11}",
                    "Console.WriteLine(value.Bits)"
                }
            )
        )
        AssertGs0518AcrossEmittedDrivers(
            source,
            "MisalignedReference$paddingLines",
            expectedLine,
            25,
            29,
            "offset 4 is not aligned to pointer size"
        )
    }

    @Fact
    func WorkingReferenceLayoutsRemainValidAcrossEmittedDrivers() {
        let source = ReferenceLayoutCorpusSource()
        let root = CreateEmptyDirectory("ReferenceLayoutCorpus")
        try {
            let bare = RunBareGsc(source, CreateEmptyDirectory(root, "bare"))
            let emitted = RunEmitted(source, CreateEmptyDirectory(root, "emit"))
            let gsi = RunGsi(source, CreateEmptyDirectory(root, "gsi"))
            Assert.Equal(
                "A${Environment.NewLine}11${Environment.NewLine}C${Environment.NewLine}D${Environment.NewLine}22${Environment.NewLine}44${Environment.NewLine}E${Environment.NewLine}55",
                emitted
            )
            Assert.Equal(emitted, bare)
            Assert.Equal(emitted, gsi)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    func ExplicitLayoutStorageInvariantCannotBeBypassed() {
        Assert.Equal(typeof(object), typeof(StructValue.FieldCollection).BaseType)
        let backing FieldInfo? = typeof(StructValue).GetField(
            "explicitLayoutValue",
            BindingFlags.Instance | BindingFlags.NonPublic
        )
        Assert.NotNull(backing)
        Assert.True(backing!!.IsInitOnly)
    }

    shared {
        prop LayoutCases TheoryData[string] -> TheoryData[string]{
            "FullOverlap",
            "PartialOverlap",
            "DefaultNoOverlap",
            "Sequential",
            "ExplicitNoOverlap"
        }

        private func RunBareGsc(source string, directory string) string {
            let sourcePath = Path.Combine(directory, "probe.gs")
            File.WriteAllText(sourcePath, source)
            let (exitCode, stdout, stderr) = CaptureConsole(() -> GSharp.Compiler.Program.Main([]string{sourcePath}))
            Assert.True(exitCode == 0, (`bare gsc failed (` + "$exitCode" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return NormalizeValues(stdout)
        }

        private func RunGsi(source string, directory string) string {
            let sourcePath = Path.Combine(directory, "probe.gs")
            File.WriteAllText(sourcePath, source)
            let (exitCode, stdout, stderr) = CaptureConsole(() -> GSharp.Repl.Program.Main([]string{sourcePath}))
            Assert.True(exitCode == 0, (`gsi failed (` + "$exitCode" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return NormalizeValues(stdout)
        }

        private func RunEmitted(source string, layoutCase string, directory string) string {
            return RunEmitted(source, directory, (assemblyPath string) -> VerifyMetadata(assemblyPath, layoutCase))
        }

        private func RunEmitted(source string, directory string, verifyAssembly((string) -> void)? = nil) string {
            let sourcePath = Path.Combine(directory, "probe.gs")
            let outputPath = Path.Combine(directory, "Issue3100${Guid.NewGuid():N}.dll")
            File.WriteAllText(sourcePath, source)
            let (compileExit, stdout, stderr) = CaptureConsole(
                () -> GSharp
                    .Compiler
                    .Program
                    .Main([]string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath})
            )
            Assert.True(compileExit == 0, (`emit failed (` + "$compileExit" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            verifyAssembly?(outputPath)
            let result = DotnetProcess.Run(directory, outputPath)
            Assert.True(result.ExitCode == 0, (`emitted program failed (` + "${result.ExitCode}" + `)
stdout:
` + "${result.StandardOutput}" + `
stderr:
` + "${result.StandardError}"))
            return NormalizeValues(result.StandardOutput)
        }

        private func RunDiagnostic(source string, directory string, run(string) -> int32)(
            SourcePath string,
            Output string
        ) {
            let sourcePath = Path.Combine(directory, "probe.gs")
            File.WriteAllText(sourcePath, source)
            let (exitCode, stdout, stderr) = CaptureConsole(() -> run(sourcePath))
            Assert.True(exitCode == 1, (`expected diagnostic exit 1, got ` + "$exitCode" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return (sourcePath, stdout + stderr)
        }

        private func AssertGs0518AcrossEmittedDrivers(
            source string,
            name string,
            line int32 = 8,
            startColumn int32 = 25,
            endColumn int32 = 29,
            reason string = "it overlaps non-reference field 'Bits'"
        ) {
            let root = CreateEmptyDirectory(name)
            try {
                let bare = RunDiagnostic(
                    source,
                    CreateEmptyDirectory(root, "bare"),
                    (path string) -> GSharp.Compiler.Program.Main([]string{path})
                )
                let emitted = RunDiagnostic(
                    source,
                    CreateEmptyDirectory(root, "emit"),
                    (path string) -> GSharp
                        .Compiler
                        .Program
                        .Main([]string{"/out:" + Path.Combine(root, "emit", "probe.dll"), path})
                )
                let gsi = RunDiagnostic(
                    source,
                    CreateEmptyDirectory(root, "gsi"),
                    (path string) -> GSharp.Repl.Program.Main([]string{path})
                )
                AssertGs0518(bare.SourcePath, bare.Output, line, startColumn, endColumn, reason)
                AssertGs0518(emitted.SourcePath, emitted.Output, line, startColumn, endColumn, reason)
                AssertGs0518(gsi.SourcePath, gsi.Output, line, startColumn, endColumn, reason)
            } finally {
                Directory.Delete(root, recursive: true)
            }
        }

        private func AssertGs0518(
            sourcePath string,
            output string,
            line int32,
            startColumn int32,
            endColumn int32,
            reason string
        ) {
            Assert.Contains("$sourcePath($line,$startColumn,$line,$endColumn)", output, StringComparison.Ordinal)
            Assert.Contains("GS0518", output, StringComparison.Ordinal)
            Assert.Contains("reference-typed field 'Text'", output, StringComparison.Ordinal)
            Assert.Contains(reason, output, StringComparison.Ordinal)
            Assert.DoesNotContain("GSharpLayout_", output, StringComparison.Ordinal)
            Assert.DoesNotContain("GSharp.Interpreter.Layouts", output, StringComparison.Ordinal)
        }

        private func VerifyMetadata(assemblyPath string, layoutCase string) {
            CollectibleAssembly.Inspect(
                assemblyPath,
                (assembly Assembly) -> {
                    let types = assembly.GetTypes()
                    let cell = types.Single((t Type) -> t.Name == "Cell")
                    let wrapper = types.Single((t Type) -> t.Name == "Wrapper")
                    let expectedLayout = if layoutCase == "FullOverlap" ||
                        layoutCase == "PartialOverlap" ||
                        layoutCase == "ExplicitNoOverlap" {
                        LayoutKind.Explicit
                    } else {
                        LayoutKind.Sequential
                    }
                    Assert.Equal(expectedLayout, cell.StructLayoutAttribute?.Value)
                    Assert.Equal(LayoutKind.Sequential, wrapper.StructLayoutAttribute?.Value)
                    Assert.Equal(0, Marshal.OffsetOf(wrapper, "Value").ToInt32())
                    Assert.Equal(0, Marshal.OffsetOf(cell, "Nested").ToInt32())
                    Assert.Equal(
                        switch layoutCase {
                            case "FullOverlap": 0
                            case "PartialOverlap": 1
                            default: 4
                        },
                        Marshal.OffsetOf(cell, "Alias").ToInt32()
                    )
                }
            )
        }

        private func CaptureConsole(action() -> int32)(ExitCode int32, Stdout string, Stderr string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                return (action(), stdout.ToString(), stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func NormalizeValues(output string) string -> string.Join(
            "\n",
            output
                .ReplaceLineEndings(Environment.NewLine)
                .Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
                .Where((line string) -> line != "Success.")
        )

        private func CreateEmptyDirectory(name string) string {
            let parent = Path.Combine(AppContext.BaseDirectory, "issue3100-probes")
            return CreateEmptyDirectory(parent, "$name-${Guid.NewGuid():N}")
        }

        private func CreateEmptyDirectory(parent string, name string) string {
            let path = Path.Combine(parent, name)
            Directory.CreateDirectory(path)
            Assert.Empty(Directory.EnumerateFileSystemEntries(path))
            return path
        }

        private func SourceFor(layoutCase string) string {
            let package_ = "Issue3100$layoutCase"
            return switch layoutCase {
                case "FullOverlap": (`package ` + "$package_" + `
import System
import System.Runtime.InteropServices

struct Payload { var Value int32 }
@StructLayout(LayoutKind.Explicit, Size: 4)
struct Cell {
    @FieldOffset(0) var Nested Payload
    @FieldOffset(0) var Alias int32
}
struct Wrapper { var Value Cell }
func setAlias(ref value int32) { value = 44 }

var cell = Cell{Nested: Payload{Value: 1}, Alias: 2}
Console.WriteLine(cell.Nested.Value)
cell.Nested.Value = 11
Console.WriteLine(cell.Alias)
cell.Alias = 22
Console.WriteLine(cell.Nested.Value)
var wrapper = Wrapper{Value: Cell{Nested: Payload{Value: 3}, Alias: 4}}
wrapper.Value.Nested.Value = 33
Console.WriteLine(wrapper.Value.Alias)
setAlias(ref wrapper.Value.Alias)
Console.WriteLine(wrapper.Value.Nested.Value)
Console.WriteLine(wrapper.Value.Alias)`)
                case "PartialOverlap": (`package ` + "$package_" + `
import System
import System.Runtime.InteropServices

struct Payload { var Head uint8 var Value uint8 var Tail uint8 }
@StructLayout(LayoutKind.Explicit, Size: 4)
struct Cell {
    @FieldOffset(0) var Nested Payload
    @FieldOffset(1) var Alias uint16
}
struct Wrapper { var Value Cell }
func setAlias(ref value uint16) { value = 44 }

var cell = Cell{Nested: Payload{Head: 0, Value: 1, Tail: 0}, Alias: 2}
Console.WriteLine(cell.Nested.Value)
cell.Nested.Value = 11
Console.WriteLine(cell.Alias)
cell.Alias = 22
Console.WriteLine(cell.Nested.Value)
var wrapper = Wrapper{Value: Cell{Nested: Payload{Head: 0, Value: 3, Tail: 0}, Alias: 4}}
wrapper.Value.Nested.Value = 33
Console.WriteLine(wrapper.Value.Alias)
setAlias(ref wrapper.Value.Alias)
Console.WriteLine(wrapper.Value.Nested.Value)
Console.WriteLine(wrapper.Value.Alias)`)
                case "DefaultNoOverlap": NonOverlappingSource(package_, nil)
                case "Sequential": NonOverlappingSource(package_, "@StructLayout(LayoutKind.Sequential)")
                case "ExplicitNoOverlap": NonOverlappingSource(package_, "@StructLayout(LayoutKind.Explicit, Size: 8)")
                default: throw ArgumentOutOfRangeException("layoutCase")
            }
        }

        private func NonOverlappingSource($package string, layoutAttribute string?) string {
            let fields = if layoutAttribute?.Contains("Explicit", StringComparison.Ordinal) == true {
                "    @FieldOffset(0) var Nested Payload\n    @FieldOffset(4) var Alias int32"
            } else {
                "    var Nested Payload\n    var Alias int32"
            }
            let attribute = if layoutAttribute == nil {
                string.Empty
            } else {
                layoutAttribute + "\n"
            }
            return (`package ` + "$$package" + `
import System
import System.Runtime.InteropServices

struct Payload { var Value int32 }
` + "$attribute" + `struct Cell {
` + "$fields" + `
}
struct Wrapper { var Value Cell }
func setAlias(ref value int32) { value = 44 }

var cell = Cell{Nested: Payload{Value: 1}, Alias: 2}
Console.WriteLine(cell.Nested.Value)
cell.Nested.Value = 11
Console.WriteLine(cell.Nested.Value)
cell.Alias = 22
Console.WriteLine(cell.Alias)
var wrapper = Wrapper{Value: Cell{Nested: Payload{Value: 3}, Alias: 4}}
wrapper.Value.Nested.Value = 33
Console.WriteLine(wrapper.Value.Nested.Value)
setAlias(ref wrapper.Value.Alias)
Console.WriteLine(wrapper.Value.Nested.Value)
Console.WriteLine(wrapper.Value.Alias)`)
        }

        private func ReferenceLayoutCorpusSource() string -> `package Issue3115Corpus
import System
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Explicit, Size: 16)
struct RefAndPrimitive {
    @FieldOffset(0) var Text string
    @FieldOffset(8) var Bits int64
}

@StructLayout(LayoutKind.Explicit, Size: 8)
struct RefAlias {
    @FieldOffset(0) var Text string
    @FieldOffset(0) var Any object
}

@StructLayout(LayoutKind.Sequential)
struct SequentialControl {
    var Text string
    var Bits int64
}

@StructLayout(LayoutKind.Explicit, Size: 8)
struct PrimitiveUnion {
    @FieldOffset(0) var Low int32
    @FieldOffset(0) var Wide int64
}

@StructLayout(LayoutKind.Explicit, Size: 16)
struct RefAndValue {
    @FieldOffset(8) var Text string
    @FieldOffset(0) var Value Payload
}
struct Payload { var Value int64 }

var separated = RefAndPrimitive{Text: "A", Bits: 11L}
Console.WriteLine(separated.Text)
Console.WriteLine(separated.Bits)
var references = RefAlias{Text: "B", Any: "C"}
Console.WriteLine(references.Text)
var sequential = SequentialControl{Text: "D", Bits: 22L}
Console.WriteLine(sequential.Text)
Console.WriteLine(sequential.Bits)
var primitive = PrimitiveUnion{Low: 0, Wide: 33L}
primitive.Low = 44
Console.WriteLine(primitive.Wide)
var nested = RefAndValue{Text: "E", Value: Payload{Value: 55L}}
Console.WriteLine(nested.Text)
Console.WriteLine(nested.Value.Value)`
    }
}
