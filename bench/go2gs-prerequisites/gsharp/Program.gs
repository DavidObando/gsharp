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
}

func report(name string, elapsed TimeSpan, count int32, allocated int64, checksum int64) {
    let ns = elapsed.TotalNanoseconds / float64(count)
    let bytes = float64(allocated) / float64(count)
    Console.WriteLine(
        "perf " + name + " "
        + ns.ToString("F2", CultureInfo.InvariantCulture) + " "
        + bytes.ToString("F2", CultureInfo.InvariantCulture) + " "
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
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        let view = values[1 .. 3]
        view[0] += 1
        checksum += view[0]
    }
    sw.Stop()
    report("slice-view", sw.Elapsed, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchSliceAppend(count int32) {
    var values = slice[int32].Create(0, 1)
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        values = values.Append(i)
    }
    sw.Stop()
    report("slice-append", sw.Elapsed, count, GC.GetAllocatedBytesForCurrentThread() - before, int64(values.Length))
}

func benchManaged(count int32) {
    var value = 0
    let location = managed(value)
    for warmup in 0 ... 20000 {
        *location += 1
    }
    var checksum int64
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        *location += 1
        checksum += *location
    }
    sw.Stop()
    report("managed-location", sw.Elapsed, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchManagedConstruction(count int32) {
    let values = slice[int32]{1}
    var checksum int64
    for warmup in 0 ... 20000 {
        let location = managed(values[0])
        checksum += *location
    }
    checksum = 0
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        let location = managed(values[0])
        checksum += *location
    }
    sw.Stop()
    report("managed-create", sw.Elapsed, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchAdaptReference(count int32) {
    let source = ReferenceCounter(0)
    let counter = adapt[Counter](source)
    for warmup in 0 ... 20000 {
        counter.Increment()
    }
    var checksum int64
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        counter.Increment()
        checksum += counter.Read()
    }
    sw.Stop()
    report("adapt-reference", sw.Elapsed, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchNominalReference(count int32) {
    let source = ReferenceCounter(0)
    let counter Counter = ForwardingCounter(source)
    for warmup in 0 ... 20000 {
        counter.Increment()
    }
    var checksum int64
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        counter.Increment()
        checksum += counter.Read()
    }
    sw.Stop()
    report("nominal-reference", sw.Elapsed, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchAdaptLocation(count int32) {
    var source = ValueCounter{Value: 0}
    let location = managed(source)
    let counter = adapt[Counter](ref location)
    for warmup in 0 ... 20000 {
        counter.Increment()
    }
    var checksum int64
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        counter.Increment()
        checksum += counter.Read()
    }
    sw.Stop()
    report("adapt-location", sw.Elapsed, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
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
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        counter.Increment()
        checksum += counter.Read()
    }
    sw.Stop()
    report("rich-capture", sw.Elapsed, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchManualRichCapture(count int32) {
    let box = IntBox(0)
    let counter Counter = ManualRichCounter(box)
    for warmup in 0 ... 20000 {
        counter.Increment()
    }
    var checksum int64
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        counter.Increment()
        checksum += counter.Read()
    }
    sw.Stop()
    report("manual-rich-capture", sw.Elapsed, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchAdaptConstruction(count int32) {
    let source = ReferenceCounter(1)
    var checksum int64
    for warmup in 0 ... 20000 {
        let counter = adapt[Counter](source)
        checksum += counter.Read()
    }
    checksum = 0
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        let counter = adapt[Counter](source)
        checksum += counter.Read()
    }
    sw.Stop()
    report("adapt-create", sw.Elapsed, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchNominalConstruction(count int32) {
    let source = ReferenceCounter(1)
    var checksum int64
    for warmup in 0 ... 20000 {
        let counter Counter = ForwardingCounter(source)
        checksum += counter.Read()
    }
    checksum = 0
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
    for i in 0 ... count {
        let counter Counter = ForwardingCounter(source)
        checksum += counter.Read()
    }
    sw.Stop()
    report("nominal-create", sw.Elapsed, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
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
    let before = GC.GetAllocatedBytesForCurrentThread()
    let sw = Stopwatch.StartNew()
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
    report("rich-create", sw.Elapsed, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func benchManualRichConstruction(count int32) {
    let box = IntBox(1)
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
        checksum += counter.Read()
    }
    sw.Stop()
    report("manual-rich-create", sw.Elapsed, count, GC.GetAllocatedBytesForCurrentThread() - before, checksum)
}

func Main() {
    semanticWitnesses()
    if Environment.GetEnvironmentVariable("GO2GS_SPIKE_BENCH") == "1" {
        let count = 2000000
        benchSlice(count)
        benchSliceAppend(count)
        benchManaged(count)
        benchManagedConstruction(count)
        benchAdaptReference(count)
        benchNominalReference(count)
        benchAdaptLocation(count)
        benchRichCapture(count)
        benchManualRichCapture(count)
        benchAdaptConstruction(count)
        benchNominalConstruction(count)
        benchRichConstruction(count)
        benchManualRichConstruction(count)
    }
}
