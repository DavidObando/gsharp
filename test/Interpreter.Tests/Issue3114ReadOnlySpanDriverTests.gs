// <copyright file="Issue3114ReadOnlySpanDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis
import GSharp.Repl
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Reflection
import System.Reflection.Emit
import System.Runtime.CompilerServices
import Xunit

/// Driver coverage for issue #3114 read-only span samples; every driver path uses emitted execution.
@Collection("ConsoleIo")
open class Issue3114ReadOnlySpanDriverTests {
    enum Driver {
        CompilerEmitToMemory,
        CompilerEmitToFile,
        ReplEmitToMemory
    }

    @Theory
    @MemberData("SampleDriverCases")
    func ShippedSpanSample_MatchesGoldenAcrossDrivers(
        sample string,
        expected string,
        driver Issue3114ReadOnlySpanDriverTests.Driver
    ) {
        var expected = expected
        let sourcePath = Path.Combine(LocateSamplesDirectory(), sample)
        let root = Path.Combine(Environment.CurrentDirectory, ".issue3114-${Guid.NewGuid():N}")
        Directory.CreateDirectory(root)
        Assert.Empty(Directory.EnumerateFileSystemEntries(root))
        try {
            let result = switch driver {
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .CompilerEmitToMemory: CaptureConsole(() -> GSharp.Compiler.Program.Main([]string{sourcePath}))
                case Issue3114ReadOnlySpanDriverTests.Driver.CompilerEmitToFile: CompileAndRun(root, sample, sourcePath)
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .ReplEmitToMemory: CaptureConsole(() -> GSharp.Repl.Program.Main([]string{sourcePath}))
                default: throw InvalidOperationException("Unexpected driver $driver.")
            }
            Assert.Equal(0, result.ExitCode)
            expected = expected.Replace("\n", Environment.NewLine, StringComparison.Ordinal)
            Assert.Equal(
                if driver == Issue3114ReadOnlySpanDriverTests.Driver.CompilerEmitToMemory {
                    expected + "Success.${Environment.NewLine}"
                } else {
                    expected
                },
                result.StandardOutput
            )
            Assert.Equal(string.Empty, result.StandardError)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Theory
    @MemberData("Drivers")
    func SpanConversionMutationAndSlicing_AgreeAcrossDrivers(driver Issue3114ReadOnlySpanDriverTests.Driver) {
        const Source = `import System

func Main() {
    var values = []int32{11, 22, 33}
    var writable Span[int32] = values
    var readOnly ReadOnlySpan[int32] = writable
    writable[1] = 44
    var tail = readOnly.Slice(1)
    var window = tail.Slice(0, 2)
    var letters = []char{'a', 'b', 'c', 'd', 'e'}
    var writableChars Span[char] = letters
    var readOnlyChars ReadOnlySpan[char] = writableChars
    var charWindow = readOnlyChars.Slice(1, 3)
    Console.WriteLine(readOnly.Length)
    Console.WriteLine(readOnly[1])
    Console.WriteLine(window[1])
    Console.WriteLine(writable.ToString())
    Console.WriteLine(readOnly.ToString())
    Console.WriteLine(window.ToString())
    Console.WriteLine(writableChars.ToString())
    Console.WriteLine(readOnlyChars.ToString())
    Console.WriteLine(charWindow.ToString())
}`
        let root = Path.Combine(Environment.CurrentDirectory, ".issue3114-${Guid.NewGuid():N}")
        Directory.CreateDirectory(root)
        Assert.Empty(Directory.EnumerateFileSystemEntries(root))
        let sourcePath = Path.Combine(root, "span-operations.gs")
        File.WriteAllText(sourcePath, Source)
        try {
            let emitted = CompileAndRun(root, "span-operations.gs", sourcePath)
            Assert.Equal(
                "3${Environment.NewLine}44${Environment.NewLine}33${Environment.NewLine}System.Span<Int32>[3]${Environment.NewLine}System.ReadOnlySpan<Int32>[3]${Environment.NewLine}System.ReadOnlySpan<Int32>[2]${Environment.NewLine}abcde${Environment.NewLine}abcde${Environment.NewLine}bcd${Environment.NewLine}",
                emitted.StandardOutput
            )
            let result = switch driver {
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .CompilerEmitToMemory: CaptureConsole(() -> GSharp.Compiler.Program.Main([]string{sourcePath}))
                case Issue3114ReadOnlySpanDriverTests.Driver.CompilerEmitToFile: emitted
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .ReplEmitToMemory: CaptureConsole(() -> GSharp.Repl.Program.Main([]string{sourcePath}))
                default: throw InvalidOperationException("Unexpected driver $driver.")
            }
            Assert.Equal(0, result.ExitCode)
            Assert.Equal(
                if driver == Issue3114ReadOnlySpanDriverTests.Driver.CompilerEmitToMemory {
                    emitted.StandardOutput + "Success.${Environment.NewLine}"
                } else {
                    emitted.StandardOutput
                },
                result.StandardOutput
            )
            Assert.Equal(string.Empty, result.StandardError)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    /// #3183: emitted interpolation routes ByRefLike holes through their CLR
    /// `ToString()` method instead of closing generic
    /// `AppendFormatted<T>` over an unsupported type argument.
    /// @param driver The driver under test.
    @Theory
    @MemberData("Drivers")
    func SpanInterpolation_RendersAcrossFileDrivers(driver Issue3114ReadOnlySpanDriverTests.Driver) {
        const Source = `import System

func Main() {
    var values = []int32{11, 22, 33}
    var writable Span[int32] = values
    var readOnly ReadOnlySpan[int32] = writable
    var letters = []char{'h', 'e', 'l', 'l', 'o'}
    var writableChars Span[char] = letters
    var readOnlyChars ReadOnlySpan[char] = writableChars
    Console.WriteLine("writable=${writable}")
    Console.WriteLine("readonly=${readOnly}")
    Console.WriteLine("writableChars=${writableChars}")
    Console.WriteLine("chars=${readOnlyChars}")
    Console.WriteLine("aligned=${readOnlyChars,8}")
    Console.WriteLine("format=${readOnlyChars:X}")
    Console.WriteLine("alignedFormat=${readOnlyChars,8:X}")
    Console.WriteLine("left=${readOnlyChars,-8}")
}`
        let root = Path.Combine(Environment.CurrentDirectory, ".issue3114-${Guid.NewGuid():N}")
        Directory.CreateDirectory(root)
        Assert.Empty(Directory.EnumerateFileSystemEntries(root))
        let sourcePath = Path.Combine(root, "span-interpolation.gs")
        File.WriteAllText(sourcePath, Source)
        try {
            let result = switch driver {
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .CompilerEmitToMemory: CaptureConsole(() -> GSharp.Compiler.Program.Main([]string{sourcePath}))
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .CompilerEmitToFile: CompileAndRun(root, "span-interpolation.gs", sourcePath)
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .ReplEmitToMemory: CaptureConsole(() -> GSharp.Repl.Program.Main([]string{sourcePath}))
                default: throw InvalidOperationException("Unexpected driver $driver.")
            }
            Assert.Equal(0, result.ExitCode)
            Assert.Equal(
                if driver == Issue3114ReadOnlySpanDriverTests.Driver.CompilerEmitToMemory {
                    "writable=System.Span<Int32>[3]${Environment.NewLine}readonly=System.ReadOnlySpan<Int32>[3]${Environment.NewLine}writableChars=hello${Environment.NewLine}chars=hello${Environment.NewLine}aligned=   hello${Environment.NewLine}format=hello${Environment.NewLine}alignedFormat=   hello${Environment.NewLine}left=hello   ${Environment.NewLine}Success.${Environment.NewLine}"
                } else {
                    "writable=System.Span<Int32>[3]${Environment.NewLine}readonly=System.ReadOnlySpan<Int32>[3]${Environment.NewLine}writableChars=hello${Environment.NewLine}chars=hello${Environment.NewLine}aligned=   hello${Environment.NewLine}format=hello${Environment.NewLine}alignedFormat=   hello${Environment.NewLine}left=hello   ${Environment.NewLine}"
                },
                result.StandardOutput
            )
            Assert.Equal(string.Empty, result.StandardError)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Theory
    @MemberData("Drivers")
    func OrdinaryInterpolation_RemainsUnchangedAcrossFileDrivers(driver Issue3114ReadOnlySpanDriverTests.Driver) {
        const Source = `import System

func Main() {
    var value = 42
    Console.WriteLine("value=${value}")
}`
        let root = Path.Combine(Environment.CurrentDirectory, ".issue3183-${Guid.NewGuid():N}")
        Directory.CreateDirectory(root)
        Assert.Empty(Directory.EnumerateFileSystemEntries(root))
        let sourcePath = Path.Combine(root, "ordinary-interpolation.gs")
        File.WriteAllText(sourcePath, Source)
        try {
            let result = switch driver {
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .CompilerEmitToMemory: CaptureConsole(() -> GSharp.Compiler.Program.Main([]string{sourcePath}))
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .CompilerEmitToFile: CompileAndRun(root, "ordinary-interpolation.gs", sourcePath)
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .ReplEmitToMemory: CaptureConsole(() -> GSharp.Repl.Program.Main([]string{sourcePath}))
                default: throw InvalidOperationException("Unexpected driver $driver.")
            }
            Assert.Equal(0, result.ExitCode)
            Assert.Equal(
                if driver == Issue3114ReadOnlySpanDriverTests.Driver.CompilerEmitToMemory {
                    "value=42${Environment.NewLine}Success.${Environment.NewLine}"
                } else {
                    "value=42${Environment.NewLine}"
                },
                result.StandardOutput
            )
            Assert.Equal(string.Empty, result.StandardError)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Theory
    @MemberData("Drivers")
    func UserRefStructInterpolation_UsesDeclaredToStringAcrossFileDrivers(
        driver Issue3114ReadOnlySpanDriverTests.Driver
    ) {
        // ADR-0182 / issue #4240: a receiver-clause `ToString` on an owned
        // ref struct used to bind as an instance method (with a soft GS0314
        // warning steering authors to the in-body form) and was therefore
        // still usable by interpolation. It is unconditionally an extension
        // now — a real ToString override, and the only spelling
        // interpolation can use, requires the in-body form; see
        // ReceiverClauseToString_IsAnOrdinaryExtension_NotUsableByInterpolation
        // below for that (changed) behavior.
        const Source = `import System

ref struct InBodyToken {
    var value int32
    func ToString() string -> String.Format("InBody#{0}", value)
}

func Main() {
    var inBody InBodyToken = InBodyToken{value: 43}
    Console.WriteLine("inbody=${inBody}")
}`
        let Expected = "inbody=InBody#43${Environment.NewLine}"
        let root = Path.Combine(Environment.CurrentDirectory, ".issue3220-${Guid.NewGuid():N}")
        Directory.CreateDirectory(root)
        Assert.Empty(Directory.EnumerateFileSystemEntries(root))
        let sourcePath = Path.Combine(root, "user-ref-struct-tostring.gs")
        File.WriteAllText(sourcePath, Source)
        try {
            let result = switch driver {
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .CompilerEmitToMemory: CaptureConsole(() -> GSharp.Compiler.Program.Main([]string{sourcePath}))
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .CompilerEmitToFile: CompileAndRun(root, "user-ref-struct-tostring.gs", sourcePath)
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .ReplEmitToMemory: CaptureConsole(() -> GSharp.Repl.Program.Main([]string{sourcePath}))
                default: throw InvalidOperationException("Unexpected driver $driver.")
            }
            Assert.Equal(0, result.ExitCode)
            if driver == Issue3114ReadOnlySpanDriverTests.Driver.CompilerEmitToMemory {
                Assert.StartsWith(Expected, result.StandardOutput, StringComparison.Ordinal)
                Assert.EndsWith("Success.${Environment.NewLine}", result.StandardOutput, StringComparison.Ordinal)
                Assert.Equal(string.Empty, result.StandardError)
            } else {
                Assert.Equal(Expected, result.StandardOutput)
                Assert.Equal(string.Empty, result.StandardError)
            }
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    func ReceiverClauseToString_IsAnOrdinaryExtension_NotUsableByInterpolation() {
        // ADR-0182 / issue #4240: a receiver clause is unconditionally an
        // extension now, so `func (token ReceiverToken) ToString() ...` no
        // longer overrides the ref struct's real ToString — interpolation
        // (which needs the real instance member) reports GS0519, the same
        // diagnostic it reports for a ref struct with no ToString at all.
        const Source = `import System

ref struct ReceiverToken {
    var value int32
}

func (token ReceiverToken) ToString() string -> String.Format("Receiver#{0}", token.value)

func Main() {
    var receiver ReceiverToken = ReceiverToken{value: 42}
    Console.WriteLine("receiver=${receiver}")
}`
        let root = Path.Combine(Environment.CurrentDirectory, ".issue3220-${Guid.NewGuid():N}")
        Directory.CreateDirectory(root)
        let sourcePath = Path.Combine(root, "receiver-clause-tostring.gs")
        File.WriteAllText(sourcePath, Source)
        try {
            let result = CaptureConsole(() -> GSharp.Compiler.Program.Main([]string{sourcePath}))
            Assert.Equal(1, result.ExitCode)
            Assert.Contains("error GS0519:", result.StandardOutput, StringComparison.Ordinal)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    func ImportedRefStructInterpolation_WithOverloadedToString_CompilesAndRuns() {
        const Source = `import System
import Issue3220External

func Main() {
    let token ExtTok = ExtTok()
    Console.WriteLine("interp=${token}")
}`
        let root = Path.Combine(Environment.CurrentDirectory, ".issue3220-${Guid.NewGuid():N}")
        Directory.CreateDirectory(root)
        Assert.Empty(Directory.EnumerateFileSystemEntries(root))
        let referencePath = Path.Combine(root, "Issue3220.External.dll")
        let sourcePath = Path.Combine(root, "imported-overloaded-tostring.gs")
        EmitOverloadedToStringRefStructAssembly(referencePath)
        File.WriteAllText(sourcePath, Source)
        try {
            let result = CompileAndRun(root, "imported-overloaded-tostring.gs", sourcePath, referencePath)
            Assert.Equal(0, result.ExitCode)
            Assert.Equal("interp=ExtTok!${Environment.NewLine}", result.StandardOutput)
            Assert.Equal(string.Empty, result.StandardError)
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Theory
    @MemberData("Drivers")
    func UserRefStructInterpolation_WithoutDeclaredToStringReportsGS0519AcrossFileDrivers(
        driver Issue3114ReadOnlySpanDriverTests.Driver
    ) {
        const Source = `ref struct Token {
    var value int32
}

func Main() {
    var token Token = Token{value: 42}
    Console.WriteLine("token=${token}")
}`
        let root = Path.Combine(Environment.CurrentDirectory, ".issue3183-${Guid.NewGuid():N}")
        Directory.CreateDirectory(root)
        Assert.Empty(Directory.EnumerateFileSystemEntries(root))
        let sourcePath = Path.Combine(root, "user-ref-struct-interpolation.gs")
        File.WriteAllText(sourcePath, Source)
        try {
            let result = switch driver {
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .CompilerEmitToMemory: CaptureConsole(() -> GSharp.Compiler.Program.Main([]string{sourcePath}))
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .CompilerEmitToFile: CompileOnly(root, "user-ref-struct-interpolation.gs", sourcePath)
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .ReplEmitToMemory: CaptureConsole(() -> GSharp.Repl.Program.Main([]string{sourcePath}))
                default: throw InvalidOperationException("Unexpected driver $driver.")
            }
            Assert.Equal(1, result.ExitCode)
            let diagnosticStream = if driver == Issue3114ReadOnlySpanDriverTests.Driver.ReplEmitToMemory {
                result.StandardError
            } else {
                result.StandardOutput
            }
            Assert.Equal(
                if driver == Issue3114ReadOnlySpanDriverTests.Driver.ReplEmitToMemory {
                    string.Empty
                } else {
                    "Failed.${Environment.NewLine}"
                },
                if driver == Issue3114ReadOnlySpanDriverTests.Driver.ReplEmitToMemory {
                    result.StandardOutput
                } else {
                    result.StandardError
                }
            )
            let diagnostic = Assert.Single(
                diagnosticStream.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries),
                (line string) -> line.Contains("error GS0519:", StringComparison.Ordinal)
            )
            AssertByRefLikeInterpolationDiagnostic(diagnostic, sourcePath, 7, "Token")
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Theory
    @MemberData("Drivers")
    func UserRefStructInterpolation_WithoutParameterlessToStringReportsGS0519AcrossFileDrivers(
        driver Issue3114ReadOnlySpanDriverTests.Driver
    ) {
        const Source = `import System

ref struct Token {
    func ToString(value int32) string -> String.Format("Token#{0}", value)
}

func Main() {
    let token Token = Token{}
    Console.WriteLine("interp=${token}")
}`
        let root = Path.Combine(Environment.CurrentDirectory, ".issue3220-${Guid.NewGuid():N}")
        Directory.CreateDirectory(root)
        Assert.Empty(Directory.EnumerateFileSystemEntries(root))
        let sourcePath = Path.Combine(root, "user-ref-struct-arity-interpolation.gs")
        File.WriteAllText(sourcePath, Source)
        try {
            let result = switch driver {
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .CompilerEmitToMemory: CaptureConsole(() -> GSharp.Compiler.Program.Main([]string{sourcePath}))
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .CompilerEmitToFile: CompileOnly(root, "user-ref-struct-arity-interpolation.gs", sourcePath)
                case Issue3114ReadOnlySpanDriverTests
                    .Driver
                    .ReplEmitToMemory: CaptureConsole(() -> GSharp.Repl.Program.Main([]string{sourcePath}))
                default: throw InvalidOperationException("Unexpected driver $driver.")
            }
            Assert.Equal(1, result.ExitCode)
            let diagnosticStream = if driver == Issue3114ReadOnlySpanDriverTests.Driver.ReplEmitToMemory {
                result.StandardError
            } else {
                result.StandardOutput
            }
            Assert.Equal(
                if driver == Issue3114ReadOnlySpanDriverTests.Driver.ReplEmitToMemory {
                    string.Empty
                } else {
                    "Failed.${Environment.NewLine}"
                },
                if driver == Issue3114ReadOnlySpanDriverTests.Driver.ReplEmitToMemory {
                    result.StandardOutput
                } else {
                    result.StandardError
                }
            )
            let boundDiagnostic = Assert.Single(
                EmittedOracle.Evaluate(Source).Diagnostics,
                (item GSharp.Core.CodeAnalysis.Diagnostic) -> item.Id == "GS0519"
            )
            var location = boundDiagnostic.Location
            Assert.Equal(
                (Span: "(9,33,9,38)", Text: "token"),
                (
                    Span: "(${location.StartLine + 1},${location.StartCharacter + 1},${location.EndLine + 1},${location.EndCharacter + 1})",
                    Text: location.Text!!.ToString(location.Span)
                )
            )
            let diagnostic = Assert.Single(
                diagnosticStream.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries),
                (line string) -> line.Contains("error GS0519:", StringComparison.Ordinal)
            )
            Assert.StartsWith("$sourcePath(9,33,9,38): error GS0519:", diagnostic, StringComparison.Ordinal)
            AssertByRefLikeInterpolationDiagnostic(diagnostic, sourcePath, 9, "Token")
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    shared {
        func SampleDriverCases() sequence[[]object] {
            for (sample, expected) in[](string, string){("SpanComprehensive.gs", `60
10
2
`), ("RefStructGenericField.gs", "3\n"), ("SpanIndexing.gs", `60
402
`)} {
                for driver in Enum.GetValues[Issue3114ReadOnlySpanDriverTests.Driver]() {
                    yield[]object{sample, expected, driver}
                }
            }
        }

        func Drivers() sequence[[]object] {
            for driver in Enum.GetValues[Issue3114ReadOnlySpanDriverTests.Driver]() {
                yield[]object{driver}
            }
        }

        private func AssertByRefLikeInterpolationDiagnostic(
            line string,
            sourcePath string,
            startLine int32,
            typeName string
        ) {
            Assert.StartsWith("$sourcePath($startLine,", line, StringComparison.Ordinal)
            Assert.Contains(": error GS0519:", line, StringComparison.Ordinal)
            Assert.Contains(typeName, line, StringComparison.Ordinal)
            Assert.Contains("has no usable parameterless ToString method", line, StringComparison.Ordinal)
        }

        private func CompileOnly(root string, sample string, sourcePath string)(
            ExitCode int32,
            StandardOutput string,
            StandardError string
        ) {
            let outputDirectory = Path.Combine(root, "emit")
            Directory.CreateDirectory(outputDirectory)
            Assert.Empty(Directory.EnumerateFileSystemEntries(outputDirectory))
            let assemblyPath = Path.Combine(outputDirectory, Path.GetFileNameWithoutExtension(sample) + ".dll")
            return CaptureConsole(
                () -> GSharp
                    .Compiler
                    .Program
                    .Main([]string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath})
            )
        }

        private func CompileAndRun(root string, sample string, sourcePath string, referencePath string? = nil)(
            ExitCode int32,
            StandardOutput string,
            StandardError string
        ) {
            let outputDirectory = Path.Combine(root, "emit")
            Directory.CreateDirectory(outputDirectory)
            Assert.Empty(Directory.EnumerateFileSystemEntries(outputDirectory))
            let assemblyPath = Path.Combine(outputDirectory, Path.GetFileNameWithoutExtension(sample) + ".dll")
            let arguments = List[string]{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0"}
            if referencePath != nil {
                arguments.Add("/r:" + referencePath)
            }
            arguments.Add(sourcePath)
            let compile = CaptureConsole(() -> GSharp.Compiler.Program.Main(arguments.ToArray()))
            Assert.Equal(0, compile.ExitCode)
            Assert.True(File.Exists(assemblyPath), compile.StandardOutput + compile.StandardError)
            CollectibleAssembly.Inspect(assemblyPath, (assembly Assembly) -> Assert.NotEmpty(assembly.GetTypes()))
            if referencePath != nil {
                File.Copy(referencePath, Path.Combine(outputDirectory, Path.GetFileName(referencePath)))
            }
            let result = DotnetProcess.Run(outputDirectory, assemblyPath)
            return (
                result.ExitCode,
                result.StandardOutput.ReplaceLineEndings(Environment.NewLine),
                result.StandardError.ReplaceLineEndings(Environment.NewLine)
            )
        }

        private func EmitOverloadedToStringRefStructAssembly(outputPath string) {
            let builder = PersistedAssemblyBuilder(AssemblyName("Issue3220.External"), typeof(object).Assembly)
            let module = builder.DefineDynamicModule("Issue3220.External")
            let type = module.DefineType(
                "Issue3220External.ExtTok",
                TypeAttributes.Public | TypeAttributes.Sealed | TypeAttributes.SequentialLayout,
                typeof(ValueType)
            )
            type.SetCustomAttribute(
                CustomAttributeBuilder(
                    typeof(IsByRefLikeAttribute).GetConstructor(Type.EmptyTypes)!!,
                    System.Array.Empty[object?]()
                )
            )
            let parameterless = type.DefineMethod(
                "ToString",
                MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.HideBySig,
                typeof(string),
                Type.EmptyTypes
            )
            var il = parameterless.GetILGenerator()
            il.Emit(OpCodes.Ldstr, "ExtTok!")
            il.Emit(OpCodes.Ret)
            type.DefineMethodOverride(parameterless, typeof(object).GetMethod("ToString", Type.EmptyTypes)!!)
            let overload = type.DefineMethod(
                "ToString",
                MethodAttributes.Public | MethodAttributes.HideBySig,
                typeof(string),
                []Type{typeof(string)}
            )
            il = overload.GetILGenerator()
            il.Emit(OpCodes.Ldstr, "unused")
            il.Emit(OpCodes.Ret)
            type.CreateType()
            builder.Save(outputPath)
        }

        private func CaptureConsole(action() -> int32)(ExitCode int32, StandardOutput string, StandardError string) {
            using let output = StringWriter()
            using let error = StringWriter()
            let previousOutput = Console.Out
            let previousError = Console.Error
            Console.SetOut(output)
            Console.SetError(error)
            try {
                return (
                    action(),
                    output.ToString().ReplaceLineEndings(Environment.NewLine),
                    error.ToString().ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                Console.SetOut(previousOutput)
                Console.SetError(previousError)
            }
        }

        private func LocateSamplesDirectory() string {
            var directory DirectoryInfo? = DirectoryInfo(Environment.CurrentDirectory)
            while directory != nil {
                let samples = Path.Combine(directory.FullName, "samples")
                if Directory.Exists(samples) && RepositoryRootMarker.IsRoot(directory.FullName) {
                    return samples
                }
                directory = directory.Parent
            }
            throw DirectoryNotFoundException("Could not locate the samples directory.")
        }
    }
}
