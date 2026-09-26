// <copyright file="InterfaceAdaptationLanguageTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests;

public sealed class InterfaceAdaptationLanguageTests
{
    [Fact]
    public void RichMutableCapturesShareOneCellPerDynamicBinding()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            """
            package RichCaptureLocations
            import System

            interface Counter {
                func Increment();
                func Read() int32;
            }
            interface Reader[T] { func Read() T; }

            func Escaped(start int32) Counter {
                var value = start
                return object : Counter {
                    func Increment() { value += 1 }
                    func Read() int32 -> value
                }
            }

            func Generic[T](initial T) Reader[T] {
                var value = initial
                return object : Reader[T] {
                    func Read() T -> value
                }
            }

            func Shadowed(start int32) {
                var value = start
                let outer = object : Counter {
                    func Increment() { value += 1 }
                    func Read() int32 -> value
                }
                let nested = () -> {
                    var value = 100
                    let inner = object : Counter {
                        func Increment() { value += 1 }
                        func Read() int32 -> value
                    }
                    inner.Increment()
                    Console.WriteLine(inner.Read())
                }
                nested()
                outer.Increment()
                Console.WriteLine(outer.Read())
            }

            func Main() {
                var value = 1
                let alias = managed(value)
                let sibling = () -> { value += 10 }
                let first = object : Counter {
                    let Snapshot = value
                    func Increment() { value += 1 }
                    func Read() int32 -> value
                }
                let second = object : Counter {
                    let Snapshot = value
                    func Increment() { value += 100 }
                    func Read() int32 -> value
                }
                *alias = 5
                sibling()
                first.Increment()
                second.Increment()
                Console.WriteLine(first.Snapshot)
                Console.WriteLine(second.Snapshot)
                Console.WriteLine(value)
                Console.WriteLine(first.Read())
                Console.WriteLine(Object.ReferenceEquals(first, second))

                var readers = slice[Counter].Create(0, 2)
                for i in 0 ... 2 {
                    var iteration = i
                    let reader = object : Counter {
                        func Increment() { iteration += 1 }
                        func Read() int32 -> iteration
                    }
                    readers = readers.Append(reader)
                }
                readers[0].Increment()
                Console.WriteLine(readers[0].Read())
                Console.WriteLine(readers[1].Read())

                let escaped = Escaped(30)
                GC.Collect()
                escaped.Increment()
                Console.WriteLine(escaped.Read())
                let separate = Escaped(40)
                escaped.Increment()
                Console.WriteLine(separate.Read())

                Shadowed(2)

                let text = Generic[string?](nil)
                Console.WriteLine(text.Read() == nil)
                Console.WriteLine(Generic[string]("generic").Read())
            }
            """,
            "rich-capture-locations",
            executable: true);

        IlVerifier.Verify(dll);
        Assert.Equal("1\n1\n116\n116\nFalse\n1\n1\n31\n40\n101\n3\nTrue\ngeneric\n", fixture.Run(dll));
    }

    [Fact]
    public void RichConstructionReusesCaptureLocationOutsideMeasuredLoop()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            """
            package RichCaptureAllocation
            import System

            interface Reader { func Read() int32; }

            func Main() {
                var value = 1
                var checksum int64
                for warmup in 0 ... 20000 {
                    let reader = object : Reader {
                        func Read() int32 -> value
                    }
                    checksum += reader.Read()
                }
                checksum = 0
                let before = GC.GetAllocatedBytesForCurrentThread()
                for i in 0 ... 100000 {
                    let reader = object : Reader {
                        func Read() int32 -> value
                    }
                    checksum += reader.Read()
                }
                let allocated = GC.GetAllocatedBytesForCurrentThread() - before
                Console.WriteLine(allocated / 100000)
                Console.WriteLine(checksum)
            }
            """,
            "rich-capture-allocation",
            executable: true);

        IlVerifier.Verify(dll);
        Assert.Equal("24\n100000\n", fixture.Run(dll));

        var il = LanguageConformance.NormalizedIlDump.Create(dll);
        var main = il.Split("method ")
            .Single(body => body.StartsWith("RichCaptureAllocation.<Program>::Main", System.StringComparison.Ordinal));
        var measuredLoop = main[(main.IndexOf("GetAllocatedBytesForCurrentThread", System.StringComparison.Ordinal) + 1)..];
        Assert.DoesNotContain("ManagedLocationKey::Object", measuredLoop);
        Assert.DoesNotContain("ManagedLocationKey::Field", measuredLoop);
        Assert.DoesNotContain("<>__ManagedLocation", measuredLoop);
    }

    [Fact]
    public void RichCaptureAndPersistentHandleAdaptersVerifyAndExecute()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            """
            package InterfaceAdaptation
            import System

            interface Counter {
                func Increment();
                func Read() int32;
            }

            struct Source {
                var Value int32
                func Increment() { Value += 1 }
                func Read() int32 -> Value
            }

            func Main() {
                var captured = 1
                let sibling = () -> { captured += 10 }
                let rich = object : Counter {
                    let Snapshot = captured
                    func Increment() { captured += 1 }
                    func Read() int32 -> captured
                }
                captured = 5
                rich.Increment()
                sibling()
                Console.WriteLine(rich.Snapshot)
                Console.WriteLine(rich.Read())
                Console.WriteLine(captured)

                var original = Source{Value: 20}
                let location = managed(original)
                let adapted = adapt[Counter](ref location)
                adapted.Increment()
                adapted.Increment()
                Console.WriteLine(adapted.Read())
                Console.WriteLine(original.Value)
            }
            """,
            "interface-adaptation",
            executable: true);

        IlVerifier.Verify(dll);
        Assert.Equal("1\n16\n16\n22\n22\n", fixture.Run(dll));
    }

    [Fact]
    public void EscapedAdaptNameRemainsAnOrdinaryGenericFunction()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            """
            package InterfaceAdaptationNames
            import System

            func adapt[T](value T) T -> value
            func Main() {
                Console.WriteLine($adapt[int32](42))
            }
            """,
            "interface-adaptation-names",
            executable: true);

        IlVerifier.Verify(dll);
        Assert.Equal("42\n", fixture.Run(dll));
    }

    [Fact]
    public void ImportedSourceAndTargetAreAdaptedInCallerAssembly()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var contracts = fixture.CompileCSharp(
            """
            using System;
            using System.Threading.Tasks;
            namespace AdapterContracts;
            public interface IBaseContract
            {
                int Read(int delta);
            }
            public interface IContract : IBaseContract
            {
                T Echo<T>(T value);
                int Value { get; set; }
                int this[int index] { get; set; }
                event Action<int> Changed;
            }
            public interface IReadOnlySource
            {
                int Read();
            }
            public readonly struct ReadOnlySource
            {
                private readonly int value;
                public ReadOnlySource(int value) => this.value = value;
                public int Read() => value;
            }
            public interface IAsyncSource
            {
                Task<int> Run();
                int Fail();
            }
            public sealed class AsyncSource
            {
                public Task<int> Current { get; } = Task.FromResult(81);
                public Task<int> Run() => Current;
                public int Fail() => throw new InvalidOperationException("original");
                public static AsyncSource Null() => null!;
            }
            public sealed class Source
            {
                private readonly int[] values = [1, 2, 3];
                public int Value { get; set; } = 40;
                public int Read(int delta) => Value + delta;
                public T Echo<T>(T value) => value;
                public int this[int index] { get => values[index]; set => values[index] = value; }
                public event Action<int>? Changed;
                public void Raise(int value) => Changed?.Invoke(value);
            }
            """,
            "AdapterContracts");

        var consumer = fixture.Compile(
            """
            package AdapterConsumer
            import System
            import AdapterContracts

            func Main() {
                let source = Source()
                let adapted = adapt[IContract](source)
                adapted.Value = 41
                adapted[1] = 17
                var observed = 0
                let handler = (value int32) -> { observed = value }
                adapted.Changed += handler
                source.Raise(9)
                adapted.Changed -= handler
                Console.WriteLine(adapted.Read(1))
                Console.WriteLine(adapted.Echo[string]("generic"))
                Console.WriteLine(adapted.Value)
                Console.WriteLine(adapted[1])
                Console.WriteLine(observed)

                var readonlySource = ReadOnlySource(73)
                let readonlyLocation = readonly managed(readonlySource)
                let readonlyAdapted = adapt[IReadOnlySource](ref readonlyLocation)
                Console.WriteLine(readonlyAdapted.Read())

                let asyncSource = AsyncSource()
                let asyncAdapted = adapt[IAsyncSource](asyncSource)
                Console.WriteLine(Object.ReferenceEquals(asyncSource.Current, asyncAdapted.Run()))
                try {
                    asyncAdapted.Fail()
                } catch (error InvalidOperationException) {
                    Console.WriteLine(error.Message)
                }
                try {
                    let invalid = adapt[IAsyncSource](AsyncSource.Null())
                } catch (ArgumentNullException) {
                    Console.WriteLine("null")
                }
            }
            """,
            "adapter-consumer",
            executable: true,
            "/r:" + contracts);

        IlVerifier.Verify(consumer, new[] { contracts });
        Assert.Equal("42\ngeneric\n41\n17\n9\n73\nTrue\noriginal\nnull\n", fixture.Run(consumer));
        var il = LanguageConformance.NormalizedIlDump.Create(consumer);
        var adapterBodies = il.Split("method ")
            .Where(body => body.Split('\n')[0].Contains("<>Adapter", System.StringComparison.Ordinal))
            .ToArray();
        Assert.NotEmpty(adapterBodies);
        Assert.All(adapterBodies, body =>
        {
            Assert.DoesNotContain("System.Reflection", body);
            Assert.DoesNotContain("DispatchProxy", body);
            Assert.DoesNotContain("NotImplementedException", body);
        });
        var baselineForwarders = adapterBodies
            .Where(body => body.Split('\n')[0].Contains("::Read", System.StringComparison.Ordinal))
            .ToArray();
        Assert.NotEmpty(baselineForwarders);
        Assert.All(baselineForwarders, body =>
        {
            Assert.DoesNotContain("newobj ", body);
            Assert.DoesNotContain("box ", body);
            Assert.DoesNotContain("ldftn ", body);
        });
    }

    [Fact]
    public void GenericRichCapturesAndAdaptersReifyEnclosingTypeParameters()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            """
            package GenericAdapters
            import System

            interface Reader[T] { func Read() T; }
            class Source[T](Value T) { func Read() T -> Value }

            func Rich[T](value T) Reader[T] {
                return object : Reader[T] {
                    let Snapshot = value
                    func Read() T -> value
                }
            }

            func Adapt[T](source Source[T]) Reader[T] {
                return adapt[Reader[T]](source)
            }

            func Main() {
                Console.WriteLine(Rich[string]("rich").Read())
                Console.WriteLine(Adapt[int32](Source[int32](42)).Read())
            }
            """,
            "generic-adapters",
            executable: true);

        IlVerifier.Verify(dll);
        Assert.Equal("rich\n42\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData(
        "interface I { func Read() int32; }\nclass S { }\nfunc Bad() { let x = adapt[I](S()) }",
        "missing public instance method")]
    [InlineData(
        "interface I { func Read() int32; }\nclass S { private func Read() int32 -> 1 }\nfunc Bad() { let x = adapt[I](S()) }",
        "missing public instance method")]
    [InlineData(
        "interface I { func Read(ref value int32) int32; }\nclass S { func Read(value int32) int32 -> value }\nfunc Bad() { let x = adapt[I](S()) }",
        "missing public instance method")]
    [InlineData(
        "interface I { func Read() int32; }\nfunc Bad() { var x = 1; let y = adapt[I](ref x) }",
        "managed[T]")]
    [InlineData(
        "interface I { func Read() int32; }\nclass S { func Read() int32 -> 1 }\nfunc Bad() { var x S? = nil; let y = adapt[I](x) }",
        "must be narrowed")]
    [InlineData(
        "class S { }\nfunc Bad() { let y = adapt[S](S()) }",
        "target must be an interface")]
    [InlineData(
        "interface A { func Read() int32 { return 1 } }\ninterface B { func Read() int32 { return 2 } }\ninterface I : A, B { }\nclass S { }\nfunc Bad() { let y = adapt[I](S()) }",
        "no unique most-specific")]
    public void InvalidStructuralAdaptationsDiagnoseAtTheAdaptExpression(
        string declaration,
        string expected)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(
            "package InvalidAdapters\n" + declaration,
            "invalid-adapter",
            executable: false);
        Assert.NotEqual(0, code);
        Assert.Contains("error GS0606:", output);
        Assert.Contains(expected, output);
    }

    [Fact]
    public void ImportedNullabilityStaticAndReadonlyMismatchesDiagnose()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var contracts = fixture.CompileCSharp(
            """
            namespace InvalidAdapterContracts;
            public interface INullable { string Read(string? value); }
            public sealed class Narrower { public string Read(string value) => value; }
            public interface IMutable { void Increment(); }
            public struct Mutable { public int Value; public void Increment() => Value++; }
            public interface IStatic
            {
                static abstract int Parse(string value);
            }
            """,
            "InvalidAdapterContracts");
        var (code, output) = fixture.TryCompile(
            """
            package InvalidImportedAdapters
            import InvalidAdapterContracts
            func Bad() {
                let nullable = adapt[INullable](Narrower())
                var value = Mutable()
                let location = readonly managed(value)
                let mutable = adapt[IMutable](ref location)
                let staticRequirement = adapt[IStatic](value)
            }
            """,
            "invalid-imported-adapters",
            executable: false,
            "/r:" + contracts);

        Assert.NotEqual(0, code);
        Assert.True(output.Split("error GS0606:").Length - 1 >= 3, output);
        Assert.Contains("static interface requirement", output);
    }

    [Fact]
    public void ReferenceAssemblyExposesOnlyTheRequestedInterfaceContract()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var reference = Path.Combine(fixture.Directory, "AdapterApi.ref.dll");
        var implementation = fixture.Compile(
            """
            package AdapterApi
            public interface Reader { func Read() int32; }
            public class Source(Value int32) { public func Read() int32 -> Value }
            public func Make() Reader { return adapt[Reader](Source(42)) }
            """,
            "AdapterApi",
            executable: false,
            "/refout:" + reference);
        IlVerifier.Verify(implementation);
        Assert.True(File.Exists(reference));

        var consumer = fixture.Compile(
            """
            package AdapterApiConsumer
            import System
            import AdapterApi
            Console.WriteLine(Make().Read())
            """,
            "AdapterApiConsumer",
            executable: true,
            "/r:" + reference);
        IlVerifier.Verify(consumer, new[] { implementation });
        Assert.Equal("42\n", fixture.Run(consumer));
    }

    [Fact]
    public void SourceTargetAndCallerMayLiveInThreeIndependentAssemblies()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var target = fixture.Compile(
            """
            package AdapterTarget
            public interface Reader { func Read() int32; }
            """,
            "AdapterTarget",
            executable: false);
        var source = fixture.CompileCSharp(
            """
            namespace AdapterSource;
            public sealed class ReaderSource
            {
                public int Read() => 42;
            }
            """,
            "AdapterSource");
        var caller = fixture.Compile(
            """
            package AdapterCaller
            import System
            import AdapterTarget
            import AdapterSource
            let adapted = adapt[Reader](ReaderSource())
            Console.WriteLine(adapted.Read())
            """,
            "AdapterCaller",
            executable: true,
            "/r:" + target,
            "/r:" + source);

        IlVerifier.Verify(caller, new[] { target, source });
        Assert.Equal("42\n", fixture.Run(caller));
    }
}
