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

type captureCounter struct {
	captured *int32
}

func (c *captureCounter) Increment()  { *c.captured++ }
func (c *captureCounter) Read() int32 { return *c.captured }

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

type manualRichPair struct {
	left   *intBox
	right  *intBox
	first  int32
	second int32
}

type richPair struct {
	left   *int32
	right  *int32
	first  int32
	second int32
}

func (c *richPair) Increment() {
	*c.left++
	*c.right++
}
func (c *richPair) Read() int32 {
	return *c.left + *c.right + c.first + c.second
}

func (c *manualRichPair) Increment() {
	c.left.value++
	c.right.value++
}
func (c *manualRichPair) Read() int32 {
	return c.left.value + c.right.value + c.first + c.second
}

func makeRichCounter(seed int32) Counter {
	captured := seed
	return &captureCounter{captured: &captured}
}

func makeManualRichCounter(seed int32) Counter {
	return &manualRichCounter{box: &intBox{value: seed}}
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

func benchManagedRetained(count int32) {
	values := []int32{1}
	retained := make([]*int32, count)
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for i := range count {
			retained[i] = &values[0]
		}
		elapsed = time.Since(start)
	})
	var checksum int64
	for _, location := range retained {
		checksum += int64(*location)
	}
	report("managed-retained", elapsed, count, allocated, allocations, checksum)
}

func benchManagedFirstIdentity(count int32) {
	values := []int32{1}
	locations := make([]*int32, count)
	for i := range count {
		locations[i] = &values[0]
	}
	expected := &values[0]
	var checksum int64
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for _, location := range locations {
			if location == expected {
				checksum++
			}
		}
		elapsed = time.Since(start)
	})
	report("managed-first-identity", elapsed, count, allocated, allocations, checksum)
}

func benchManagedWarmedIdentity(count int32) {
	values := []int32{1}
	left, right := &values[0], &values[0]
	warm := left == right
	var checksum int64
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for range count {
			if left == right {
				checksum++
			}
		}
		elapsed = time.Since(start)
	})
	if warm {
		checksum++
	}
	report("managed-warmed-identity", elapsed, count, allocated, allocations, checksum)
}

func benchManagedDirectReadOnly(count int32) {
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
	report("managed-readonly-create", elapsed, count, allocated, allocations, checksum)
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
	var counter Counter = &captureCounter{captured: &captured}
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
		var counter Counter = &captureCounter{captured: &captured}
		checksum += int64(counter.Read())
	}
	checksum = 0
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for range count {
			var counter Counter = &captureCounter{captured: &captured}
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

func benchRetainedRichConstruction(count int32) {
	captured := int32(1)
	retained := make([]Counter, count)
	var checksum int64
	for range 20_000 {
		counter := &captureCounter{captured: &captured}
		checksum += int64(counter.Read())
	}
	checksum = 0
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for i := range count {
			counter := &captureCounter{captured: &captured}
			retained[i] = counter
			checksum += int64(counter.Read())
		}
		elapsed = time.Since(start)
	})
	report("rich-create-retained", elapsed, count, allocated, allocations, checksum)
}

func benchRetainedManualRichConstruction(count int32) {
	box := &intBox{value: 1}
	retained := make([]Counter, count)
	var checksum int64
	for range 20_000 {
		counter := &manualRichCounter{box: box}
		checksum += int64(counter.Read())
	}
	checksum = 0
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for i := range count {
			counter := &manualRichCounter{box: box}
			retained[i] = counter
			checksum += int64(counter.Read())
		}
		elapsed = time.Since(start)
	})
	report("manual-rich-create-retained", elapsed, count, allocated, allocations, checksum)
}

func benchFreshRootRichConstruction(count int32) {
	var checksum int64
	for range 20_000 {
		checksum += int64(makeRichCounter(1).Read())
	}
	checksum = 0
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for range count {
			checksum += int64(makeRichCounter(1).Read())
		}
		elapsed = time.Since(start)
	})
	report("rich-create-fresh-root", elapsed, count, allocated, allocations, checksum)
}

func benchFreshRootManualRichConstruction(count int32) {
	var checksum int64
	for range 20_000 {
		checksum += int64(makeManualRichCounter(1).Read())
	}
	checksum = 0
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for range count {
			checksum += int64(makeManualRichCounter(1).Read())
		}
		elapsed = time.Since(start)
	})
	report("manual-rich-create-fresh-root", elapsed, count, allocated, allocations, checksum)
}

func benchMultipleRichConstruction(count int32) {
	left := int32(1)
	right := int32(2)
	var checksum int64
	for range 20_000 {
		counter := &richPair{left: &left, right: &right, first: left, second: right}
		checksum += int64(counter.Read())
	}
	checksum = 0
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for range count {
			counter := &richPair{left: &left, right: &right, first: left, second: right}
			checksum += int64(counter.Read())
		}
		elapsed = time.Since(start)
	})
	report("rich-create-multi", elapsed, count, allocated, allocations, checksum)
}

func benchMultipleManualRichConstruction(count int32) {
	left := &intBox{value: 1}
	right := &intBox{value: 2}
	var checksum int64
	for range 20_000 {
		counter := &manualRichPair{left: left, right: right, first: left.value, second: right.value}
		checksum += int64(counter.Read())
	}
	checksum = 0
	var elapsed time.Duration
	allocated, allocations := allocationTotals(func() {
		start := time.Now()
		for range count {
			counter := &manualRichPair{left: left, right: right, first: left.value, second: right.value}
			checksum += int64(counter.Read())
		}
		elapsed = time.Since(start)
	})
	report("manual-rich-create-multi", elapsed, count, allocated, allocations, checksum)
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
