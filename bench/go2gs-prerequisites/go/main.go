package main

import (
	"fmt"
	"os"
	"runtime"
	"time"
)

type Counter interface {
	Increment()
	Read() int32
}

type valueCounter struct {
	value int32
}

func (c *valueCounter) Increment()  { c.value++ }
func (c *valueCounter) Read() int32 { return c.value }

type referenceCounter struct {
	value int32
}

func (c *referenceCounter) Increment()  { c.value++ }
func (c *referenceCounter) Read() int32 { return c.value }

type forwardingCounter struct {
	source *referenceCounter
}

func (c *forwardingCounter) Increment()  { c.source.Increment() }
func (c *forwardingCounter) Read() int32 { return c.source.Read() }

type richCounter struct {
	captured *int32
	snapshot int32
}

func (c *richCounter) Increment()  { *c.captured++ }
func (c *richCounter) Read() int32 { return *c.captured + c.snapshot }

type intBox struct {
	value int32
}

type manualRichCounter struct {
	box *intBox
}

func (c *manualRichCounter) Increment()  { c.box.value++ }
func (c *manualRichCounter) Read() int32 { return c.box.value }

type referenceFactory struct {
	calls int32
}

func (f *referenceFactory) create(value int32) *referenceCounter {
	f.calls++
	return &referenceCounter{value: value}
}

type indexSelector struct {
	calls int32
}

func (s *indexSelector) next() int {
	s.calls++
	return 0
}

func makeLocation(value int32) *int32 {
	copy := value
	return &copy
}

func semanticWitnesses() {
	shared := make([]int32, 2, 4)
	shared[0], shared[1] = 1, 2
	window := shared[:2]
	window[0] = 9
	shared = append(shared, 3)
	fmt.Printf("semantic slice-shared %d %d %d\n", shared[0], window[0], shared[2])

	detached := make([]int32, 1, 1)
	detached[0] = 7
	oldStorage := detached
	element := &detached[0]
	detached = append(detached, 8)
	*element = 11
	fmt.Printf("semantic managed-detach %d %d %d\n", oldStorage[0], detached[0], detached[1])

	captured := int32(1)
	rich := &richCounter{captured: &captured, snapshot: captured}
	captured = 5
	rich.Increment()
	fmt.Printf("semantic rich-capture %d %d %d\n", rich.snapshot, captured, rich.Read())

	copiedSource := valueCounter{value: 10}
	copiedStorage := copiedSource
	var copied Counter = &copiedStorage
	copied.Increment()
	fmt.Printf("semantic adapt-copy %d %d\n", copied.Read(), copiedSource.value)

	retainedSource := valueCounter{value: 20}
	var retained Counter = &retainedSource
	retained.Increment()
	fmt.Printf("semantic adapt-location %d %d\n", retained.Read(), retainedSource.value)

	referenceSource := &referenceCounter{value: 30}
	var reference Counter = referenceSource
	reference.Increment()
	fmt.Printf("semantic adapt-reference %d %d\n", reference.Read(), referenceSource.value)

	independentSource := valueCounter{value: 40}
	firstStorage, secondStorage := independentSource, independentSource
	var firstCopy Counter = &firstStorage
	var secondCopy Counter = &secondStorage
	firstCopy.Increment()
	fmt.Printf(
		"semantic adapt-independent %d %d %d\n",
		firstCopy.Read(),
		secondCopy.Read(),
		independentSource.value,
	)

	firstPointee := valueCounter{value: 50}
	secondPointee := valueCounter{value: 60}
	selected := &firstPointee
	var capturedPointer Counter = selected
	selected = &secondPointee
	capturedPointer.Increment()
	fmt.Printf(
		"semantic pointer-capture %d %d %d\n",
		capturedPointer.Read(),
		firstPointee.value,
		secondPointee.value,
	)

	firstFactoryLocation := makeLocation(70)
	secondFactoryLocation := makeLocation(70)
	*firstFactoryLocation++
	fmt.Printf("semantic factory-locations %d %d\n", *firstFactoryLocation, *secondFactoryLocation)

	values := []int32{80, 81}
	selector := &indexSelector{}
	selectedElement := &values[selector.next()]
	values = values[1:]
	*selectedElement = 82
	fmt.Printf("semantic slice-selection %d %d %d\n", selector.calls, *selectedElement, values[0])

	factory := &referenceFactory{}
	for range 0 {
		var skipped Counter = factory.create(90)
		skipped.Increment()
	}
	for range 1 {
		var once Counter = factory.create(90)
		once.Increment()
	}
	fmt.Printf("semantic zero-trip-effects %d\n", factory.calls)
}

func allocationTotals(operation func()) (uint64, uint64) {
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	operation()
	runtime.ReadMemStats(&after)
	return after.TotalAlloc - before.TotalAlloc, after.Mallocs - before.Mallocs
}

func report(
	name string,
	elapsed time.Duration,
	count int32,
	allocated uint64,
	allocations uint64,
	checksum int64,
) {
	fmt.Printf("perf %s %d %d %d %d %d %d\n",
		name,
		elapsed.Nanoseconds(),
		int64(time.Second),
		count,
		allocated,
		allocations,
		checksum)
}

func benchSlice(count int32) {
	values := make([]int32, 4)
	values[1] = 1
	var checksum int64
	for range 20_000 {
		view := values[1:3]
		view[0]++
		checksum += int64(view[0])
	}
	checksum = 0
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for range count {
			view := values[1:3]
			view[0]++
			checksum += int64(view[0])
		}
		elapsed = time.Since(start)
	})
	report("slice-view", elapsed, count, allocated, allocations, checksum)
}

func benchSliceAppend(count int32) {
	values := make([]int32, 0, 1)
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for i := range count {
			values = append(values, i)
		}
		elapsed = time.Since(start)
	})
	report("slice-append", elapsed, count, allocated, allocations, int64(len(values)))
}

func benchManaged(count int32) {
	value := int32(0)
	location := &value
	for range 20_000 {
		*location++
	}
	var checksum int64
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for range count {
			*location++
			checksum += int64(*location)
		}
		elapsed = time.Since(start)
	})
	report("managed-location", elapsed, count, allocated, allocations, checksum)
}

func benchManagedConstruction(count int32) {
	values := []int32{1}
	var checksum int64
	for range 20_000 {
		location := &values[0]
		checksum += int64(*location)
	}
	checksum = 0
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for range count {
			location := &values[0]
			checksum += int64(*location)
		}
		elapsed = time.Since(start)
	})
	report("managed-create", elapsed, count, allocated, allocations, checksum)
}

func benchAdaptReference(count int32) {
	source := &referenceCounter{}
	var counter Counter = source
	for range 20_000 {
		counter.Increment()
	}
	var checksum int64
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for range count {
			counter.Increment()
			checksum += int64(counter.Read())
		}
		elapsed = time.Since(start)
	})
	report("adapt-reference", elapsed, count, allocated, allocations, checksum)
}

func benchNominalReference(count int32) {
	source := &referenceCounter{}
	var counter Counter = &forwardingCounter{source: source}
	for range 20_000 {
		counter.Increment()
	}
	var checksum int64
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for range count {
			counter.Increment()
			checksum += int64(counter.Read())
		}
		elapsed = time.Since(start)
	})
	report("nominal-reference", elapsed, count, allocated, allocations, checksum)
}

func benchAdaptLocation(count int32) {
	source := valueCounter{}
	var counter Counter = &source
	for range 20_000 {
		counter.Increment()
	}
	var checksum int64
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for range count {
			counter.Increment()
			checksum += int64(counter.Read())
		}
		elapsed = time.Since(start)
	})
	report("adapt-location", elapsed, count, allocated, allocations, checksum)
}

func benchRichCapture(count int32) {
	captured := int32(0)
	var counter Counter = &richCounter{captured: &captured}
	for range 20_000 {
		counter.Increment()
	}
	var checksum int64
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for range count {
			counter.Increment()
			checksum += int64(counter.Read())
		}
		elapsed = time.Since(start)
	})
	report("rich-capture", elapsed, count, allocated, allocations, checksum)
}

func benchManualRichCapture(count int32) {
	box := &intBox{}
	var counter Counter = &manualRichCounter{box: box}
	for range 20_000 {
		counter.Increment()
	}
	var checksum int64
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for range count {
			counter.Increment()
			checksum += int64(counter.Read())
		}
		elapsed = time.Since(start)
	})
	report("manual-rich-capture", elapsed, count, allocated, allocations, checksum)
}

func benchAdaptConstruction(count int32) {
	source := &referenceCounter{value: 1}
	var checksum int64
	for range 20_000 {
		var counter Counter = source
		checksum += int64(counter.Read())
	}
	checksum = 0
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for range count {
			var counter Counter = source
			checksum += int64(counter.Read())
		}
		elapsed = time.Since(start)
	})
	report("adapt-create", elapsed, count, allocated, allocations, checksum)
}

func benchNominalConstruction(count int32) {
	source := &referenceCounter{value: 1}
	var checksum int64
	for range 20_000 {
		var counter Counter = &forwardingCounter{source: source}
		checksum += int64(counter.Read())
	}
	checksum = 0
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for range count {
			var counter Counter = &forwardingCounter{source: source}
			checksum += int64(counter.Read())
		}
		elapsed = time.Since(start)
	})
	report("nominal-create", elapsed, count, allocated, allocations, checksum)
}

func benchRichConstruction(count int32) {
	captured := int32(1)
	var checksum int64
	for range 20_000 {
		var counter Counter = &richCounter{captured: &captured}
		checksum += int64(counter.Read())
	}
	checksum = 0
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for range count {
			var counter Counter = &richCounter{captured: &captured}
			checksum += int64(counter.Read())
		}
		elapsed = time.Since(start)
	})
	report("rich-create", elapsed, count, allocated, allocations, checksum)
}

func benchManualRichConstruction(count int32) {
	box := &intBox{value: 1}
	var checksum int64
	for range 20_000 {
		var counter Counter = &manualRichCounter{box: box}
		checksum += int64(counter.Read())
	}
	checksum = 0
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for range count {
			var counter Counter = &manualRichCounter{box: box}
			checksum += int64(counter.Read())
		}
		elapsed = time.Since(start)
	})
	report("manual-rich-create", elapsed, count, allocated, allocations, checksum)
}

func main() {
	fmt.Printf("runtime %s\n", runtime.Version())
	semanticWitnesses()
	if os.Getenv("GO2GS_SPIKE_BENCH") == "1" {
		const count int32 = 2_000_000
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
