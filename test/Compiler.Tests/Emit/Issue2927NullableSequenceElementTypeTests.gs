// <copyright file="Issue2927NullableSequenceElementTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import GSharp.Compiler
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests

/// Issue #2927: nullable value-type sequence elements retain their runtime
/// element type across binding and iterator metadata emission. Asserts the
/// emitted program only; the interpreter parity arm was retired with the
/// evaluator in ADR-0156 Phase 3c (#3176).
open class Issue2927NullableSequenceElementTypeTests {
    @Fact
    func SyncNullableIteratorElementCaptureLoadsVerifiesAndRuns() {
        const Source = `package Issue2927Sync
import System

func text(value int32?) string {
    if value == nil {
        return "nil"
    }

    return value.ToString()
}

func values() sequence[int32?] {
    for value in []int32?{1, nil, 3} {
        var read = () -> { return value }
        yield read()
    }
}

func direct() string {
    var result = ""
    for value in []int32?{1, nil, 3} {
        var read = () -> { return value }
        result = result + text(read()) + ","
    }

    return result
}

var iteratorResult = ""
for value in values() {
    iteratorResult = iteratorResult + text(value) + ","
}

let directResult = direct()
Console.WriteLine(iteratorResult)
Console.WriteLine(directResult)
iteratorResult == directResult`
        AssertParity(Source, "1,nil,3,", "SyncNullableIteratorElementCaptureLoadsVerifiesAndRuns")
    }

    @Fact
    func AsyncNullableIteratorElementCaptureLoadsVerifiesAndRuns() {
        const Source = `package Issue2927Async
import System
import System.Threading.Tasks

func text(value int32?) string {
    if value == nil {
        return "nil"
    }

    return value.ToString()
}

async func values() async sequence[int32?] {
    for value in []int32?{1, nil, 3} {
        var read = () -> { return value }
        yield read()
        await Task.Delay(1)
    }
}

func direct() string {
    var result = ""
    for value in []int32?{1, nil, 3} {
        var read = () -> { return value }
        result = result + text(read()) + ","
    }

    return result
}

public var iteratorResult = ""

async func collect() {
    await for value in values() {
        iteratorResult = iteratorResult + text(value) + ","
    }
}

collect().Wait()
let directResult = direct()
Console.WriteLine(iteratorResult)
Console.WriteLine(directResult)
iteratorResult == directResult`
        AssertParity(Source, "1,nil,3,", "AsyncNullableIteratorElementCaptureLoadsVerifiesAndRuns")
    }

    @Fact
    func NullableSequenceParameterAcceptsList() {
        const Source = `package Issue2927Parameter
import System
import System.Collections.Generic

func text(value int32?) string {
    if value == nil {
        return "nil"
    }

    return value.ToString()
}

func collect(values sequence[int32?]) string {
    var result = ""
    for value in values {
        result = result + text(value) + ","
    }

    return result
}

var values = List[int32?]()
values.Add(1)
values.Add(nil)
values.Add(3)
Console.WriteLine(collect(values))`
        let assemblyPath = Compile(Source, "NullableSequenceParameterAcceptsList")
        IlVerifier.Verify(assemblyPath)
        let assembly = EmittedFixture.Load(assemblyPath)
        Assert.NotEmpty(assembly.GetTypes())
        Assert.Equal("1,nil,3,${Environment.NewLine}", RunBounded(assemblyPath, "NullableSequenceParameterAcceptsList"))
    }

    @Fact
    func ReferenceConstrainedGenericNullableSequenceLoadsVerifiesAndRuns() {
        const Source = `package Issue2927ReferenceConstrained
import System

func values[T class](value T) sequence[T?] {
    yield value
    yield nil
}

for value in values[string]("x") {
    Console.WriteLine(value == nil ? "nil" : value)
}`
        let assemblyPath = Compile(Source, "ReferenceConstrainedGenericNullableSequenceLoadsVerifiesAndRuns")
        IlVerifier.Verify(assemblyPath)
        let assembly = EmittedFixture.Load(assemblyPath)
        Assert.NotEmpty(assembly.GetTypes())
        Assert.Equal(
            "x${Environment.NewLine}nil${Environment.NewLine}",
            RunBounded(assemblyPath, "ReferenceConstrainedGenericNullableSequenceLoadsVerifiesAndRuns")
        )
    }

    @Fact
    func BaseClassConstrainedGenericNullableSequenceLoadsVerifiesAndRuns() {
        const Source = `package Issue2927BaseClassConstrained
import System

open class Animal { open func Speak() string { return "..." } }
open class Dog : Animal { override func Speak() string { return "woof" } }

func values[T Animal](value T) sequence[T?] {
    yield value
    yield nil
}

for value in values[Dog](Dog()) {
    if value == nil {
        Console.WriteLine("nil")
    } else {
        Console.WriteLine(value.Speak())
    }
}`
        let assemblyPath = Compile(Source, "BaseClassConstrainedGenericNullableSequenceLoadsVerifiesAndRuns")
        IlVerifier.Verify(assemblyPath)
        let assembly = EmittedFixture.Load(assemblyPath)
        Assert.NotEmpty(assembly.GetTypes())
        Assert.Equal(
            "woof${Environment.NewLine}nil${Environment.NewLine}",
            RunBounded(assemblyPath, "BaseClassConstrainedGenericNullableSequenceLoadsVerifiesAndRuns")
        )
    }

    @Fact
    func StructConstrainedGenericNullableSequenceLoadsVerifiesAndRuns() {
        const Source = `package Issue2927StructConstrained
import System

func values[T struct](value T) sequence[T?] {
    yield value
    yield nil
}

for value in values[int32](5) {
    Console.WriteLine(value == nil ? "nil" : value.ToString())
}`
        let assemblyPath = Compile(Source, "StructConstrainedGenericNullableSequenceLoadsVerifiesAndRuns")
        IlVerifier.Verify(assemblyPath)
        let assembly = EmittedFixture.Load(assemblyPath)
        Assert.NotEmpty(assembly.GetTypes())
        Assert.Equal(
            "5${Environment.NewLine}nil${Environment.NewLine}",
            RunBounded(assemblyPath, "StructConstrainedGenericNullableSequenceLoadsVerifiesAndRuns")
        )
    }

    @Fact
    func NullableReferenceSequenceGuardLoadsVerifiesAndRuns() {
        const Source = `package Issue2927ReferenceGuard
import System

func text(value string?) string {
    if value == nil { return "nil" }
    return value
}

func values() sequence[string?] {
    yield "x"
    yield nil
}

for value in values() { Console.WriteLine(text(value)) }`
        let assemblyPath = Compile(Source, "NullableReferenceSequenceGuardLoadsVerifiesAndRuns")
        IlVerifier.Verify(assemblyPath)
        let assembly = EmittedFixture.Load(assemblyPath)
        Assert.NotEmpty(assembly.GetTypes())
        Assert.Equal(
            "x${Environment.NewLine}nil${Environment.NewLine}",
            RunBounded(assemblyPath, "NullableReferenceSequenceGuardLoadsVerifiesAndRuns")
        )
    }

    @Fact
    func NullableUserEnumSequenceGuardLoadsVerifiesAndRuns() {
        const Source = `package Issue2927EnumGuard
import System

enum E { A }

func text(value E?) string {
    if value == nil { return "nil" }
    return value.ToString()
}

func values() sequence[E?] {
    yield E.A
    yield nil
}

for value in values() { Console.WriteLine(text(value)) }`
        let assemblyPath = Compile(Source, "NullableUserEnumSequenceGuardLoadsVerifiesAndRuns")
        IlVerifier.Verify(assemblyPath)
        let assembly = EmittedFixture.Load(assemblyPath)
        Assert.NotEmpty(assembly.GetTypes())
        Assert.Equal(
            "A${Environment.NewLine}nil${Environment.NewLine}",
            RunBounded(assemblyPath, "NullableUserEnumSequenceGuardLoadsVerifiesAndRuns")
        )
    }

    @Fact
    func GenericNullableSequenceSpecializesValueAndReferenceElements() {
        const Source = `package Issue2927GenericSync
import System
import System.Collections.Generic

func intText(value int32?) string { if value == nil { return "nil" } return value.ToString() }
func boolText(value bool?) string { if value == nil { return "nil" } return value.ToString() }
func stringText(value string?) string { if value == nil { return "nil" } return value }
func values[T](value T) sequence[T?] {
    yield value
    yield nil
}

func consume(values IEnumerable[int32?]) {
    for value in values { Console.WriteLine(intText(value)) }
}

var iterator = values[int32](5).GetEnumerator()
iterator.MoveNext()
Console.WriteLine(intText(iterator.Current))
iterator.MoveNext()
Console.WriteLine(intText(iterator.Current))
consume(values[int32](7))
for value in values[bool](true) { Console.WriteLine(boolText(value)) }
for value in values[string]("x") { Console.WriteLine(stringText(value)) }
for value in values(9) { Console.WriteLine(intText(value)) }
for value in values("y") { Console.WriteLine(stringText(value)) }`
        AssertEmittedProgram(Source, `5
nil
7
nil
True
nil
x
nil
9
nil
y
nil
`, "GenericNullableSequenceSpecializesValueAndReferenceElements")
    }

    @Fact
    func GenericAsyncNullableSequenceSpecializesValueAndReferenceElements() {
        const Source = `package Issue2927GenericAsync
import System
import System.Threading.Tasks

class Resource : IAsyncDisposable {
    func DisposeAsync() ValueTask {
        Console.WriteLine("disposed")
        return ValueTask.CompletedTask
    }
}

func intText(value int32?) string { if value == nil { return "nil" } return value.ToString() }
func stringText(value string?) string { if value == nil { return "nil" } return value }
async func values[T](value T) async sequence[T?] {
    await using let resource = Resource{}
    yield value
    await Task.Delay(1)
    yield nil
}

async func collect() {
    await for value in values[int32](5) { Console.WriteLine(intText(value)) }
    await for value in values[string]("x") { Console.WriteLine(stringText(value)) }
}

collect().Wait()`
        AssertEmittedProgram(Source, `5
nil
disposed
x
nil
disposed
`, "GenericAsyncNullableSequenceSpecializesValueAndReferenceElements")
    }

    @Fact
    func GenericNullableSequenceSupportsExplicitTypeArgumentsWithoutValueArguments() {
        const Source = `package Issue2927GenericExplicit
import System

func intText(value int32?) string { if value == nil { return "nil" } return value.ToString() }
func stringText(value string?) string { if value == nil { return "nil" } return value }
func empty[T]() sequence[T?] { yield nil }

for value in empty[int32]() { Console.WriteLine(intText(value)) }
for value in empty[string]() { Console.WriteLine(stringText(value)) }`
        AssertEmittedProgram(Source, `nil
nil
`, "GenericNullableSequenceSupportsExplicitTypeArgumentsWithoutValueArguments")
    }

    @Fact
    func SpecializedGenericIteratorResultConvertsToConcreteNullableSequence() {
        const Source = `package Issue2927ConcreteSequence
import System

func text(value int32?) string { if value == nil { return "nil" } return value.ToString() }
func values[T](value T) sequence[T?] {
    yield value
    yield nil
}

var concrete sequence[int32?] = values[int32](5)
for value in concrete { Console.WriteLine(text(value)) }`
        AssertEmittedProgram(Source, `5
nil
`, "SpecializedGenericIteratorResultConvertsToConcreteNullableSequence")
    }

    @Fact
    func GenericNullableSequenceSpecializesTopLevelExtensionInstanceAndStaticIterators() {
        const Source = `package Issue2927GenericForms
import System

func text(value int32?) string { if value == nil { return "nil" } return value.ToString() }
func top[T](value T) sequence[T?] {
    yield value
    yield nil
}

func (self string) extensionValues[T](value T) sequence[T?] {
    yield value
    yield nil
}

class Box {
    func instanceValues[T](value T) sequence[T?] {
        yield value
        yield nil
    }

    func instanceEmpty[T]() sequence[T?] { yield nil }

    shared {
        func staticValues[T](value T) sequence[T?] {
            yield value
            yield nil
        }

        func staticEmpty[T]() sequence[T?] { yield nil }
    }
}

func (self Box) receiverValues[T](value T) sequence[T?] {
    yield value
    yield nil
}

for value in top[int32](1) { Console.WriteLine(text(value)) }
for value in "x".extensionValues[int32](2) { Console.WriteLine(text(value)) }
var box = Box()
for value in box.instanceValues[int32](3) { Console.WriteLine(text(value)) }
for value in Box.staticValues[int32](4) { Console.WriteLine(text(value)) }
for value in box.instanceEmpty[int32]() { Console.WriteLine(text(value)) }
for value in Box.staticEmpty[int32]() { Console.WriteLine(text(value)) }
for value in box.receiverValues[int32](5) { Console.WriteLine(text(value)) }`
        AssertEmittedProgram(Source, `1
nil
2
nil
3
nil
4
nil
nil
nil
5
nil
`, "GenericNullableSequenceSpecializesTopLevelExtensionInstanceAndStaticIterators")
    }

    @Fact
    func GenericNullableSequenceMetadataUsesMatchingSpecializedSignaturesAndInterfaces() {
        const Source = `package Issue2927GenericMetadata
import System
import System.Threading.Tasks

func values[T](value T) sequence[T?] {
    yield value
    yield nil
}

async func asyncValues[T](value T) async sequence[T?] {
    yield value
    await Task.Delay(1)
    yield nil
}

Console.WriteLine("ok")`
        let assemblyPath = Compile(
            Source,
            "GenericNullableSequenceMetadataUsesMatchingSpecializedSignaturesAndInterfaces"
        )
        IlVerifier.Verify(assemblyPath)
        let assembly = EmittedFixture.Load(assemblyPath)
        let types = assembly.GetTypes()
        Assert.NotEmpty(types)
        AssertSpecializedMethods(types, "values", typeof(IEnumerable[_]))
        AssertSpecializedMethods(types, "asyncValues", typeof(IAsyncEnumerable[_]))
        AssertSpecializedIteratorInterfaces(types, typeof(IEnumerable[_]))
        AssertSpecializedIteratorInterfaces(types, typeof(IAsyncEnumerable[_]))
        Assert.Equal(
            "ok${Environment.NewLine}",
            RunBounded(assemblyPath, "GenericNullableSequenceMetadataUsesMatchingSpecializedSignaturesAndInterfaces")
        )
    }

    @Fact
    func NestedNullableSequenceGuardLoadsVerifiesAndRuns() {
        const Source = `package Issue2927Nested
import System

func text(value int32?) string { if value == nil { return "nil" } return value.ToString() }
func inner() sequence[int32?] {
    yield 3
    yield nil
}

func outer() sequence[sequence[int32?]] { yield inner() }
for group in outer() {
    for value in group { Console.WriteLine(text(value)) }
}`
        AssertEmittedProgram(Source, `3
nil
`, "NestedNullableSequenceGuardLoadsVerifiesAndRuns")
    }

    @Fact
    func UnconstrainedNullableSequenceOutsideIteratorStillReportsSingleGS0508() {
        const Source = "package Issue2927DiagnosticGuard\nfunc consume[T](values sequence[T?]) int32 -> 1"
        AssertSingleGS0508(Source, "UnconstrainedNullableSequenceOutsideIteratorStillReportsSingleGS0508")
    }

    @Fact
    func UnconstrainedNullableSequenceNonIteratorReturnStillReportsGS0508() {
        const Source = "package Issue2927NonIteratorReturnDiagnosticGuard\nfunc consume[T]() sequence[T?] -> nil"
        let result = InvokeCompiler(Source, "UnconstrainedNullableSequenceNonIteratorReturnStillReportsGS0508")
        Assert.NotEqual(0, result.ExitCode)
        Assert.Equal(
            1,
            result
                .Output
                .Split(Environment.NewLine)
                .Count((line string) -> line.Contains("error GS0508:", StringComparison.Ordinal))
        )
        Assert.Equal(
            1,
            result
                .Output
                .Split(Environment.NewLine)
                .Count((line string) -> line.Contains("error GS0155:", StringComparison.Ordinal))
        )
        Assert.False(File.Exists(result.AssemblyPath))
    }

    @Fact
    func UnconstrainedEnclosingTypeParameterIteratorStillReportsSingleGS0508() {
        const Source = `package Issue2927EnclosingTypeDiagnosticGuard
class Box[T] {
    func values(value T) sequence[T?] {
        yield value
        yield nil
    }
}`
        AssertSingleGS0508(Source, "UnconstrainedEnclosingTypeParameterIteratorStillReportsSingleGS0508")
    }

    @Fact
    func SpecializedIteratorBodyDiagnosticIsReportedOnce() {
        const Source = "package Issue2927DiagnosticDeduplication\nfunc values[T](value T) sequence[T?] { yield missing }"
        let result = InvokeCompiler(Source, "SpecializedIteratorBodyDiagnosticIsReportedOnce")
        Assert.NotEqual(0, result.ExitCode)
        Assert.Equal(
            1,
            result
                .Output
                .Split(Environment.NewLine)
                .Count((line string) -> line.Contains("error GS0125:", StringComparison.Ordinal))
        )
        Assert.DoesNotContain("error GS0508:", result.Output, StringComparison.Ordinal)
        Assert.False(File.Exists(result.AssemblyPath))
    }

    @Fact
    func UnconstrainedGenericCallsCharacterizeSpecializedIteratorDiagnostics() {
        const InferredSource = `package Issue2927InferredDiagnostic
func opt[T](v T) sequence[T?] {
    yield v
    yield nil
}
func relay[U](u U) { let values = opt(u) }`
        const NamedSource = `package Issue2927NamedDiagnostic
func opt[T](v T) sequence[T?] {
    yield v
    yield nil
}
func relay[U](u U) { let values = opt(v: u) }`
        const ExplicitSource = `package Issue2927ExplicitDiagnostic
func opt[T](v int32) sequence[T?] {
    yield nil
}
func relay[U]() { let values = opt[U](1) }`
        const AsyncSource = `package Issue2927AsyncDiagnostic
async func opt[T](v T) async sequence[T?] {
    yield v
    yield nil
}
func relay[U](u U) { let values = opt(u) }`
        const NullableSource = `package Issue2927NullableArgumentDiagnostic
func opt[T](v T) sequence[T?] {
    yield v
    yield nil
}
let value int32? = 1
let values = opt[int32?](2)`
        AssertSingleDiagnostic(
            InvokeCompiler(
                InferredSource,
                "UnconstrainedGenericCallsCharacterizeSpecializedIteratorDiagnostics" + "_inferred"
            ),
            "GS0505",
            "type parameter 'U' is not constrained"
        )
        AssertSingleDiagnostic(
            InvokeCompiler(
                NamedSource,
                "UnconstrainedGenericCallsCharacterizeSpecializedIteratorDiagnostics" + "_named"
            ),
            "GS0505",
            "type parameter 'U' is not constrained"
        )
        AssertSingleDiagnostic(
            InvokeCompiler(
                ExplicitSource,
                "UnconstrainedGenericCallsCharacterizeSpecializedIteratorDiagnostics" + "_explicit"
            ),
            "GS0505",
            "type parameter 'U' is not constrained"
        )
        AssertSingleDiagnostic(
            InvokeCompiler(
                AsyncSource,
                "UnconstrainedGenericCallsCharacterizeSpecializedIteratorDiagnostics" + "_async"
            ),
            "GS0505",
            "type parameter 'U' is not constrained"
        )
        AssertSingleDiagnostic(
            InvokeCompiler(
                NullableSource,
                "UnconstrainedGenericCallsCharacterizeSpecializedIteratorDiagnostics" + "_nullable"
            ),
            "GS0152",
            "does not satisfy the 'struct' constraint."
        )
    }

    @Fact
    func UnconstrainedInstanceNullableIteratorCallReportsGS0505() {
        const Source = `package Issue2958InstanceDiagnostic
class Box {
    func opt[T](v T) sequence[T?] {
        yield v
        yield nil
    }
}
func relay[U](box Box, u U) { let values = box.opt(u) }`
        AssertSingleDiagnostic(
            InvokeCompiler(Source, "UnconstrainedInstanceNullableIteratorCallReportsGS0505"),
            "GS0505",
            "type parameter 'U' is not constrained"
        )
    }

    @Fact
    func UserWrittenOverloadAmbiguityStillReportsGS0266() {
        const Source = `package Issue2958UserAmbiguityGuard
func pick(value int32, left int32 = 0) int32 -> 1
func pick(value int32, right string = "") int32 -> 2
let result = pick(1)`
        AssertSingleDiagnostic(
            InvokeCompiler(Source, "UserWrittenOverloadAmbiguityStillReportsGS0266"),
            "GS0266",
            "Disambiguate with explicit types or named arguments."
        )
    }

    @Fact
    func MixedNullableIteratorCandidateSetStillReportsGS0266() {
        const Source = `package Issue2958MixedAmbiguityGuard
import System
func opt[T](v T) sequence[T?] {
    yield v
    yield nil
}
func opt[T class](v T, fallback int32 = 0) sequence[T?] {
    throw Exception()
}
func relay[U](u U) { let values = opt(u) }`
        AssertSingleDiagnostic(
            InvokeCompiler(Source, "MixedNullableIteratorCandidateSetStillReportsGS0266"),
            "GS0266",
            "Disambiguate with explicit types or named arguments."
        )
    }

    @Fact
    func MultipleNullableIteratorDeclarationsStillReportGS0266() {
        const Source = `package Issue2958MultipleIteratorAmbiguityGuard
func opt[T](v T, left int32 = 0) sequence[T?] {
    yield v
    yield nil
}
func opt[T](v T, right string = "") sequence[T?] {
    yield v
    yield nil
}
func relay[U](u U) { let values = opt(u) }`
        AssertSingleDiagnostic(
            InvokeCompiler(Source, "MultipleNullableIteratorDeclarationsStillReportGS0266"),
            "GS0266",
            "Disambiguate with explicit types or named arguments."
        )
    }

    shared {
        private func AssertEmittedProgram(source string, expected string, name string) {
            let assemblyPath = Compile(source, name)
            IlVerifier.Verify(assemblyPath)
            let assembly = EmittedFixture.Load(assemblyPath)
            Assert.NotEmpty(assembly.GetTypes())
            Assert.Equal(expected, RunBounded(assemblyPath, name))
        }

        private func AssertSpecializedMethods(types[]Type, methodName string, openReturnType Type) {
            let methods = types
                .SelectMany(
                func (type Type) IEnumerable[MethodInfo] {
                    return type.GetMethods(
                        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly
                    )
                }
            )
                .Where((method MethodInfo) -> method.Name == methodName)
                .ToArray()
            Assert.Equal(2, methods.Length)
            let referenceMethod = methods.Single(
                (method MethodInfo) -> (
                    method
                        .GetGenericArguments()[0]
                        .GenericParameterAttributes & GenericParameterAttributes.ReferenceTypeConstraint
                ) != 0
            )
            let valueMethod = methods.Single(
                (method MethodInfo) -> (
                    method
                        .GetGenericArguments()[0]
                        .GenericParameterAttributes & GenericParameterAttributes.NotNullableValueTypeConstraint
                ) != 0
            )
            Assert.Equal(openReturnType, referenceMethod.ReturnType.GetGenericTypeDefinition())
            Assert.True(referenceMethod.ReturnType.GetGenericArguments()[0].IsGenericParameter)
            Assert.Equal(openReturnType, valueMethod.ReturnType.GetGenericTypeDefinition())
            AssertNullableGenericParameter(valueMethod.ReturnType.GetGenericArguments()[0])
        }

        private func AssertSpecializedIteratorInterfaces(types[]Type, openInterface Type) {
            let elements = types
                .SelectMany(
                func (type Type) IEnumerable[Type] {
                    return type.GetInterfaces()
                }
            )
                .Where(
                ($interface Type) -> $interface.IsGenericType && $interface.GetGenericTypeDefinition() == openInterface
            )
                .Select(($interface Type) -> $interface.GetGenericArguments()[0])
                .ToArray()
            Assert.Contains(elements, (element Type) -> element.IsGenericParameter)
            Assert.Contains(elements, IsNullableGenericParameter)
        }

        private func AssertNullableGenericParameter(type Type) -> Assert.True(
            IsNullableGenericParameter(type),
            "Expected Nullable<T>, got '$type'."
        )

        private func IsNullableGenericParameter(type Type) bool -> type.IsGenericType &&
            type.GetGenericTypeDefinition() == typeof(Nullable[_]) && type.GetGenericArguments()[0].IsGenericParameter

        private func AssertParity(source string, expected string, name string) {
            let assemblyPath = Compile(source, name)
            IlVerifier.Verify(assemblyPath)
            let assembly = EmittedFixture.Load(assemblyPath)
            Assert.NotEmpty(assembly.GetTypes())
            Assert.Equal(
                "$expected${Environment.NewLine}$expected${Environment.NewLine}",
                RunBounded(assemblyPath, name)
            )
        }

        private func Compile(source string, name string) string {
            let result = InvokeCompiler(source, name)
            Assert.True(result.ExitCode == 0, ("$name" + `: gsc failed:
` + "${result.Output}"))
            return result.AssemblyPath
        }

        private func AssertSingleGS0508(source string, name string) {
            let result = InvokeCompiler(source, name)
            Assert.NotEqual(0, result.ExitCode)
            let diagnostics = result
                .Output
                .Split(Environment.NewLine)
                .Where((line string) -> line.Contains("error GS", StringComparison.Ordinal))
                .ToArray()
            Assert.Single(diagnostics)
            Assert.Contains("error GS0508:", diagnostics[0], StringComparison.Ordinal)
            Assert.False(File.Exists(result.AssemblyPath), "gsc must not emit an assembly after GS0508")
        }

        private func AssertSingleDiagnostic(
            result(ExitCode int32, Output string, AssemblyPath string),
            id string,
            message string
        ) {
            Assert.NotEqual(0, result.ExitCode)
            let diagnostics = result
                .Output
                .Split(Environment.NewLine)
                .Where((line string) -> line.Contains("error GS", StringComparison.Ordinal))
                .ToArray()
            Assert.Single(diagnostics)
            Assert.Contains("error $id:", diagnostics[0], StringComparison.Ordinal)
            Assert.Contains(message, diagnostics[0], StringComparison.Ordinal)
            Assert.False(File.Exists(result.AssemblyPath))
        }

        private func InvokeCompiler(source string, name string)(ExitCode int32, Output string, AssemblyPath string) {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2927NullableSequenceElementTypeTests", name)
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            let assemblyPath = Path.Combine(directory, "test.dll")
            File.WriteAllText(sourcePath, source)
            File.Delete(assemblyPath)
            File.Delete(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousErr)
            }
            return (exitCode, stdout.ToString() + stderr.ToString(), assemblyPath)
        }

        private func RunBounded(assemblyPath string, name string) string {
            using let process Process? = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                        assemblyPath
                    },
                    WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            )
            Assert.NotNull(process)
            let outputTask = process!!.StandardOutput.ReadToEndAsync()
            let errorTask = process!!.StandardError.ReadToEndAsync()
            let exited = process!!.WaitForExit(30_000)
            if !exited {
                process!!.Kill(entireProcessTree: true)
                process!!.WaitForExit()
            }
            Assert.True(exited, "$name: emitted program timed out")
            let output = outputTask.GetAwaiter().GetResult()
            let error = errorTask.GetAwaiter().GetResult()
            Assert.True(process!!.ExitCode == 0, ("$name" + `: emitted program failed:
` + "$error"))
            return output.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
