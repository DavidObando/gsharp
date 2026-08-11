// <copyright file="Issue2927NullableSequenceElementTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2927: nullable value-type sequence elements retain their runtime
/// element type across binding and iterator metadata emission. Asserts the
/// emitted program only; the interpreter parity arm was retired with the
/// evaluator in ADR-0156 Phase 3c (#3176).
/// </summary>
public class Issue2927NullableSequenceElementTypeTests
{
    [Fact]
    public void SyncNullableIteratorElementCaptureLoadsVerifiesAndRuns()
    {
        const string Source = """
            package Issue2927Sync
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
            iteratorResult == directResult
            """;

        AssertParity(Source, "1,nil,3,", nameof(SyncNullableIteratorElementCaptureLoadsVerifiesAndRuns));
    }

    [Fact]
    public void AsyncNullableIteratorElementCaptureLoadsVerifiesAndRuns()
    {
        const string Source = """
            package Issue2927Async
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
            iteratorResult == directResult
            """;

        AssertParity(Source, "1,nil,3,", nameof(AsyncNullableIteratorElementCaptureLoadsVerifiesAndRuns));
    }

    [Fact]
    public void NullableSequenceParameterAcceptsList()
    {
        const string Source = """
            package Issue2927Parameter
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
            Console.WriteLine(collect(values))
            """;

        var assemblyPath = Compile(Source, nameof(NullableSequenceParameterAcceptsList));
        IlVerifier.Verify(assemblyPath);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal($"1,nil,3,{Environment.NewLine}", RunBounded(assemblyPath, nameof(NullableSequenceParameterAcceptsList)));
    }

    [Fact]
    public void ReferenceConstrainedGenericNullableSequenceLoadsVerifiesAndRuns()
    {
        const string Source = """
            package Issue2927ReferenceConstrained
            import System

            func values[T class](value T) sequence[T?] {
                yield value
                yield nil
            }

            for value in values[string]("x") {
                Console.WriteLine(value == nil ? "nil" : value)
            }
            """;

        var assemblyPath = Compile(Source, nameof(ReferenceConstrainedGenericNullableSequenceLoadsVerifiesAndRuns));
        IlVerifier.Verify(assemblyPath);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal($"x{Environment.NewLine}nil{Environment.NewLine}", RunBounded(assemblyPath, nameof(ReferenceConstrainedGenericNullableSequenceLoadsVerifiesAndRuns)));
    }

    [Fact]
    public void BaseClassConstrainedGenericNullableSequenceLoadsVerifiesAndRuns()
    {
        const string Source = """
            package Issue2927BaseClassConstrained
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
            }
            """;

        var assemblyPath = Compile(Source, nameof(BaseClassConstrainedGenericNullableSequenceLoadsVerifiesAndRuns));
        IlVerifier.Verify(assemblyPath);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal($"woof{Environment.NewLine}nil{Environment.NewLine}", RunBounded(assemblyPath, nameof(BaseClassConstrainedGenericNullableSequenceLoadsVerifiesAndRuns)));
    }

    [Fact]
    public void StructConstrainedGenericNullableSequenceLoadsVerifiesAndRuns()
    {
        const string Source = """
            package Issue2927StructConstrained
            import System

            func values[T struct](value T) sequence[T?] {
                yield value
                yield nil
            }

            for value in values[int32](5) {
                Console.WriteLine(value == nil ? "nil" : value.ToString())
            }
            """;

        var assemblyPath = Compile(Source, nameof(StructConstrainedGenericNullableSequenceLoadsVerifiesAndRuns));
        IlVerifier.Verify(assemblyPath);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal($"5{Environment.NewLine}nil{Environment.NewLine}", RunBounded(assemblyPath, nameof(StructConstrainedGenericNullableSequenceLoadsVerifiesAndRuns)));
    }

    [Fact]
    public void NullableReferenceSequenceGuardLoadsVerifiesAndRuns()
    {
        const string Source = """
            package Issue2927ReferenceGuard
            import System

            func text(value string?) string {
                if value == nil { return "nil" }
                return value
            }

            func values() sequence[string?] {
                yield "x"
                yield nil
            }

            for value in values() { Console.WriteLine(text(value)) }
            """;

        var assemblyPath = Compile(Source, nameof(NullableReferenceSequenceGuardLoadsVerifiesAndRuns));
        IlVerifier.Verify(assemblyPath);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal($"x{Environment.NewLine}nil{Environment.NewLine}", RunBounded(assemblyPath, nameof(NullableReferenceSequenceGuardLoadsVerifiesAndRuns)));
    }

    [Fact]
    public void NullableUserEnumSequenceGuardLoadsVerifiesAndRuns()
    {
        const string Source = """
            package Issue2927EnumGuard
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

            for value in values() { Console.WriteLine(text(value)) }
            """;

        var assemblyPath = Compile(Source, nameof(NullableUserEnumSequenceGuardLoadsVerifiesAndRuns));
        IlVerifier.Verify(assemblyPath);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal($"A{Environment.NewLine}nil{Environment.NewLine}", RunBounded(assemblyPath, nameof(NullableUserEnumSequenceGuardLoadsVerifiesAndRuns)));
    }

    [Fact]
    public void GenericNullableSequenceSpecializesValueAndReferenceElements()
    {
        const string Source = """
            package Issue2927GenericSync
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
            for value in values("y") { Console.WriteLine(stringText(value)) }
            """;

        AssertEmittedProgram(Source, "5\nnil\n7\nnil\nTrue\nnil\nx\nnil\n9\nnil\ny\nnil\n", nameof(GenericNullableSequenceSpecializesValueAndReferenceElements));
    }

    [Fact]
    public void GenericAsyncNullableSequenceSpecializesValueAndReferenceElements()
    {
        const string Source = """
            package Issue2927GenericAsync
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

            collect().Wait()
            """;

        AssertEmittedProgram(Source, "5\nnil\ndisposed\nx\nnil\ndisposed\n", nameof(GenericAsyncNullableSequenceSpecializesValueAndReferenceElements));
    }

    [Fact]
    public void GenericNullableSequenceSupportsExplicitTypeArgumentsWithoutValueArguments()
    {
        const string Source = """
            package Issue2927GenericExplicit
            import System

            func intText(value int32?) string { if value == nil { return "nil" } return value.ToString() }
            func stringText(value string?) string { if value == nil { return "nil" } return value }
            func empty[T]() sequence[T?] { yield nil }

            for value in empty[int32]() { Console.WriteLine(intText(value)) }
            for value in empty[string]() { Console.WriteLine(stringText(value)) }
            """;

        AssertEmittedProgram(Source, "nil\nnil\n", nameof(GenericNullableSequenceSupportsExplicitTypeArgumentsWithoutValueArguments));
    }

    [Fact]
    public void SpecializedGenericIteratorResultConvertsToConcreteNullableSequence()
    {
        const string Source = """
            package Issue2927ConcreteSequence
            import System

            func text(value int32?) string { if value == nil { return "nil" } return value.ToString() }
            func values[T](value T) sequence[T?] {
                yield value
                yield nil
            }

            var concrete sequence[int32?] = values[int32](5)
            for value in concrete { Console.WriteLine(text(value)) }
            """;

        AssertEmittedProgram(Source, "5\nnil\n", nameof(SpecializedGenericIteratorResultConvertsToConcreteNullableSequence));
    }

    [Fact]
    public void GenericNullableSequenceSpecializesTopLevelExtensionInstanceAndStaticIterators()
    {
        const string Source = """
            package Issue2927GenericForms
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
            for value in box.receiverValues[int32](5) { Console.WriteLine(text(value)) }
            """;

        AssertEmittedProgram(Source, "1\nnil\n2\nnil\n3\nnil\n4\nnil\nnil\nnil\n5\nnil\n", nameof(GenericNullableSequenceSpecializesTopLevelExtensionInstanceAndStaticIterators));
    }

    [Fact]
    public void GenericNullableSequenceMetadataUsesMatchingSpecializedSignaturesAndInterfaces()
    {
        const string Source = """
            package Issue2927GenericMetadata
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

            Console.WriteLine("ok")
            """;

        var assemblyPath = Compile(Source, nameof(GenericNullableSequenceMetadataUsesMatchingSpecializedSignaturesAndInterfaces));
        IlVerifier.Verify(assemblyPath);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        var types = assembly.GetTypes();
        Assert.NotEmpty(types);

        AssertSpecializedMethods(types, "values", typeof(IEnumerable<>));
        AssertSpecializedMethods(types, "asyncValues", typeof(IAsyncEnumerable<>));
        AssertSpecializedIteratorInterfaces(types, typeof(IEnumerable<>));
        AssertSpecializedIteratorInterfaces(types, typeof(IAsyncEnumerable<>));
        Assert.Equal($"ok{Environment.NewLine}", RunBounded(assemblyPath, nameof(GenericNullableSequenceMetadataUsesMatchingSpecializedSignaturesAndInterfaces)));
    }

    [Fact]
    public void NestedNullableSequenceGuardLoadsVerifiesAndRuns()
    {
        const string Source = """
            package Issue2927Nested
            import System

            func text(value int32?) string { if value == nil { return "nil" } return value.ToString() }
            func inner() sequence[int32?] {
                yield 3
                yield nil
            }

            func outer() sequence[sequence[int32?]] { yield inner() }
            for group in outer() {
                for value in group { Console.WriteLine(text(value)) }
            }
            """;

        AssertEmittedProgram(Source, "3\nnil\n", nameof(NestedNullableSequenceGuardLoadsVerifiesAndRuns));
    }

    [Fact]
    public void UnconstrainedNullableSequenceOutsideIteratorStillReportsSingleGS0508()
    {
        const string Source = """
            package Issue2927DiagnosticGuard
            func consume[T](values sequence[T?]) int32 -> 1
            """;

        AssertSingleGS0508(Source, nameof(UnconstrainedNullableSequenceOutsideIteratorStillReportsSingleGS0508));
    }

    [Fact]
    public void UnconstrainedNullableSequenceNonIteratorReturnStillReportsGS0508()
    {
        const string Source = """
            package Issue2927NonIteratorReturnDiagnosticGuard
            func consume[T]() sequence[T?] -> nil
            """;

        var result = InvokeCompiler(Source, nameof(UnconstrainedNullableSequenceNonIteratorReturnStillReportsGS0508));
        Assert.NotEqual(0, result.ExitCode);
        Assert.Equal(1, result.Output.Split(Environment.NewLine).Count(line => line.Contains("error GS0508:", StringComparison.Ordinal)));
        Assert.Equal(1, result.Output.Split(Environment.NewLine).Count(line => line.Contains("error GS0155:", StringComparison.Ordinal)));
        Assert.False(File.Exists(result.AssemblyPath));
    }

    [Fact]
    public void UnconstrainedEnclosingTypeParameterIteratorStillReportsSingleGS0508()
    {
        const string Source = """
            package Issue2927EnclosingTypeDiagnosticGuard
            class Box[T] {
                func values(value T) sequence[T?] {
                    yield value
                    yield nil
                }
            }
            """;

        AssertSingleGS0508(Source, nameof(UnconstrainedEnclosingTypeParameterIteratorStillReportsSingleGS0508));
    }

    [Fact]
    public void SpecializedIteratorBodyDiagnosticIsReportedOnce()
    {
        const string Source = """
            package Issue2927DiagnosticDeduplication
            func values[T](value T) sequence[T?] { yield missing }
            """;

        var result = InvokeCompiler(Source, nameof(SpecializedIteratorBodyDiagnosticIsReportedOnce));
        Assert.NotEqual(0, result.ExitCode);
        Assert.Equal(1, result.Output.Split(Environment.NewLine).Count(line => line.Contains("error GS0125:", StringComparison.Ordinal)));
        Assert.DoesNotContain("error GS0508:", result.Output, StringComparison.Ordinal);
        Assert.False(File.Exists(result.AssemblyPath));
    }

    [Fact]
    public void UnconstrainedGenericCallsCharacterizeSpecializedIteratorDiagnostics()
    {
        const string InferredSource = """
            package Issue2927InferredDiagnostic
            func opt[T](v T) sequence[T?] {
                yield v
                yield nil
            }
            func relay[U](u U) { let values = opt(u) }
            """;
        const string NamedSource = """
            package Issue2927NamedDiagnostic
            func opt[T](v T) sequence[T?] {
                yield v
                yield nil
            }
            func relay[U](u U) { let values = opt(v: u) }
            """;
        const string ExplicitSource = """
            package Issue2927ExplicitDiagnostic
            func opt[T](v int32) sequence[T?] {
                yield nil
            }
            func relay[U]() { let values = opt[U](1) }
            """;
        const string AsyncSource = """
            package Issue2927AsyncDiagnostic
            async func opt[T](v T) async sequence[T?] {
                yield v
                yield nil
            }
            func relay[U](u U) { let values = opt(u) }
            """;
        const string NullableSource = """
            package Issue2927NullableArgumentDiagnostic
            func opt[T](v T) sequence[T?] {
                yield v
                yield nil
            }
            let value int32? = 1
            let values = opt[int32?](2)
            """;

        AssertSingleDiagnostic(
            InvokeCompiler(InferredSource, nameof(UnconstrainedGenericCallsCharacterizeSpecializedIteratorDiagnostics) + "_inferred"),
            "GS0505",
            "type parameter 'U' is not constrained");
        AssertSingleDiagnostic(
            InvokeCompiler(NamedSource, nameof(UnconstrainedGenericCallsCharacterizeSpecializedIteratorDiagnostics) + "_named"),
            "GS0505",
            "type parameter 'U' is not constrained");
        AssertSingleDiagnostic(
            InvokeCompiler(ExplicitSource, nameof(UnconstrainedGenericCallsCharacterizeSpecializedIteratorDiagnostics) + "_explicit"),
            "GS0505",
            "type parameter 'U' is not constrained");
        AssertSingleDiagnostic(
            InvokeCompiler(AsyncSource, nameof(UnconstrainedGenericCallsCharacterizeSpecializedIteratorDiagnostics) + "_async"),
            "GS0505",
            "type parameter 'U' is not constrained");
        AssertSingleDiagnostic(
            InvokeCompiler(NullableSource, nameof(UnconstrainedGenericCallsCharacterizeSpecializedIteratorDiagnostics) + "_nullable"),
            "GS0152",
            "does not satisfy the 'struct' constraint.");
    }

    [Fact]
    public void UnconstrainedInstanceNullableIteratorCallReportsGS0505()
    {
        const string Source = """
            package Issue2958InstanceDiagnostic
            class Box {
                func opt[T](v T) sequence[T?] {
                    yield v
                    yield nil
                }
            }
            func relay[U](box Box, u U) { let values = box.opt(u) }
            """;

        AssertSingleDiagnostic(
            InvokeCompiler(Source, nameof(UnconstrainedInstanceNullableIteratorCallReportsGS0505)),
            "GS0505",
            "type parameter 'U' is not constrained");
    }

    [Fact]
    public void UserWrittenOverloadAmbiguityStillReportsGS0266()
    {
        const string Source = """
            package Issue2958UserAmbiguityGuard
            func pick(value int32, left int32 = 0) int32 -> 1
            func pick(value int32, right string = "") int32 -> 2
            let result = pick(1)
            """;

        AssertSingleDiagnostic(
            InvokeCompiler(Source, nameof(UserWrittenOverloadAmbiguityStillReportsGS0266)),
            "GS0266",
            "Disambiguate with explicit types or named arguments.");
    }

    [Fact]
    public void MixedNullableIteratorCandidateSetStillReportsGS0266()
    {
        const string Source = """
            package Issue2958MixedAmbiguityGuard
            import System
            func opt[T](v T) sequence[T?] {
                yield v
                yield nil
            }
            func opt[T class](v T, fallback int32 = 0) sequence[T?] {
                throw Exception()
            }
            func relay[U](u U) { let values = opt(u) }
            """;

        AssertSingleDiagnostic(
            InvokeCompiler(Source, nameof(MixedNullableIteratorCandidateSetStillReportsGS0266)),
            "GS0266",
            "Disambiguate with explicit types or named arguments.");
    }

    [Fact]
    public void MultipleNullableIteratorDeclarationsStillReportGS0266()
    {
        const string Source = """
            package Issue2958MultipleIteratorAmbiguityGuard
            func opt[T](v T, left int32 = 0) sequence[T?] {
                yield v
                yield nil
            }
            func opt[T](v T, right string = "") sequence[T?] {
                yield v
                yield nil
            }
            func relay[U](u U) { let values = opt(u) }
            """;

        AssertSingleDiagnostic(
            InvokeCompiler(Source, nameof(MultipleNullableIteratorDeclarationsStillReportGS0266)),
            "GS0266",
            "Disambiguate with explicit types or named arguments.");
    }

    private static void AssertEmittedProgram(string source, string expected, string name)
    {
        var assemblyPath = Compile(source, name);
        IlVerifier.Verify(assemblyPath);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal(expected, RunBounded(assemblyPath, name));
    }

    private static void AssertSpecializedMethods(Type[] types, string methodName, Type openReturnType)
    {
        var methods = types
            .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            .Where(method => method.Name == methodName)
            .ToArray();
        Assert.Equal(2, methods.Length);

        var referenceMethod = methods.Single(method =>
            (method.GetGenericArguments()[0].GenericParameterAttributes & GenericParameterAttributes.ReferenceTypeConstraint) != 0);
        var valueMethod = methods.Single(method =>
            (method.GetGenericArguments()[0].GenericParameterAttributes & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0);

        Assert.Equal(openReturnType, referenceMethod.ReturnType.GetGenericTypeDefinition());
        Assert.True(referenceMethod.ReturnType.GetGenericArguments()[0].IsGenericParameter);
        Assert.Equal(openReturnType, valueMethod.ReturnType.GetGenericTypeDefinition());
        AssertNullableGenericParameter(valueMethod.ReturnType.GetGenericArguments()[0]);
    }

    private static void AssertSpecializedIteratorInterfaces(Type[] types, Type openInterface)
    {
        var elements = types
            .SelectMany(type => type.GetInterfaces())
            .Where(@interface => @interface.IsGenericType && @interface.GetGenericTypeDefinition() == openInterface)
            .Select(@interface => @interface.GetGenericArguments()[0])
            .ToArray();

        Assert.Contains(elements, element => element.IsGenericParameter);
        Assert.Contains(elements, IsNullableGenericParameter);
    }

    private static void AssertNullableGenericParameter(Type type)
        => Assert.True(IsNullableGenericParameter(type), $"Expected Nullable<T>, got '{type}'.");

    private static bool IsNullableGenericParameter(Type type)
        => type.IsGenericType
        && type.GetGenericTypeDefinition() == typeof(Nullable<>)
        && type.GetGenericArguments()[0].IsGenericParameter;

    private static void AssertParity(string source, string expected, string name)
    {
        var assemblyPath = Compile(source, name);
        IlVerifier.Verify(assemblyPath);
        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        Assert.NotEmpty(assembly.GetTypes());
        Assert.Equal($"{expected}{Environment.NewLine}{expected}{Environment.NewLine}", RunBounded(assemblyPath, name));
    }

    private static string Compile(string source, string name)
    {
        var result = InvokeCompiler(source, name);
        Assert.True(result.ExitCode == 0, $"{name}: gsc failed:\n{result.Output}");
        return result.AssemblyPath;
    }

    private static void AssertSingleGS0508(string source, string name)
    {
        var result = InvokeCompiler(source, name);
        Assert.NotEqual(0, result.ExitCode);
        var diagnostics = result.Output.Split(Environment.NewLine)
            .Where(line => line.Contains("error GS", StringComparison.Ordinal))
            .ToArray();
        Assert.Single(diagnostics);
        Assert.Contains("error GS0508:", diagnostics[0], StringComparison.Ordinal);
        Assert.False(File.Exists(result.AssemblyPath), "gsc must not emit an assembly after GS0508");
    }

    private static void AssertSingleDiagnostic(
        (int ExitCode, string Output, string AssemblyPath) result,
        string id,
        string message)
    {
        Assert.NotEqual(0, result.ExitCode);
        var diagnostics = result.Output.Split(Environment.NewLine)
            .Where(line => line.Contains("error GS", StringComparison.Ordinal))
            .ToArray();
        Assert.Single(diagnostics);
        Assert.Contains($"error {id}:", diagnostics[0], StringComparison.Ordinal);
        Assert.Contains(message, diagnostics[0], StringComparison.Ordinal);
        Assert.False(File.Exists(result.AssemblyPath));
    }

    private static (int ExitCode, string Output, string AssemblyPath) InvokeCompiler(string source, string name)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue2927NullableSequenceElementTypeTests), name);
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);
        File.Delete(assemblyPath);
        File.Delete(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousErr = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }

        return (exitCode, stdout.ToString() + stderr.ToString(), assemblyPath);
    }

    private static string RunBounded(string assemblyPath, string name)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                assemblyPath,
            },
            WorkingDirectory = Path.GetDirectoryName(assemblyPath),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });

        Assert.NotNull(process);
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        var exited = process.WaitForExit(30_000);
        if (!exited)
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
        }

        Assert.True(exited, $"{name}: emitted program timed out");
        var output = outputTask.GetAwaiter().GetResult();
        var error = errorTask.GetAwaiter().GetResult();
        Assert.True(process.ExitCode == 0, $"{name}: emitted program failed:\n{error}");
        return output.ReplaceLineEndings(Environment.NewLine);
    }
}
