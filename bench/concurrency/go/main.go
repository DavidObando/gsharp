package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"runtime"
	"sync"
	"time"
)

// Issue #3902: per-scenario counts, matched to the G# side so each row runs for
// roughly the same wall time on both. They used to differ by up to 10x — Go's
// closed-channel receive ran 20 000 iterations against G#'s 200 000, finishing
// in under a millisecond, which is where its ~2x launch-to-launch swing came
// from. A ratio between two rows measured over different durations is not a
// comparison of the two runtimes.
const (
	N         = 2_000_000  // buf64
	NPingPong = 1_000_000  // 2 hand-offs per iteration: 2M hand-offs, matching G#'s rendezvous
	NClosed   = 25_000_000 // closed receive is nanoseconds; it needs the count to be measurable
	NSpawn    = 750_000
	NSelect   = 2_000_000
	NChunk64  = 32_000_000
	NChunk1k  = 75_000_000
	NPark     = 200_000 // park-scale is a memory probe, not a rate
)

// quiet suppresses report output during warm-up rounds. The runner parses the
// `[name] ms ns/op` lines, so a warm-up round must emit none of them.
var quiet bool

func report(name string, d time.Duration, ops int, checksum int64) {
	if quiet {
		return
	}

	fmt.Printf(
		"[%-12s] %8.1f ms   %7.1f ns/op checksum %d\n",
		name,
		float64(d.Nanoseconds())/1e6,
		float64(d.Nanoseconds())/float64(ops),
		checksum,
	)
}

func throughput() {
	ch := make(chan int, 64)
	start := time.Now()
	go func() {
		for i := 0; i < N; i++ {
			ch <- i
		}
		close(ch)
	}()
	var sum int64
	for v := range ch {
		sum += int64(v)
	}
	report("go-buf64", time.Since(start), N, sum)
}

func chunked() {
	chunkedArrays("go-chunk64", NChunk64, 64)
}

func chunked1k() {
	chunkedArrays("go-chunk1k", NChunk1k, 1024)
}

// Shape-matched counterpart to G# chunkedArrays: fresh int32 arrays, capacity
// 64, exact tail length, indexed filling, and the same counted checksum.
func chunkedArrays(name string, count int, size int) {
	ch := make(chan []int32, 64)
	start := time.Now()
	go func() {
		for sent := 0; sent < count; {
			length := size
			if remaining := count - sent; remaining < length {
				length = remaining
			}
			chunk := make([]int32, length)
			for i := 0; i < length; i++ {
				chunk[i] = int32(sent + i)
			}
			ch <- chunk
			sent += length
		}
		close(ch)
	}()
	var sum int64
	for a := range ch {
		for _, v := range a {
			sum += int64(v)
		}
	}
	report(name, time.Since(start), count, sum)
}

// Same compute-bound stage, scalar (Go has no portable SIMD).
func computeStage() {
	const C = 1024
	ch := make(chan []float32, 16)
	pool := make(chan []float32, 32)
	start := time.Now()
	go func() {
		for b := 0; b < N/C; b++ {
			var chunk []float32
			select {
			case chunk = <-pool:
			default:
				chunk = make([]float32, C)
			}
			for k := 0; k < C; k++ {
				chunk[k] = float32(k)
			}
			ch <- chunk
		}
		close(ch)
	}()
	var s float64
	for a := range ch {
		var acc float32
		for _, x := range a {
			acc += 3.1*x*x + 1.7*x + 0.5
		}
		s += float64(acc)
		select {
		case pool <- a:
		default:
		}
	}
	report("go-compute", time.Since(start), N, int64(s))
	_ = s
}

func pingpong() {
	const R = NPingPong
	a := make(chan int)
	b := make(chan int)
	start := time.Now()
	go func() {
		for i := 0; i < R; i++ {
			v := <-a
			b <- v
		}
	}()
	for i := 0; i < R; i++ {
		a <- i
		<-b
	}
	report("go-pingpong", time.Since(start), R, 0)
}

func closedRecv() {
	const R = NClosed
	ch := make(chan int)
	close(ch)
	start := time.Now()
	n := 0
	for i := 0; i < R; i++ {
		if _, ok := <-ch; !ok {
			n++
		}
	}
	report("go-closed", time.Since(start), R, int64(n))
	_ = n
}

func spawn() {
	const R = NSpawn
	var wg sync.WaitGroup
	wg.Add(R)
	start := time.Now()
	for i := 0; i < R; i++ {
		go func() { wg.Done() }()
	}
	wg.Wait()
	report("go-spawn", time.Since(start), R, int64(R))
}

func selectCost() {
	const R = NSelect
	a := make(chan int, 1024)
	b := make(chan int, 1024)
	start := time.Now()
	go func() {
		for i := 0; i < R; i++ {
			a <- i
		}
	}()
	for got := 0; got < R; {
		select {
		case <-a:
			got++
		case <-b:
			got++
		}
	}
	report("go-select2", time.Since(start), R, 0)
}

func parkScale() {
	const P = NPark
	ch := make(chan int)
	var wg sync.WaitGroup
	wg.Add(P)
	runtime.GC()
	var m0 runtime.MemStats
	runtime.ReadMemStats(&m0)
	start := time.Now()
	for i := 0; i < P; i++ {
		go func() { <-ch; wg.Done() }()
	}
	time.Sleep(300 * time.Millisecond)
	var m1 runtime.MemStats
	runtime.ReadMemStats(&m1)
	for i := 0; i < P; i++ {
		ch <- i
	}
	wg.Wait()
	d := time.Since(start)
	fmt.Printf("[go-park     ] %d parked goroutines: %.0f ms, ~%.0f bytes/parked goroutine (heap %.0f + stack %.0f)\n",
		P, float64(d.Nanoseconds())/1e6,
		float64((m1.HeapAlloc-m0.HeapAlloc)+(m1.StackInuse-m0.StackInuse))/float64(P),
		float64(m1.HeapAlloc-m0.HeapAlloc)/float64(P),
		float64(m1.StackInuse-m0.StackInuse)/float64(P))
}

func main() {
	// Issue #3902: the G# side runs warm-up rounds before the reported one,
	// because a tiered JIT needs them. Go is ahead-of-time compiled and has no
	// equivalent, but "no equivalent" is a claim worth testing rather than
	// assuming — the scheduler's threads, the GC's pacing and the CPU's own
	// frequency ramp are all warm-up-shaped. This flag makes the question
	// measurable: compare -warmup=0 against -warmup=3.
	warmup := flag.Int("warmup", 0, "unreported rounds to run before the reported one")
	flag.Parse()
	requested := os.Getenv("GSHARP_BENCH_SCENARIO")

	fmt.Printf(
		"go=%s numcpu=%d gomaxprocs=%d\n\n",
		runtime.Version(),
		runtime.NumCPU(),
		runtime.GOMAXPROCS(0),
	)

	for i := 0; i < *warmup; i++ {
		quiet = true
		stdout := os.Stdout
		os.Stdout, _ = os.Open(os.DevNull)
		run(requested)
		os.Stdout = stdout
		quiet = false
	}

	run(requested)
}

func run(name string) {
	if name == "" {
		all()
		return
	}

	switch name {
	case "go-buf64":
		throughput()
	case "go-chunk64":
		chunked()
	case "go-chunk1k":
		chunked1k()
	case "go-compute":
		computeStage()
	case "go-pingpong":
		pingpong()
	case "go-closed":
		closedRecv()
	case "go-spawn":
		spawn()
	case "go-select2":
		selectCost()
	case "go-park":
		parkScale()
	default:
		fmt.Fprintf(os.Stderr, "unknown benchmark scenario %q\n", name)
		os.Exit(2)
	}
}

func all() {
	throughput()
	chunked()
	chunked1k()
	computeStage()
	pingpong()
	closedRecv()
	spawn()
	selectCost()
}

var _ = io.Discard
