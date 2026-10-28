// <copyright file="Issue3956NamedTupleGenericArgumentIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.Emit
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Text
import System.Text.RegularExpressions
import Xunit

/// Issue #3956 / ADR-0172: tuple element names are metadata over the positional
/// shape, so a generic instantiation recovered from a CLR signature
/// (`KeyValuePair<string, ValueTuple<…>>`) and the same
/// instantiation written in G# with element NAMES are one and the same type.
/// The binder classifies the conversion between them as identity; the emitter
/// used to key its identity fast path on symbol REFERENCE equality alone and
/// fell through every structural arm to a `NotSupportedException`.
///
/// The names sit two levels deep — inside a `List`, inside a tuple,
/// inside a `KeyValuePair` — so a top-level-only fix does not pass these.
/// Every case COMPILES, ILVERIFIES and EXECUTES: an emitter defect of this kind
/// can bind clean and still produce a body the verifier or the runtime
/// rejects.
class Issue3956NamedTupleGenericArgumentIdentityTests {
    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func ImportedSymbolicValueTuple_IdentityPreservesContractsAndStorage(referenceAssembly bool, platform bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let references = ReferenceResolver
            .HostTrustedPlatformAssemblyPaths()
            .Where(
            (path string) -> Path.GetDirectoryName(path) == Path.GetDirectoryName(typeof(object).Assembly.Location)
        )
            .OrderBy((path string) -> path, StringComparer.Ordinal)
            .ToArray()
        Assert.NotEmpty(references)
        let contract = Path.Combine(fixture.Directory, "TupleAssessment.dll")
        let contractReference = Path.Combine(fixture.Directory, "TupleAssessment.ref.dll")
        let producer = CSharpCompilation.Create(
            "TupleAssessment",
            []SyntaxTree{CSharpSyntaxTree.ParseText(TupleProducer)},
            references.Select((path string) -> MetadataReference.CreateFromFile(path)),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, deterministic: true)
        )
        {
            using let implementation = File.Create(contract)
            let result = producer.Emit(implementation)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
        {
            using let reference = File.Create(contractReference)
            let result = producer.Emit(
                reference,
                options: EmitOptions(metadataOnly: true, includePrivateMembers: false)
            )
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
        let selected = if referenceAssembly {
            contractReference
        } else {
            contract
        }
        let method = if platform {
            "Create"
        } else {
            "Ordinary"
        }
        let source = `package TupleAssessmentUser5413
import System
import TupleAssessment5413
public class C {}
public class Exports { shared {
public func Lift(value C) IView[string?, (C, int32)] {
let view = TupleMaker[C].` + method + `(value)
return view
}
public func Unchanged(value IView[string?, System.ValueTuple[C, int32]]) IView[string?, (C, int32)] -> value
} }
let value = C()
let view = Exports.Unchanged(Exports.Lift(value))
Console.WriteLine(view.First ?? "<nil>")
Console.WriteLine(Object.ReferenceEquals(value, view.Second.Item1))
var copy System.ValueTuple[C, int32] = view.Second
copy.Item2 = 99
Console.WriteLine(copy.Item2)
Console.WriteLine(view.Second.Item2)
Console.WriteLine(Api.Calls)
`
        let image = CompileTupleDriver(fixture.Directory, "Safe", source, selected, references, nil)
        let verification = List[string]{"tool", "run", "ilverify", "--", image, "-s", "System.Private.CoreLib"}
        for path in references.Concat([]string{contract}) {
            verification.Add("-r")
            verification.Add(path)
        }
        let verified = RunTupleDriver(verification)
        Assert.True(verified.Code == 0, Encoding.UTF8.GetString(verified.Output) + verified.Error)
        Assert.Empty(verified.Error)
        let executed = RunTupleDriver([]string{image})
        Assert.Equal(0, executed.Code)
        Assert.Empty(executed.Error)
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                (
                    (
                        if platform {
                            "<nil>"
                        } else {
                            "ordinary"
                        }
                    ) +
                        "\nTrue\n99\n42\n1\n"
                ).ReplaceLineEndings(Environment.NewLine)
            ),
            executed.Output
        )
        let assembly = EmittedFixture.LoadTogether(contract, image)[1]
        let exports = assembly.GetType("TupleAssessmentUser5413.Exports", throwOnError: true)!!
        let lift = exports.GetMethod("Lift")!!
        let element = assembly.GetType("TupleAssessmentUser5413.C", throwOnError: true)!!
        Assert.Equal(
            typeof(ValueTuple[_, _]).MakeGenericType(element, typeof(int32)),
            lift.ReturnType.GetGenericArguments()[1]
        )
        let metadata = NullabilityInfoContext().Create(lift.ReturnParameter)
        Assert.Equal(NullabilityState.NotNull, metadata.ReadState)
        Assert.Equal(NullabilityState.Nullable, metadata.GenericTypeArguments[0].ReadState)
        Assert.Equal(NullabilityState.NotNull, metadata.GenericTypeArguments[1].GenericTypeArguments[0].ReadState)
        for pair in[]([]string){
            []string{"System.ValueTuple[C, int32]", "(C?, int32)"},
            []string{"System.ValueTuple[C, int32]", "(C, int32?)"},
            []string{"System.ValueTuple[C, int32]?", "(C, int32)"},
            []string{"System.ValueTuple[C, int32]", "(C, int32)?"},
            []string{"System.Tuple[C, int32]", "(C, int32)"},
            []string{"System.ValueTuple[List[C?], int32]", "(List[C], int32)"},
            []string{"System.ValueTuple[[3]int32, int32]", "([4]int32, int32)"}
        } {
            let rejected = `package TupleAssessmentUser5413
import System.Collections.Generic
import TupleAssessment5413
public class C {}
public func Reject(view IView[string, ` + pair[0] + `]) IView[string?, ` + pair[1] + `] {
return view
}
`
            CompileTupleDriver(fixture.Directory, "Rejected", rejected, selected, references, "6,8,6,12")
        }
    }

    /// The shape from the issue, verbatim: a LINQ call over a dictionary whose
    /// value type is a named tuple carrying a `List` of named tuples. The
    /// return type comes back from the CLR signature unnamed, and flows into a
    /// slot whose declared type carries every name.
    @Fact
    func NestedNamedTupleGenericArgument_ClrRecoveredKeyValuePair_CompileVerifyAndRun() {
        const Source = `package Issue3956

import System
import System.Linq
import System.Collections.Generic

let blobs = Dictionary[string, (Rid int32, CatchHandlerPlusOne int32, Awaits List[(Yield int32, Resume int32, ResumeRid int32)])]()
let awaits = List[(Yield int32, Resume int32, ResumeRid int32)]()
awaits.Add((11, 22, 33))
blobs["sum2"] = (7, 9, awaits)

let only = Enumerable.Single(blobs, func(kv KeyValuePair[string, (Rid int32, CatchHandlerPlusOne int32, Awaits List[(Yield int32, Resume int32, ResumeRid int32)])]) bool {
    return kv.Key == "sum2"
})

Console.WriteLine(only.Value.Rid)
Console.WriteLine(only.Value.CatchHandlerPlusOne)
Console.WriteLine(only.Value.Awaits[0].Resume)`
        Assert.Equal(
            "7${Environment.NewLine}9${Environment.NewLine}22${Environment.NewLine}",
            CompileVerifyAndRun(Source)
        )
    }

    /// The reverse direction: the CLR-recovered UNNAMED shape is the target and
    /// the named shape is the source. Names are metadata in both directions.
    @Fact
    func NestedNamedTupleGenericArgument_NamedSourceToUnnamedTarget_CompileVerifyAndRun() {
        const Source = `package Issue3956

import System
import System.Linq
import System.Collections.Generic

let blobs = Dictionary[string, (Rid int32, Awaits List[(Yield int32, Resume int32)])]()
let awaits = List[(Yield int32, Resume int32)]()
awaits.Add((4, 5))
blobs["a"] = (1, awaits)

let only KeyValuePair[string, (int32, List[(int32, int32)])] = Enumerable.Single(blobs, func(kv KeyValuePair[string, (Rid int32, Awaits List[(Yield int32, Resume int32)])]) bool {
    return kv.Key == "a"
})

Console.WriteLine(only.Value.Item1)
Console.WriteLine(only.Value.Item2[0].Item2)`
        Assert.Equal("1${Environment.NewLine}5${Environment.NewLine}", CompileVerifyAndRun(Source))
    }

    /// A NESTED-ONLY name difference: both sides spell the outer tuple's names
    /// identically and differ only inside the `List` element two levels
    /// down. A fix that compares only the top-level tuple's names passes the
    /// cases above and fails this one.
    @Fact
    func NestedNamedTupleGenericArgument_InnerNamesOnly_CompileVerifyAndRun() {
        const Source = `package Issue3956

import System
import System.Linq
import System.Collections.Generic

let blobs = Dictionary[string, (Rid int32, Awaits List[(Yield int32, Resume int32)])]()
let awaits = List[(Yield int32, Resume int32)]()
awaits.Add((6, 7))
blobs["a"] = (2, awaits)

let only KeyValuePair[string, (Rid int32, Awaits List[(int32, int32)])] = Enumerable.Single(blobs, func(kv KeyValuePair[string, (Rid int32, Awaits List[(Yield int32, Resume int32)])]) bool {
    return kv.Key == "a"
})

Console.WriteLine(only.Value.Rid)
Console.WriteLine(only.Value.Awaits[0].Item1)`
        Assert.Equal("2${Environment.NewLine}6${Environment.NewLine}", CompileVerifyAndRun(Source))
    }

    shared {
        private const TupleProducer string = `#nullable enable
namespace TupleAssessment5413;
public interface IView<out T, out U> { T First { get; } U Second { get; } }
public class ViewImpl<T, U>(T first, U second) : IView<T, U> {
    public T First => first;
    public U Second => second;
}
public static class Api { public static int Calls; }
public static class TupleMaker<T> {
    public static IView<
#nullable disable
        string,
#nullable enable
        (T, int)> Create(T value) {
        Api.Calls++; return new ViewImpl<string, (T, int)>(null!, (value, 42));
    }
    public static IView<string, (T, int)> Ordinary(T value) {
        Api.Calls++; return new ViewImpl<string, (T, int)>("ordinary", (value, 42));
    }
}
public static class ArgumentMaker<U> {
    public static IView<
#nullable disable
        string,
#nullable enable
        U> Create(U value) {
        Api.Calls++; return new ViewImpl<string, U>(null!, value);
    }
    public static IView<string, U> Ordinary(U value) {
        Api.Calls++; return new ViewImpl<string, U>("ordinary", value);
    }
}
`

        private func CompileTupleDriver(
            directory string,
            name string,
            sourceText string,
            contract string,
            references[]string,
            rejectedSpan string?
        ) string {
            let source = Path.Combine(directory, name + ".gs")
            let image = Path.Combine(directory, name + ".dll")
            let reference = Path.Combine(directory, name + ".ref.dll")
            let pdb = Path.ChangeExtension(image, ".pdb")
            File.WriteAllText(source, sourceText)
            let arguments = List[string]{
                typeof(Program).Assembly.Location,
                source,
                "/target:exe",
                "/targetframework:net10.0",
                "--nullability=platform-types",
                "/deterministic+",
                "/debug:portable",
                "/out:" + image,
                "/refout:" + reference,
                "/r:" + contract
            }
            arguments.AddRange(references.Select((path string) -> "/r:" + path))
            let result = RunTupleDriver(arguments)
            let diagnostics = Encoding.UTF8.GetString(result.Output)
            if rejectedSpan != nil {
                Assert.Equal(1, result.Code)
                Assert.Equal("Failed.\n", result.Error.ReplaceLineEndings("\n"))
                let located = Assert.Single(
                    Regex.Matches(diagnostics, `(?m)^([^\r\n]+)\((\d+,\d+,\d+,\d+)\): error (GS\d+):`)
                )
                Assert.Equal(source, located.Groups[1].Value)
                Assert.Equal(rejectedSpan, located.Groups[2].Value)
                Assert.Equal("GS0155", located.Groups[3].Value)
                Assert.False(File.Exists(image))
                Assert.False(File.Exists(reference))
                Assert.False(File.Exists(pdb))
                return image
            }
            Assert.True(result.Code == 0, diagnostics + result.Error)
            Assert.Empty(result.Error)
            let bytes = File.ReadAllBytes(image)
            let referenceBytes = File.ReadAllBytes(reference)
            let pdbBytes = File.ReadAllBytes(pdb)
            Assert.NotEmpty(bytes)
            Assert.NotEmpty(referenceBytes)
            Assert.NotEmpty(pdbBytes)
            let repeated = RunTupleDriver(arguments)
            Assert.Equal(0, repeated.Code)
            Assert.Equal(result.Output, repeated.Output)
            Assert.Equal(result.Error, repeated.Error)
            Assert.Equal(bytes, File.ReadAllBytes(image))
            Assert.Equal(referenceBytes, File.ReadAllBytes(reference))
            Assert.Equal(pdbBytes, File.ReadAllBytes(pdb))
            return image
        }

        private func RunTupleDriver(arguments IEnumerable[string])(Code int32, Output[]uint8, Error string) {
            let start = ProcessStartInfo("dotnet"){
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
            for argument in arguments {
                start.ArgumentList.Add(argument)
            }
            using let process = Process.Start(start) ?? throw InvalidOperationException("Could not start dotnet.")
            using let output = MemoryStream()
            let read = process.StandardOutput.BaseStream.CopyToAsync(output)
            let error = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                throw TimeoutException("dotnet did not finish.")
            }
            read.GetAwaiter().GetResult()
            return (process.ExitCode, output.ToArray(), error.GetAwaiter().GetResult())
        }

        private func CompileVerifyAndRun(source string) string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3956NamedTupleGenericArgumentIdentityTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "Program.gs")
                let outputPath = Path.Combine(directory, "Issue3956.dll")
                File.WriteAllText(sourcePath, source)
                let arguments = List[string]{
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100"
                }
                for reference in ReferenceResolver.HostTrustedPlatformAssemblyPaths() {
                    arguments.Add("/r:" + reference)
                }
                arguments.Add(sourcePath)
                using let standardOut = StringWriter()
                using let standardError = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(standardOut)
                Console.SetError(standardError)
                var exitCode int32
                try {
                    exitCode = Program.Main(arguments.ToArray())
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, "gsc failed:${Environment.NewLine}$standardOut$standardError")
                IlVerifier.Verify(outputPath)
                using let process Process? = Process.Start(
                    ProcessStartInfo("dotnet"){
                        ArgumentList = {
                            "exec",
                            "--runtimeconfig",
                            Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                            outputPath
                        },
                        WorkingDirectory = directory,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false
                    }
                )
                let output = process!!.StandardOutput.ReadToEnd()
                let error = process!!.StandardError.ReadToEnd()
                Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(process!!.ExitCode == 0, error)
                return output.ReplaceLineEndings(Environment.NewLine)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
