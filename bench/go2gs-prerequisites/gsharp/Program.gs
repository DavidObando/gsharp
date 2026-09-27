package GSharp.Bench.Go2GsPrerequisites

import System
import System.Diagnostics
import System.Globalization

interface Counter {
    func Increment();

    func Read() int32;
}

struct ValueCounter {
    var Value int32
    func Increment() {
        Value += 1
    }

    func Read() int32 -> Value
}

class ReferenceCounter(Value int32) {
    func Increment() {
        Value += 1
    }

    func Read() int32 -> Value
}

class ForwardingCounter(Source ReferenceCounter) : Counter {
    func Increment() {
        Source.Increment()
    }

    func Read() int32 -> Source.Read()
}

class IntBox(Value int32) { }

class ManualRichCounter(Box IntBox) : Counter {
    func Increment() {
        Box.Value += 1
    }

    func Read() int32 -> Box.Value
}

class ReferenceFactory(Calls int32) {
    func Create(value int32) ReferenceCounter {
        Calls += 1
        return ReferenceCounter(value)
    }
}

class IndexSelector(Calls int32) {
    func Next() int32 {
        Calls += 1
        return 0
    }
}

func makeLocation(value int32) managed[int32] {
    var copy = value
    return managed(copy)
}

class ManualRichPair(Left IntBox, Right IntBox, First int32, Second int32) : Counter {
    func Increment() {
        Left.Value += 1
        Right.Value += 1
    }

    func Read() int32 -> Left.Value + Right.Value + First + Second
}

func makeRichCounter(seed int32) Counter {
    var captured = seed
    return object: Counter{
        func Increment() {
            captured += 1
        }

        func Read() int32 -> captured
    }
}

func makeManualRichCounter(seed int32) Counter -> ManualRichCounter(IntBox(seed))

func semanticWitnesses() {
    var shared = slice[int32].Create(2, 4)
    shared[0] = 1
    shared[1] = 2
    let window = shared[0 .. 2]
    window[0] = 9
    shared = shared.Append(3)
    Console.WriteLine(
        "semantic slice-shared " + shared[0].ToString() + " " + window[0].ToString() + " " + shared[2].ToString()
    )

    var detached = slice[int32].Create(1, 1)
    detached[0] = 7
    let oldStorage = detached
    let element = managed(detached[0])
    detached = detached.Append(8)
    *element = 11
    Console.WriteLine(
        "semantic managed-detach " + oldStorage[0].ToString() + " " + detached[0].ToString() +
            " " +
            detached[1].ToString()
    )

    var captured = 1
    let rich = object: Counter{
        let Snapshot = captured
        func Increment() {
            captured += 1
        }

        func Read() int32 -> captured + Snapshot
    }
    captured = 5
    rich.Increment()
    Console.WriteLine(
        "semantic rich-capture " + rich.Snapshot.ToString() + " " + captured.ToString() + " " + rich.Read().ToString()
    )

    var copiedSource = ValueCounter{Value: 10}
    let copied = adapt[Counter](copiedSource)
    copied.Increment()
    Console.WriteLine("semantic adapt-copy " + copied.Read().ToString() + " " + copiedSource.Value.ToString())

    var retainedSource = ValueCounter{Value: 20}
    let retainedLocation = managed(retainedSource)
    let retained = adapt[Counter](ref retainedLocation)
    retained.Increment()
    Console.WriteLine("semantic adapt-location " + retained.Read().ToString() + " " + retainedSource.Value.ToString())

    let referenceSource = ReferenceCounter(30)
    let reference = adapt[Counter](referenceSource)
    reference.Increment()
    Console.WriteLine(
        "semantic adapt-reference " + reference.Read().ToString() + " " + referenceSource.Value.ToString()
    )

    var independentSource = ValueCounter{Value: 40}
    let firstCopy = adapt[Counter](independentSource)
    let secondCopy = adapt[Counter](independentSource)
    firstCopy.Increment()
    Console.WriteLine(
        "semantic adapt-independent " + firstCopy.Read().ToString() + " " + secondCopy.Read().ToString() +
            " " +
            independentSource
            .Value
            .ToString()
    )

    var firstPointee = ValueCounter{Value: 50}
    var secondPointee = ValueCounter{Value: 60}
    var selected = managed(firstPointee)
    let capturedPointer = adapt[Counter](ref selected)
    selected = managed(secondPointee)
    capturedPointer.Increment()
    Console.WriteLine(
        "semantic pointer-capture " + capturedPointer.Read().ToString() + " " + firstPointee.Value.ToString() +
            " " +
            secondPointee
            .Value
            .ToString()
    )

    let firstFactoryLocation = makeLocation(70)
    let secondFactoryLocation = makeLocation(70)
    *firstFactoryLocation += 1
    Console.WriteLine(
        "semantic factory-locations " + (*firstFactoryLocation).ToString() + " " + (*secondFactoryLocation).ToString()
    )

    var values = slice[int32]{80, 81}
    let selector = IndexSelector(0)
    let selectedElement = managed(values[selector.Next()])
    values = values[1 .. 2]
    *selectedElement = 82
    Console.WriteLine(
        "semantic slice-selection " + selector.Calls.ToString() + " " + (*selectedElement).ToString() +
            " " +
            values[0].ToString()
    )

    let factory = ReferenceFactory(0)
    for i in 0 ... 0 {
        let skipped = adapt[Counter](factory.Create(90))
        skipped.Increment()
    }
    for i in 0 ... 1 {
        let once = adapt[Counter](factory.Create(90))
        once.Increment()
    }
    Console.WriteLine("semantic zero-trip-effects " + factory.Calls.ToString())
}

func report(name string, elapsedTicks int64, count int32, allocated int64, checksum int64) {
    Console.WriteLine(
        "perf " + name + " "
        + elapsedTicks.ToString(CultureInfo.InvariantCulture) + " "
        + Stopwatch.Frequency.ToString(CultureInfo.InvariantCulture) + " "
        + count.ToString(CultureInfo.InvariantCulture) + " "
        + allocated.ToString(CultureInfo.InvariantCulture) + " "
        + "-1 "
        + checksum.ToString()
    )
}

func benchSlice(count int32) {
    var values = slice[int32].Create(4, 4)
    values[1] = 1
    var checksum int64
    for warmup in 0 ... 20000 {
        let view = values[1 .. 3]
        view[0] += 1
        checksum += view[0]
    }
    checksum = 0
    let sw = Stopwatch.StartNew()
    let before = GC.GetAllocatedBytesForCurrentThread()
    for i in 0 ... count {
        let view = values[1 .. 3]
        view[0] += 1
        checksum += view[0]
    }
    sw.Stop()
    report("slice-view", sw.ElapsedTicks, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchSliceAppend(count int32) {
    var values = slice[int32].Create(0, 1)
    let sw = Stopwatch.StartNew()
    let before = GC.GetAllocatedBytesForCurrentThread()
    for i in 0 ... count {
        values = values.Append(i)
    }
    sw.Stop()
    report(
        "slice-append",
        sw.ElapsedTicks,
        count,
        GC.GetAllocatedBytesForCurrentThread() - before,
        int64(values.Length)
    )
}

func benchManaged(count int32) {
    var value = 0
    let location = managed(value)
    for warmup in 0 ... 20000 {
        *location += 1
    }
    var checksum int64
    let sw = Stopwatch.StartNew()
    let before = GC.GetAllocatedBytesForCurrentThread()
    for i in 0 ... count {
        *location += 1
        checksum += *location
    }
    sw.Stop()
    report("managed-location", sw.ElapsedTicks, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchManagedConstruction(count int32) {
    let values = slice[int32]{1}
    var checksum int64
    for warmup in 0 ... 20000 {
        let location = managed(values[0])
        checksum += *location
    }
    checksum = 0
    let sw = Stopwatch.StartNew()
    let before = GC.GetAllocatedBytesForCurrentThread()
    for i in 0 ... count {
        let location = managed(values[0])
        checksum += *location
    }
    sw.Stop()
    report("managed-create", sw.ElapsedTicks, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchManagedRetained(count int32) {
    let values = slice[int32]{1}
    var retained = [count]managed[int32]? {}
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        retained[i] = managed(values[0])
    }
    sw.Stop()
    let allocated = GC.GetAllocatedBytesForCurrentThread() - before
    var checksum int64
    for i in 0 ... count {
        checksum += *retained[i]!!
    }
    report("managed-retained", sw.ElapsedTicks, count, allocated, checksum)
}

func benchManagedFirstIdentity(count int32) {
    let values = slice[int32]{1}
    var locations = [count]managed[int32]? {}
    for i in 0 ... count {
        locations[i] = managed(values[0])
    }
    let expected = managed(values[0])
    var checksum int64
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        if locations[i]!!== expected {
            checksum += 1
        }
    }
    sw.Stop()
    report("managed-first-identity", sw.ElapsedTicks, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchManagedWarmedIdentity(count int32) {
    let values = slice[int32]{1}
    let left = managed(values[0])
    let right = managed(values[0])
    let warm = left == right
    var checksum int64
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        if left == right {
            checksum += 1
        }
    }
    sw.Stop()
    if warm {
        checksum += 1
    }
    report("managed-warmed-identity", sw.ElapsedTicks, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchManagedDirectReadOnly(count int32) {
    let values = slice[int32]{1}
    var checksum int64
    for warmup in 0 ... 20000 {
        let location = readonly managed(values[0])
        checksum += *location
    }
    checksum = 0
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        let location = readonly managed(values[0])
        checksum += *location
    }
    sw.Stop()
    report("managed-readonly-create", sw.ElapsedTicks, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchAdaptReference(count int32) {
    let source = ReferenceCounter(0)
    let counter = adapt[Counter](source)
    for warmup in 0 ... 20000 {
        counter.Increment()
    }
    var checksum int64
    let sw = Stopwatch.StartNew()
    let before = GC.GetAllocatedBytesForCurrentThread()
    for i in 0 ... count {
        counter.Increment()
        checksum += counter.Read()
    }
    sw.Stop()
    report("adapt-reference", sw.ElapsedTicks, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchNominalReference(count int32) {
    let source = ReferenceCounter(0)
    let counter Counter = ForwardingCounter(source)
    for warmup in 0 ... 20000 {
        counter.Increment()
    }
    var checksum int64
    let sw = Stopwatch.StartNew()
    let before = GC.GetAllocatedBytesForCurrentThread()
    for i in 0 ... count {
        counter.Increment()
        checksum += counter.Read()
    }
    sw.Stop()
    report("nominal-reference", sw.ElapsedTicks, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchAdaptLocation(count int32) {
    var source = ValueCounter{Value: 0}
    let location = managed(source)
    let counter = adapt[Counter](ref location)
    for warmup in 0 ... 20000 {
        counter.Increment()
    }
    var checksum int64
    let sw = Stopwatch.StartNew()
    let before = GC.GetAllocatedBytesForCurrentThread()
    for i in 0 ... count {
        counter.Increment()
        checksum += counter.Read()
    }
    sw.Stop()
    report("adapt-location", sw.ElapsedTicks, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchRichCapture(count int32) {
    var captured = 0
    let counter = object: Counter{
        func Increment() {
            captured += 1
        }

        func Read() int32 -> captured
    }
    for warmup in 0 ... 20000 {
        counter.Increment()
    }
    var checksum int64
    let sw = Stopwatch.StartNew()
    let before = GC.GetAllocatedBytesForCurrentThread()
    for i in 0 ... count {
        counter.Increment()
        checksum += counter.Read()
    }
    sw.Stop()
    report("rich-capture", sw.ElapsedTicks, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchManualRichCapture(count int32) {
    let box = IntBox(0)
    let counter Counter = ManualRichCounter(box)
    for warmup in 0 ... 20000 {
        counter.Increment()
    }
    var checksum int64
    let sw = Stopwatch.StartNew()
    let before = GC.GetAllocatedBytesForCurrentThread()
    for i in 0 ... count {
        counter.Increment()
        checksum += counter.Read()
    }
    sw.Stop()
    report("manual-rich-capture", sw.ElapsedTicks, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchAdaptConstruction(count int32) {
    let source = ReferenceCounter(1)
    var checksum int64
    for warmup in 0 ... 20000 {
        let counter = adapt[Counter](source)
        checksum += counter.Read()
    }
    checksum = 0
    let sw = Stopwatch.StartNew()
    let before = GC.GetAllocatedBytesForCurrentThread()
    for i in 0 ... count {
        let counter = adapt[Counter](source)
        checksum += counter.Read()
    }
    sw.Stop()
    report("adapt-create", sw.ElapsedTicks, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchNominalConstruction(count int32) {
    let source = ReferenceCounter(1)
    var checksum int64
    for warmup in 0 ... 20000 {
        let counter Counter = ForwardingCounter(source)
        checksum += counter.Read()
    }
    checksum = 0
    let sw = Stopwatch.StartNew()
    let before = GC.GetAllocatedBytesForCurrentThread()
    for i in 0 ... count {
        let counter Counter = ForwardingCounter(source)
        checksum += counter.Read()
    }
    sw.Stop()
    report("nominal-create", sw.ElapsedTicks, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchRichConstruction(count int32) {
    var captured = 1
    var checksum int64
    for warmup in 0 ... 20000 {
        let counter = object: Counter{
            func Increment() {
                captured += 1
            }

            func Read() int32 -> captured
        }
        checksum += counter.Read()
    }
    checksum = 0
    let sw = Stopwatch.StartNew()
    let before = GC.GetAllocatedBytesForCurrentThread()
    for i in 0 ... count {
        let counter = object: Counter{
            func Increment() {
                captured += 1
            }

            func Read() int32 -> captured
        }
        checksum += counter.Read()
    }
    sw.Stop()
    report("rich-create", sw.ElapsedTicks, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchManualRichConstruction(count int32) {
    let box = IntBox(1)
    var checksum int64
    for warmup in 0 ... 20000 {
        let counter Counter = ManualRichCounter(box)
        checksum += counter.Read()
    }
    checksum = 0
    let sw = Stopwatch.StartNew()
    let before = GC.GetAllocatedBytesForCurrentThread()
    for i in 0 ... count {
        let counter Counter = ManualRichCounter(box)
        checksum += counter.Read()
    }
    sw.Stop()
    report("manual-rich-create", sw.ElapsedTicks, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchRetainedRichConstruction(count int32) {
    var captured = 1
    let retained = slice[Counter].Create(count, count)
    var checksum int64
    for warmup in 0 ... 20000 {
        let counter = object: Counter{
            func Increment() {
                captured += 1
            }

            func Read() int32 -> captured
        }
        checksum += counter.Read()
    }
    checksum = 0
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        let counter = object: Counter{
            func Increment() {
                captured += 1
            }

            func Read() int32 -> captured
        }
        retained[i] = counter
        checksum += counter.Read()
    }
    sw.Stop()
    report("rich-create-retained", sw.ElapsedTicks, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchRetainedManualRichConstruction(count int32) {
    let box = IntBox(1)
    let retained = slice[Counter].Create(count, count)
    var checksum int64
    for warmup in 0 ... 20000 {
        let counter Counter = ManualRichCounter(box)
        checksum += counter.Read()
    }
    checksum = 0
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        let counter Counter = ManualRichCounter(box)
        retained[i] = counter
        checksum += counter.Read()
    }
    sw.Stop()
    report(
        "manual-rich-create-retained",
        sw.ElapsedTicks,
        count,
        GC.GetAllocatedBytesForCurrentThread() - before,
        checksum
    )
}

func benchFreshRootRichConstruction(count int32) {
    var checksum int64
    for warmup in 0 ... 20000 {
        checksum += makeRichCounter(1).Read()
    }
    checksum = 0
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        checksum += makeRichCounter(1).Read()
    }
    sw.Stop()
    report("rich-create-fresh-root", sw.ElapsedTicks, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchFreshRootManualRichConstruction(count int32) {
    var checksum int64
    for warmup in 0 ... 20000 {
        checksum += makeManualRichCounter(1).Read()
    }
    checksum = 0
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        checksum += makeManualRichCounter(1).Read()
    }
    sw.Stop()
    report(
        "manual-rich-create-fresh-root",
        sw.ElapsedTicks,
        count,
        GC.GetAllocatedBytesForCurrentThread() - before,
        checksum
    )
}

func benchMultipleRichConstruction(count int32) {
    var left = 1
    var right = 2
    var checksum int64
    for warmup in 0 ... 20000 {
        let counter = object: Counter{
            let First = left
            let Second = right
            func Increment() {
                left += 1
                right += 1
            }

            func Read() int32 -> left + right + First + Second
        }
        checksum += counter.Read()
    }
    checksum = 0
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        let counter = object: Counter{
            let First = left
            let Second = right
            func Increment() {
                left += 1
                right += 1
            }

            func Read() int32 -> left + right + First + Second
        }
        checksum += counter.Read()
    }
    sw.Stop()
    report("rich-create-multi", sw.ElapsedTicks, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchMultipleManualRichConstruction(count int32) {
    let left = IntBox(1)
    let right = IntBox(2)
    var checksum int64
    for warmup in 0 ... 20000 {
        let counter Counter = ManualRichPair(left, right, left.Value, right.Value)
        checksum += counter.Read()
    }
    checksum = 0
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        let counter Counter = ManualRichPair(left, right, left.Value, right.Value)
        checksum += counter.Read()
    }
    sw.Stop()
    report(
        "manual-rich-create-multi",
        sw.ElapsedTicks,
        count,
        GC.GetAllocatedBytesForCurrentThread() - before,
        checksum
    )
}

func Main() {
    Console.WriteLine("runtime " + Environment.Version.ToString())
    semanticWitnesses()
    if Environment.GetEnvironmentVariable("GO2GS_SPIKE_BENCH") == "1" {
        let count = 2000000
        benchSlice(count)
        benchSliceAppend(count)
        benchManaged(count)
        benchManagedConstruction(count)
        benchManagedRetained(count)
        benchManagedFirstIdentity(count)
        benchManagedWarmedIdentity(count)
        benchManagedDirectReadOnly(count)
        benchAdaptReference(count)
        benchNominalReference(count)
        benchAdaptLocation(count)
        benchRichCapture(count)
        benchManualRichCapture(count)
        benchAdaptConstruction(count)
        benchNominalConstruction(count)
        benchRichConstruction(count)
        benchManualRichConstruction(count)
        benchRetainedRichConstruction(count)
        benchRetainedManualRichConstruction(count)
        benchFreshRootRichConstruction(count)
        benchFreshRootManualRichConstruction(count)
        benchMultipleRichConstruction(count)
        benchMultipleManualRichConstruction(count)
    }
}
