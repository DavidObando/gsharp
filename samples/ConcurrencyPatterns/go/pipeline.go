package main

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
)

func runPipeline(size, stopAfter int) (int, int) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first, second := make(chan int, 2), make(chan int, 2)
	var stages sync.WaitGroup
	var exited atomic.Int32
	stages.Go(func() {
		defer exited.Add(1)
		defer close(first)
		for value := range size {
			select {
			case first <- value:
			case <-ctx.Done():
				return
			}
		}
	})
	stages.Go(func() {
		defer exited.Add(1)
		defer close(second)
		for {
			select {
			case value, ok := <-first:
				if !ok {
					return
				}
				select {
				case second <- value * 2:
				case <-ctx.Done():
					return
				}
			case <-ctx.Done():
				return
			}
		}
	})
	count, sum := 0, 0
	for value := range second {
		count++
		sum += value
		if stopAfter > 0 && count == stopAfter {
			cancel()
			break
		}
	}
	stages.Wait()
	verify(exited.Load() == 2, "pipeline did not join both stages")
	return count, sum
}

func pipelineExample() {
	empty, _ := runPipeline(0, 0)
	complete, total := runPipeline(8, 0)
	partial, subtotal := runPipeline(100, 3)
	verify(empty == 0 && complete == 8 && total == 56, "pipeline completion")
	verify(partial == 3 && subtotal == 6, "pipeline cancellation")
	fmt.Println("pipeline full=8/56 cancelled=3/6 joined=2 empty=0")
}
