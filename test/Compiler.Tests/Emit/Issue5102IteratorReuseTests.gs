// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Tests
import System
import System.Collections
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Threading
import Xunit
import Xunit.Abstractions

open class Issue5102IteratorReuseTests(output ITestOutputHelper) {
    @Fact
    func FirstEnumerator_RespectsThreadAffinityAndSingleUse() {
        WithProbe(
            (probe Type) -> {
                let values = Create(probe, "Values", []object{3})
                let first = values.GetEnumerator()
                Assert.Same(values, first)
                Assert.NotSame(first, values.GetEnumerator())
                Assert.True(first.MoveNext())
                Assert.Equal(3, first.Current)
                Assert.Equal[int32]([]int32{3, 13}, values.ToArray())
                Assert.True(first.MoveNext())
                Assert.Equal(13, first.Current)
                first.Dispose()
                Assert.Equal[int32]([]int32{3, 13}, values.ToArray())
                Assert.NotSame(values, values.GetEnumerator())

                let untyped = cast[IEnumerable](Create(probe, "Values", []object{4}))
                let untypedFirst = untyped.GetEnumerator()
                Assert.Same(untyped, untypedFirst)
                Assert.True(untypedFirst.MoveNext())
                Assert.Equal(4, cast[int32](untypedFirst.Current))
                Assert.NotSame(untyped, untyped.GetEnumerator())
                cast[IDisposable](untypedFirst).Dispose()

                let crossThread = Create(probe, "Values", []object{5})
                var foreign IEnumerator[int32]? = nil
                let thread = Thread(
                    ThreadStart(
                        () -> {
                            foreign = crossThread.GetEnumerator()
                        }
                    )
                )
                thread.Start()
                Assert.True(thread.Join(10_000))
                Assert.NotNull(foreign)
                Assert.NotSame(crossThread, foreign)
                Assert.Same(crossThread, crossThread.GetEnumerator())
                Assert.Equal[int32]([]int32{5, 15}, Drain(foreign!!))
                Assert.Equal[int32]([]int32{5, 15}, crossThread.ToArray())

                let concurrent = Create(probe, "Values", []object{6})
                let owner = concurrent.GetEnumerator()
                Assert.True(owner.MoveNext())
                var left[]int32 = []int32{}
                var right[]int32 = []int32{}
                let firstThread = Thread(
                    ThreadStart(
                        () -> {
                            left = concurrent.ToArray()
                        }
                    )
                )
                let secondThread = Thread(
                    ThreadStart(
                        () -> {
                            right = concurrent.ToArray()
                        }
                    )
                )
                firstThread.Start()
                secondThread.Start()
                Assert.True(firstThread.Join(10_000))
                Assert.True(secondThread.Join(10_000))
                Assert.Equal[int32]([]int32{6, 16}, left)
                Assert.Equal[int32]([]int32{6, 16}, right)
                Assert.Equal[int32]([]int32{16}, Drain(owner))
            }
        )
    }

    @Fact
    func Replay_PreservesArgumentsReceiversAndDeferredCleanup() {
        WithProbe(
            (probe Type) -> {
                let events = List[string]()
                let values = Create(probe, "Cleanup", []object{events, false})
                Assert.Empty(events)
                let neverStarted = values.GetEnumerator()
                Assert.Same(values, neverStarted)
                neverStarted.Dispose()
                Assert.False(neverStarted.MoveNext())
                Assert.Empty(events)
                Assert.Equal[int32]([]int32{7, 8}, values.ToArray())
                Assert.Equal[string]([]string{"start", "inner", "outer"}, events)

                events.Clear()
                let early = Create(probe, "Cleanup", []object{events, false})
                let iterator = early.GetEnumerator()
                Assert.True(iterator.MoveNext())
                iterator.Dispose()
                iterator.Dispose()
                Assert.Equal[string]([]string{"start", "inner", "outer"}, events)
                Assert.False(iterator.MoveNext())
                Assert.Equal[int32]([]int32{7, 8}, early.ToArray())

                events.Clear()
                let exceptional = Create(probe, "Cleanup", []object{events, true})
                let failing = exceptional.GetEnumerator()
                Assert.True(failing.MoveNext())
                Assert.Throws[InvalidOperationException](
                    () -> {
                        failing.MoveNext()
                    }
                )
                failing.Dispose()
                Assert.Equal[string]([]string{"start", "inner", "outer"}, events)

                let disposedSequence = Create(probe, "Values", []object{9})
                cast[IDisposable](disposedSequence).Dispose()
                Assert.NotSame(disposedSequence, disposedSequence.GetEnumerator())
                Assert.Equal[int32]([]int32{9, 19}, disposedSequence.ToArray())

                let box = []int32{20}
                let captured = Create(probe, "Captured", []object{box})
                box[0] = 21
                Assert.Equal[int32]([]int32{21, 99}, captured.ToArray())
                box[0] = 22
                Assert.Equal[int32]([]int32{22, 99}, captured.ToArray())

                let receiver = Create(probe, "Receiver", []object{})
                let receiverFirst = receiver.GetEnumerator()
                Assert.Same(receiver, receiverFirst)
                Assert.Equal[int32]([]int32{30, 31}, Drain(receiverFirst))
                Assert.Equal[int32]([]int32{30, 31}, receiver.ToArray())
                let referenceReceiver = Create(probe, "ReferenceReceiver", []object{})
                Assert.Equal[int32]([]int32{70, 71}, referenceReceiver.ToArray())
                Assert.Equal[int32]([]int32{71, 72}, referenceReceiver.ToArray())
                let nested = Create(probe, "Nested", []object{})
                let nestedFirst = nested.GetEnumerator()
                Assert.Same(nested, nestedFirst)
                Assert.Equal[int32]([]int32{40, 50}, Drain(nestedFirst))
                Assert.Equal[int32]([]int32{40, 50}, nested.ToArray())
                Assert.Equal(60, cast[int32](probe.GetMethod("Explicit")!!.Invoke(nil, []object{})!!))
            }
        )
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func DeclaredIteratorProtocols_PreserveDirectAndEnumerableKickoffs(generic bool) {
        WithProbe(
            (probe Type) -> {
                let events = List[string]()
                let argument = []int32{3}
                let directName = if generic {
                    "DirectTyped"
                } else {
                    "DirectObject"
                }
                let direct = cast[IEnumerator](probe.GetMethod(directName)!!.Invoke(nil, []object{events, argument})!!)
                Assert.Empty(events)
                argument[0] = 4
                Assert.True(direct.MoveNext())
                Assert.Equal(34, cast[int32](direct.Current))
                Assert.Equal[string]([]string{"direct"}, events)
                Assert.True(direct.MoveNext())
                Assert.Equal(35, cast[int32](direct.Current))
                Assert.False(direct.MoveNext())
                cast[IDisposable](direct).Dispose()

                events.Clear()
                let neverStarted = cast[IEnumerator](
                    probe.GetMethod(directName)!!.Invoke(nil, []object{events, argument})!!
                )
                cast[IDisposable](neverStarted).Dispose()
                Assert.False(neverStarted.MoveNext())
                Assert.Empty(events)

                let nestedName = if generic {
                    "NestedDirectTyped"
                } else {
                    "NestedDirectObject"
                }
                let nested = cast[IEnumerator](probe.GetMethod(nestedName)!!.Invoke(nil, []object{events})!!)
                Assert.Empty(events)
                Assert.True(nested.MoveNext())
                Assert.Equal(40, cast[int32](nested.Current))
                Assert.Equal[string]([]string{"nested"}, events)
                Assert.True(nested.MoveNext())
                Assert.Equal(50, cast[int32](nested.Current))
                Assert.False(nested.MoveNext())
                cast[IDisposable](nested).Dispose()

                events.Clear()
                let enumerableName = if generic {
                    "EnumerableTyped"
                } else {
                    "EnumerableObject"
                }
                let enumerable = cast[IEnumerable](
                    probe.GetMethod(enumerableName)!!.Invoke(nil, []object{events, 12})!!
                )
                Assert.Empty(events)
                let first = enumerable.GetEnumerator()
                Assert.Same(enumerable, first)
                Assert.Empty(events)
                Assert.True(first.MoveNext())
                Assert.Equal(12, cast[int32](first.Current))
                Assert.False(first.MoveNext())
                cast[IDisposable](first).Dispose()
                Assert.Equal[string]([]string{"enumerable"}, events)
            }
        )
    }

    @Fact
    func FirstEnumeration_AllocatesOneFrameInsteadOfTwo() {
        WithProbe(
            (probe Type) -> {
                let factory = probe.GetMethod("One")!!.CreateDelegate[Func[IEnumerable[int32]]]()
                Measure(factory, false)
                Measure(factory, true)
                let firstBytes = Measure(factory, false)
                let freshBytes = Measure(factory, true)
                output.WriteLine("10,000 enumerations: first=$firstBytes bytes; forced-fresh=$freshBytes bytes")
                Assert.True(firstBytes > 0)
                Assert.Equal(firstBytes * 2, freshBytes)
            }
        )
    }

    shared {
        private func Measure(factory Func[IEnumerable[int32]], forceFresh bool) int64 {
            var sum = 0
            var completed = 0
            let before = GC.GetAllocatedBytesForCurrentThread()
            for var i = 0; i < 10_000; i++ {
                let values = factory()
                if forceFresh {
                    values.GetEnumerator().Dispose()
                }
                using let iterator = values.GetEnumerator()
                if iterator.MoveNext() {
                    sum = sum + iterator.Current
                }
                if !iterator.MoveNext() {
                    completed++
                }
            }
            let allocated = GC.GetAllocatedBytesForCurrentThread() - before
            Assert.Equal(10_000, sum)
            Assert.Equal(10_000, completed)
            return allocated
        }

        private func Create(probe Type, name string, args[]object) IEnumerable[int32] ->
        cast[IEnumerable[int32]](probe.GetMethod(name)!!.Invoke(nil, args)!!)

        private func Drain(iterator IEnumerator[int32])[]int32 {
            using let owned = iterator
            let result = List[int32]()
            for owned.MoveNext() {
                result.Add(owned.Current)
            }
            return result.ToArray()
        }

        private func WithProbe(check Action[Type]) {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue5102", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "probe.gs")
                let outputPath = Path.Combine(directory, "probe.dll")
                File.WriteAllText(sourcePath, Source)
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                try {
                    Console.SetOut(stdout)
                    Console.SetError(stderr)
                    Assert.True(
                        Program.Main(
                            []string{"/target:library", "/targetframework:net10.0", "/out:" + outputPath, sourcePath}
                        ) == 0,
                        "$stdout${Environment.NewLine}$stderr"
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                IlVerifier.Verify(outputPath)
                check(EmittedFixture.Load(outputPath).GetType("Issue5102.Probe")!!)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private const Source string = `package Issue5102
import System
import System.Collections
import System.Collections.Generic

struct Counter {
    var Value int32
    func Values() sequence[int32] {
        yield Value
        Value = Value + 1
        yield Value
    }

    func DirectTyped(events List[string], argument []int32) IEnumerator[int32] {
        events.Add("direct")
        yield Value + argument[0]
        Value = Value + 1
        yield Value + argument[0]
    }

    func DirectObject(events List[string], argument []int32) IEnumerator {
        events.Add("direct")
        yield Value + argument[0]
        Value = Value + 1
        yield Value + argument[0]
    }
}

class ReferenceCounter {
    var Value int32
    func Values() sequence[int32] {
        yield Value
        Value = Value + 1
        yield Value
    }
}

class Outer[T] {
    struct Inner[U] {
        var Value T
        func Values[V IComparable[V]](value V, next V) sequence[V] {
            var value = value
            yield value
            value = next
            yield value
        }

        func DirectTyped[V IComparable[V]](value V, next V, events List[string]) IEnumerator[V] {
            events.Add("nested")
            yield value
            yield next
        }

        func DirectObject[V IComparable[V]](value V, next V, events List[string]) IEnumerator {
            events.Add("nested")
            yield value
            yield next
        }
    }
}

shared class Probe {
    func Values(seed int32) sequence[int32] {
        var seed = seed
        yield seed
        seed = seed + 10
        yield seed
    }

    func One() sequence[int32] { yield 1 }

    func Captured(values []int32) sequence[int32] {
        var values = values
        yield values[0]
        values = []int32{99}
        yield values[0]
    }

    func Cleanup(events List[string], fail bool) sequence[int32] {
        events.Add("start")
        try {
            try {
                yield 7
                if fail { throw InvalidOperationException("body") }
                yield 8
            } finally { events.Add("inner") }
        } finally { events.Add("outer") }
    }

    func Receiver() sequence[int32] {
        var counter = Counter{Value: 30}
        let result = counter.Values()
        counter.Value = 90
        return result
    }

    func Nested() sequence[int32] {
        var inner = Outer[string].Inner[bool]{Value: "owner"}
        return inner.Values[int32](40, 50)
    }

    func ReferenceReceiver() sequence[int32] {
        return ReferenceCounter{Value: 70}.Values()
    }

    func Explicit() int32 {
        var inner = Outer[string].Inner[bool]{Value: "owner"}
        using let iterator = inner.Values[int32](60, 61).GetEnumerator()
        if iterator.MoveNext() { return iterator.Current }
        return -1
    }

    func DirectTyped(events List[string], argument []int32) IEnumerator[int32] {
        var counter = Counter{Value: 30}
        let result = counter.DirectTyped(events, argument)
        counter.Value = 90
        return result
    }

    func DirectObject(events List[string], argument []int32) IEnumerator {
        var counter = Counter{Value: 30}
        let result = counter.DirectObject(events, argument)
        counter.Value = 90
        return result
    }

    func NestedDirectTyped(events List[string]) IEnumerator[int32] {
        var inner = Outer[string].Inner[bool]{Value: "owner"}
        return inner.DirectTyped[int32](40, 50, events)
    }

    func NestedDirectObject(events List[string]) IEnumerator {
        var inner = Outer[string].Inner[bool]{Value: "owner"}
        return inner.DirectObject[int32](40, 50, events)
    }

    func EnumerableTyped(events List[string], value int32) IEnumerable[int32] {
        events.Add("enumerable")
        yield value
    }

    func EnumerableObject(events List[string], value int32) IEnumerable {
        events.Add("enumerable")
        yield value
    }
}`
    }
}
