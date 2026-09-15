package main

import (
	"fmt"
	"sync"
	"sync/atomic"
)

func atomicLazyExample() {
	var count, factories atomic.Int32
	value := sync.OnceValue(func() int {
		factories.Add(1)
		return 42
	})
	verify(factories.Load() == 0, "eager initialization")
	var workers sync.WaitGroup
	for range 40 {
		workers.Go(func() {
			verify(value() == 42, "lazy result")
			count.Add(1)
		})
	}
	workers.Wait()
	verify(count.Load() == 40 && factories.Load() == 1, "atomic count or initialization")
	verify(value() == 42 && factories.Load() == 1, "repeated lazy read")
	fmt.Println("atomic-lazy count=40 factories=1 value=42")
}
