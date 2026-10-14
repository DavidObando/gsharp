// <copyright file="Issue3099TypeArgumentReificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Compiler
import GSharp.Repl
import GSharp.Repl.Engine
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Text.RegularExpressions
import Xunit

/// Issue #3099: emitted generic backing types must preserve every
/// G# type-argument kind instead of erasing value types to (cref:object).
/// Issue #3137 extends the same emit-oracle matrix to reflected field shape.
/// Issue #3180 covers enclosing generic parameters in the interactive emitted
/// engine; ADR-0156 file drivers remain compared against explicit and interactive
/// emitted hosts. Issue #3255 covers composite types in enclosing generic arguments.
@Collection("ConsoleIo")
open class Issue3099TypeArgumentReificationTests {
    @Fact
    func CompositeEnclosingTypeArguments_ReifyAcrossEmittedHosts() {
        const Source = `package Issue3255
import System

class Box[T] {
}

class Owner[T] {
    class Payload[U] {
    }
}

func Reify[T]() {
    let channelValue = Box[Owner[chan[T]].Payload[string]]()
    let channelType = channelValue.GetType().GenericTypeArguments[0].GenericTypeArguments[0]
    Console.WriteLine("chan:" + channelType.GetGenericTypeDefinition().FullName)
    Console.WriteLine("chan-arg:" + channelType.GenericTypeArguments[0].FullName)

    let sequenceValue = Box[Owner[sequence[T]].Payload[string]]()
    let sequenceType = sequenceValue.GetType().GenericTypeArguments[0].GenericTypeArguments[0]
    Console.WriteLine("sequence:" + sequenceType.GetGenericTypeDefinition().FullName)
    Console.WriteLine("sequence-arg:" + sequenceType.GenericTypeArguments[0].FullName)

    let mapValue = Box[Owner[map[string,T]].Payload[string]]()
    let mapType = mapValue.GetType().GenericTypeArguments[0].GenericTypeArguments[0]
    Console.WriteLine("map:" + mapType.GetGenericTypeDefinition().FullName)
    Console.WriteLine("map-key:" + mapType.GenericTypeArguments[0].FullName)
    Console.WriteLine("map-value:" + mapType.GenericTypeArguments[1].FullName)

    let asyncSequenceValue = Box[Owner[async sequence[T]].Payload[string]]()
    let asyncSequenceType = asyncSequenceValue.GetType().GenericTypeArguments[0].GenericTypeArguments[0]
    Console.WriteLine("async-sequence:" + asyncSequenceType.GetGenericTypeDefinition().FullName)
    Console.WriteLine("async-sequence-arg:" + asyncSequenceType.GenericTypeArguments[0].FullName)

    let deepValue = Box[Owner[map[string,sequence[chan[T]]]].Payload[string]]()
    let deepMap = deepValue.GetType().GenericTypeArguments[0].GenericTypeArguments[0]
    let deepSequence = deepMap.GenericTypeArguments[1]
    let deepChannel = deepSequence.GenericTypeArguments[0]
    Console.WriteLine("deep-map:" + deepMap.GetGenericTypeDefinition().FullName)
    Console.WriteLine("deep-sequence:" + deepSequence.GetGenericTypeDefinition().FullName)
    Console.WriteLine("deep-channel:" + deepChannel.GetGenericTypeDefinition().FullName)
    Console.WriteLine("deep-arg:" + deepChannel.GenericTypeArguments[0].FullName)
}

Reify[int32]()`
        let Expected = "chan:System.Threading.Channels.Channel`1${Environment.NewLine}" +
            "chan-arg:System.Int32${Environment.NewLine}" +
            "sequence:System.Collections.Generic.IEnumerable`1${Environment.NewLine}" +
            "sequence-arg:System.Int32${Environment.NewLine}" +
            "map:System.Collections.Generic.Dictionary`2${Environment.NewLine}" +
            "map-key:System.String${Environment.NewLine}" +
            "map-value:System.Int32${Environment.NewLine}" +
            "async-sequence:System.Collections.Generic.IAsyncEnumerable`1${Environment.NewLine}" +
            "async-sequence-arg:System.Int32${Environment.NewLine}" +
            "deep-map:System.Collections.Generic.Dictionary`2${Environment.NewLine}" +
            "deep-sequence:System.Collections.Generic.IEnumerable`1${Environment.NewLine}" +
            "deep-channel:System.Threading.Channels.Channel`1${Environment.NewLine}" +
            "deep-arg:System.Int32${Environment.NewLine}"
        let root = Path.Combine(GetRepositoryRoot(), "out", "test-artifacts", "issue3255-${Guid.NewGuid():N}")
        try {
            let compiler = RunSourceDriver(Path.Combine(root, "gsc"), Source, GSharp.Compiler.Program.Main)
            let gsi = RunSourceDriver(Path.Combine(root, "gsi"), Source, GSharp.Repl.Program.Main)
            let interactive = RunInteractiveEmit(Source)
            Assert.Equal(Expected + "Success.${Environment.NewLine}", compiler)
            Assert.Equal(Expected, gsi)
            Assert.Equal(Expected, interactive)
        } finally {
            if Directory.Exists(root) {
                Directory.Delete(root, recursive: true)
            }
        }
    }

    @Fact
    func LegacyFunctionEnclosingTypeArgument_CompilesAndRuns() {
        const Source = `package Issue3255LegacyFunction
import System
class Box[T] {}
class Owner[T] { class Payload[U] {} }
func Reify() {
    let value = Box[Owner[func(int32) int32].Payload[string]]()
    let functionType = value.GetType().GenericTypeArguments[0].GenericTypeArguments[0]
    Console.WriteLine("func:" + functionType.GetGenericTypeDefinition().FullName)
    Console.WriteLine("func-arg:" + functionType.GenericTypeArguments[0].FullName)
    Console.WriteLine("func-return:" + functionType.GenericTypeArguments[1].FullName)
}
Reify()`
        let root = Path.Combine(
            GetRepositoryRoot(),
            "out",
            "test-artifacts",
            "issue3255-legacy-function-${Guid.NewGuid():N}"
        )
        try {
            let output = RunSourceDriver(root, Source, GSharp.Compiler.Program.Main)
            Assert.Contains(
                "func:System.Func`2${Environment.NewLine}func-arg:System.Int32${Environment.NewLine}func-return:System.Int32${Environment.NewLine}",
                output,
                StringComparison.Ordinal
            )
            Assert.Contains("warning GS0303:", output, StringComparison.Ordinal)
            Assert.EndsWith("Success.${Environment.NewLine}", output, StringComparison.Ordinal)
        } finally {
            if Directory.Exists(root) {
                Directory.Delete(root, recursive: true)
            }
        }
    }

    @Fact
    func PointerEnclosingTypeArgument_RemainsRejectedBeforeEmit() {
        const Source = `package Issue3255Pointer
class Box[T] {}
class Owner[T] { class Payload[U] {} }
func Reify[T]() {
    let value = Box[Owner[*int32].Payload[string]]()
}`
        let root = Path.Combine(GetRepositoryRoot(), "out", "test-artifacts", "issue3255-pointer-${Guid.NewGuid():N}")
        try {
            let probeDirectory = PrepareEmptyDirectory(root)
            let sourcePath = Path.Combine(probeDirectory, "Probe.gs")
            File.WriteAllText(sourcePath, Source)
            let result = CaptureDriverResult(() -> GSharp.Compiler.Program.Main([]string{sourcePath}))
            Assert.Equal(1, result.ExitCode)
            Assert.Contains(
                "(5,28,5,33): error GS0125: Variable 'int32' doesn't exist.",
                result.Stdout,
                StringComparison.Ordinal
            )
            Assert.DoesNotContain("GS9998", result.Stdout, StringComparison.Ordinal)
            Assert.DoesNotContain("Cannot encode", result.Stdout, StringComparison.Ordinal)
            Assert.Equal("Failed.${Environment.NewLine}", result.Stderr)
        } finally {
            if Directory.Exists(root) {
                Directory.Delete(root, recursive: true)
            }
        }
    }

    @Fact
    func ManagedFunctionPointerEnclosingTypeArgument_ReportsAnchoredDiagnostic() {
        const Source = `package Issue3255ManagedFunctionPointer
import System
class Box[T] {}
class Owner[T] { class Payload[U] {} }
unsafe func Reify[T]() {
    let value = Box[Owner[*func(int32) int32].Payload[string]]()
    let enclosing = value.GetType().GenericTypeArguments[0].GenericTypeArguments[0]
    Console.WriteLine(enclosing.FullName)
}
Reify[int32]()`
        let root = Path.Combine(
            GetRepositoryRoot(),
            "out",
            "test-artifacts",
            "issue3255-managed-function-pointer-${Guid.NewGuid():N}"
        )
        try {
            let probeDirectory = PrepareEmptyDirectory(root)
            let sourcePath = Path.Combine(probeDirectory, "Probe.gs")
            File.WriteAllText(sourcePath, Source)
            let result = CaptureDriverResult(() -> GSharp.Compiler.Program.Main([]string{sourcePath}))
            Assert.Equal(1, result.ExitCode)
            Assert.Contains(
                "(6,27,6,45): error GS0521: Pointer and function-pointer types cannot be used as generic type arguments.",
                result.Stdout,
                StringComparison.Ordinal
            )
            Assert.DoesNotContain("GS9998", result.Stdout, StringComparison.Ordinal)
            Assert.DoesNotContain("Cannot encode", result.Stdout, StringComparison.Ordinal)
            Assert.Equal("Failed.${Environment.NewLine}", result.Stderr)
        } finally {
            if Directory.Exists(root) {
                Directory.Delete(root, recursive: true)
            }
        }
    }

    @Theory
    @MemberData("TypeArgumentCases")
    func TypeArguments_AgreeAcrossEmittedHostsAndFileDrivers(caseName string, declaration string, typeArgument string) {
        let source = CreateSource(caseName, declaration, typeArgument)
        let root = Path.Combine(GetRepositoryRoot(), "out", "test-artifacts", "issue3099-$caseName-${Guid.NewGuid():N}")
        try {
            var gscScript = RunSourceDriver(Path.Combine(root, "gsc-script"), source, GSharp.Compiler.Program.Main)
            let successSuffix = "Success.${Environment.NewLine}"
            Assert.EndsWith(successSuffix, gscScript)
            gscScript = gscScript[.. ^successSuffix.Length]
            let gsiScript = RunSourceDriver(Path.Combine(root, "gsi"), source, GSharp.Repl.Program.Main)
            let interactiveEmit = RunInteractiveEmit(source)
            let emitDirectory = PrepareEmptyDirectory(Path.Combine(root, "gsc-emit"))
            let sourcePath = Path.Combine(emitDirectory, "Probe.gs")
            let assemblyPath = Path.Combine(emitDirectory, "Probe.dll")
            File.WriteAllText(sourcePath, source)
            let _ = CaptureDriver(
                () -> GSharp
                    .Compiler
                    .Program
                    .Main([]string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath})
            )
            let explicitEmit = CollectibleAssembly.Inspect(
                assemblyPath,
                (assembly Assembly) -> {
                    Assert.Contains(
                        assembly.GetTypes(),
                        (type Type) -> type.FullName?.EndsWith(".Box`1", StringComparison.Ordinal) == true
                    )
                    Assert.Contains(
                        assembly.GetTypes(),
                        (type Type) -> type.FullName?.EndsWith(".Pair`2", StringComparison.Ordinal) == true
                    )
                    let entryPoint = assembly.EntryPoint ??
                        throw InvalidOperationException("Emitted assembly has no entry point.")
                    return CaptureDriver(
                        () -> {
                            entryPoint.Invoke(
                                nil,
                                if entryPoint.GetParameters().Length == 0 {
                                    default([]?object)
                                } else {
                                    []object{Array.Empty[string]()}
                                }
                            )
                            return 0
                        }
                    )
                }
            )
            let expected = NormalizeGenericTypeNames(explicitEmit)
            let interactiveOutput = NormalizeGenericTypeNames(interactiveEmit)
            let gscOutput = NormalizeGenericTypeNames(gscScript)
            let gsiOutput = NormalizeGenericTypeNames(gsiScript)
            let controlShape = "44${Environment.NewLine}2|Eleven:System.Int32:True:False:False|TwentyTwo:System.String:False:False:False${Environment.NewLine}"
            Assert.Contains(controlShape, expected, StringComparison.Ordinal)
            Assert.Contains(controlShape, interactiveOutput, StringComparison.Ordinal)
            Assert.Contains(controlShape, gscOutput, StringComparison.Ordinal)
            Assert.Contains(controlShape, gsiOutput, StringComparison.Ordinal)
            Assert.Equal(expected, interactiveOutput)
            Assert.Equal(expected, gscOutput)
            Assert.Equal(expected, gsiOutput)
            Assert.Contains("11${Environment.NewLine}", expected)
            Assert.Contains("22${Environment.NewLine}", expected)
            Assert.Contains("33${Environment.NewLine}", expected)
        } finally {
            if Directory.Exists(root) {
                Directory.Delete(root, recursive: true)
            }
        }
    }

    private data struct DriverResult(ExitCode int32, Stdout string, Stderr string) : IEquatable[
        Issue3099TypeArgumentReificationTests.DriverResult
    ] { }

    shared {
        func TypeArgumentCases() sequence[[]object] {
            yield[]object{"class", `class Payload {
    let Eleven int32
    var TwentyTwo string
}`, "Payload"}
            yield[]object{"struct", `struct Payload {
    let Eleven int32
    var TwentyTwo string
}`, "Payload"}
            yield[]object{"enum", `enum Payload {
    Eleven = 11,
    TwentyTwo = 22,
    ThirtyThree = 33,
}`, "Payload"}
            yield[]object{"string", string.Empty, "string"}
            yield[]object{"nested-class", `class Owner {
    class Payload {
        let Eleven int32
        var TwentyTwo string
    }
}`, "Owner.Payload"}
            yield[]object{"nested-struct", `class Owner {
    struct Payload {
        let Eleven int32
        var TwentyTwo string
    }
}`, "Owner.Payload"}
            yield[]object{"generic-owner-nested-class", `class Owner[T] {
    class Payload {
        let Eleven T
        var TwentyTwo string
    }
}`, "Owner[int32].Payload"}
            yield[]object{"generic-owner-nested-struct", `class Owner[T] {
    struct Payload {
        let Eleven T
        var TwentyTwo string
    }
}`, "Owner[int32].Payload"}
            yield[]object{"generic-owner-multi-arity-nested", `class Owner[TFirst, TSecond] {
    class Payload {
        let Eleven TFirst
        var TwentyTwo TSecond
    }
}`, "Owner[int32, string].Payload"}
            yield[]object{"generic-owner-nested-generic", `class Owner[T] {
    class Payload[U] {
        let Eleven T
        var TwentyTwo U
    }
}`, "Owner[int32].Payload[string]"}
            yield[]object{"generic-owner-deep-nested", `class Owner[T] {
    class Middle[U] {
        class Payload {
            let Eleven T
            var TwentyTwo U
        }
    }
}`, "Owner[int32].Middle[string].Payload"}
            yield[]object{"gsharp-generic", `struct Payload[T] {
    let Value T
    var Imported List[T]
    var Slice []T
    var Nullable T?
    var Array [3]T
    shared {
        var Stat int32
    }
    const Kilo int32 = 1000
}`, "Payload[int32]"}
            yield[]object{"imported-generic", `struct Payload {
    let Eleven int32
    var TwentyTwo string
}`, "List[Payload]"}
            yield[]object{"nullable", `struct Payload {
    let Eleven int32
    var TwentyTwo string
}`, "Payload?"}
            yield[]object{"slice", `struct Payload {
    let Eleven int32
    var TwentyTwo string
}`, "[]Payload"}
            yield[]object{"array", `struct Payload {
    let Eleven int32
    var TwentyTwo string
}`, "[3]Payload"}
        }

        private func CreateSource(caseName string, declaration string, typeArgument string) string {
            const Template = `package Issue3099.__CASE__
import System
import System.Collections.Generic

__DECLARATION__

struct ReflectionControl {
    let Eleven int32
    var TwentyTwo string
}

class Box[T] : EventArgs {
}

class Pair[TFirst, TSecond] : EventArgs {
}

func FieldShape(t Type) string {
    var shape = t.GetFields().Length.ToString()
    for field in t.GetFields() {
        shape = shape + "|" + field.Name + ":" + field.FieldType.FullName + ":" + field.IsInitOnly.ToString() + ":" + field.IsStatic.ToString() + ":" + field.IsLiteral.ToString()
        if field.IsLiteral {
            shape = shape + ":" + field.GetRawConstantValue()!!.ToString()
        }
    }
    return shape
}

var single = Box[__TYPE__]()
Console.WriteLine(11)
Console.WriteLine(single.GetType().FullName)
Console.WriteLine(single.GetType().GenericTypeArguments[0].IsValueType)
Console.WriteLine(single.GetType().GenericTypeArguments[0].IsEnum)
Console.WriteLine(single.GetType().GenericTypeArguments[0].IsLayoutSequential)
Console.WriteLine(FieldShape(single.GetType().GenericTypeArguments[0]))
var multiple = Pair[__TYPE__, int32]()
Console.WriteLine(22)
Console.WriteLine(multiple.GetType().FullName)
Console.WriteLine(Object.ReferenceEquals(
    single.GetType().GenericTypeArguments[0],
    multiple.GetType().GenericTypeArguments[0]))
Console.WriteLine(FieldShape(multiple.GetType().GenericTypeArguments[0]))
Console.WriteLine(33)
var nested = Box[Box[__TYPE__]]()
Console.WriteLine(nested.GetType().FullName)
Console.WriteLine(FieldShape(nested.GetType().GenericTypeArguments[0].GenericTypeArguments[0]))
var control = Box[ReflectionControl]()
Console.WriteLine(44)
Console.WriteLine(FieldShape(control.GetType().GenericTypeArguments[0]))`
            return Template
                .Replace(
                "__CASE__",
                "Case" + caseName.Replace("-", string.Empty, StringComparison.Ordinal),
                StringComparison.Ordinal
            )
                .Replace("__DECLARATION__", declaration, StringComparison.Ordinal)
                .Replace("__TYPE__", typeArgument, StringComparison.Ordinal)
        }

        private func RunSourceDriver(directory string, source string, driver([]string) -> int32) string {
            let probeDirectory = PrepareEmptyDirectory(directory)
            let sourcePath = Path.Combine(probeDirectory, "Probe.gs")
            File.WriteAllText(sourcePath, source)
            return CaptureDriver(() -> driver([]string{sourcePath}))
        }

        private func RunInteractiveEmit(source string) string {
            // ADR-0156 Phase 3c (#3176): the interactive column runs on the
            // emitted submission-chaining engine.
            using let engine = EmittedSessionEngine(default(IReadOnlyList[string])){CaptureConsole = true}
            let cell = engine.Evaluate(source)
            Assert.False(cell.HasError, string.Join(Environment.NewLine, cell.Diagnostics))
            return cell.Output.ReplaceLineEndings(Environment.NewLine)
        }

        private func PrepareEmptyDirectory(directory string) string {
            Assert.False(Directory.Exists(directory), "probe directory already exists: $directory")
            Directory.CreateDirectory(directory)
            Assert.Empty(Directory.EnumerateFileSystemEntries(directory))
            return directory
        }

        private func CaptureDriver(driver() -> int32) string {
            let result = CaptureDriverResult(driver)
            Assert.True(result.ExitCode == 0, (`driver failed with exit ` + "${result.ExitCode}" + `
stdout:
` + "${result.Stdout}" + `
stderr:
` + "${result.Stderr}"))
            return result.Stdout
        }

        private func CaptureDriverResult(driver() -> int32) Issue3099TypeArgumentReificationTests.DriverResult {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exit int32
            try {
                exit = driver()
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return Issue3099TypeArgumentReificationTests.DriverResult(
                exit,
                stdout.ToString().ReplaceLineEndings(Environment.NewLine),
                stderr.ToString().ReplaceLineEndings(Environment.NewLine)
            )
        }

        private func NormalizeGenericTypeNames(output string) string {
            return Regex.Replace(
                output,
                ", [^,\\[\\]]+, Version=[^,\\[\\]]+, Culture=[^,\\[\\]]+, PublicKeyToken=[^,\\[\\]]+",
                string.Empty,
                RegexOptions.CultureInvariant
            )
        }

        private func GetRepositoryRoot() string {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil && !RepositoryRootMarker.IsRoot(directory.FullName) {
                directory = directory.Parent
            }
            return directory?.FullName ?? throw InvalidOperationException("Could not locate repository root.")
        }
    }
}
