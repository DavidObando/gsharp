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
	N          = 2_000_000  // buf64
	NPingPong  = 1_000_000  // 2 hand-offs per iteration: 2M hand-offs, matching G#'s rendezvous
	NClosed    = 25_000_000 // closed receive is nanoseconds; it needs the count to be measurable
	NSpawn     = 750_000
	NSelect    = 2_000_000
	NChunk64   = 32_000_000
	NChunk1k   = 75_000_000
	NPark      = 200_000 // park-scale is a memory probe, not a rate
)

// quiet suppresses report output during warm-up rounds. The runner parses the
// `[name] ms ns/op` lines, so a warm-up round must emit none of them.
var quiet bool

func report(name string, d time.Duration, ops int) {
	if quiet {
		return
	}

	fmt.Printf("[%-12s] %8.1f ms   %7.1f ns/op\n", name, float64(d.Nanoseconds())/1e6, float64(d.Nanoseconds())/float64(ops))
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
	sum := 0
	for v := range ch {
		sum += v
	}
	report("go-buf64", time.Since(start), N)
}

func chunked() {
	const N = NChunk64
	const C = 64
	ch := make(chan []int, 64)
	start := time.Now()
	go func() {
		chunk := make([]int, 0, C)
		for i := 0; i < N; i++ {
			chunk = append(chunk, i)
			if len(chunk) == C {
				ch <- chunk
				chunk = make([]int, 0, C)
			}
		}
		close(ch)
	}()
	sum := 0
	for a := range ch {
		for _, v := range a {
			sum += v
		}
	}
	report("go-chunk64", time.Since(start), N)
}

// Fair counterpart to the CLR chunk+pool stage: 1024-element chunks, pooled.
func chunked1k() {
	const N = NChunk1k
	const C = 1024
	ch := make(chan []int, 16)
	pool := make(chan []int, 32)
	start := time.Now()
	go func() {
		for b := 0; b < N/C; b++ {
			var chunk []int
			select {
			case chunk = <-pool:
			default:
				chunk = make([]int, C)
			}
			for k := 0; k < C; k++ {
				chunk[k] = b*C + k
			}
			ch <- chunk
		}
		close(ch)
	}()
	sum := 0
	for a := range ch {
		for _, v := range a {
			sum += v
		}
		select {
		case pool <- a:
		default:
		}
	}
	report("go-chunk1k", time.Since(start), N)
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
	report("go-compute", time.Since(start), N)
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
	report("go-pingpong", time.Since(start), R)
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
	report("go-closed", time.Since(start), R)
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
	report("go-spawn", time.Since(start), R)
}

func selectCost() {
	const R = NSelect
	a := make(chan int, 1024)
	b := make(chan int, 1024)
	go func() {
		for i := 0; i < R; i++ {
			a <- i
		}
	}()
	start := time.Now()
	for got := 0; got < R; {
		select {
		case <-a:
			got++
		case <-b:
			got++
		}
	}
	report("go-select2", time.Since(start), R)
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

	fmt.Printf("go=%s cores=%d\n\n", runtime.Version(), runtime.NumCPU())

	for i := 0; i < *warmup; i++ {
		quiet = true
		stdout := os.Stdout
		os.Stdout, _ = os.Open(os.DevNull)
		all()
		os.Stdout = stdout
		quiet = false
	}

	all()
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
	parkScale()
}

var _ = io.Discard
