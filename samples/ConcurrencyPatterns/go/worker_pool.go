package main

import (
	"fmt"
	"sync"
)

func runPool(count int) int {
	jobs, results := make(chan int, 4), make(chan int, 4)
	var stages, workers sync.WaitGroup
	stages.Go(func() {
		defer close(jobs)
		for value := range count {
			jobs <- value
		}
	})
	for range 4 {
		workers.Go(func() {
			for job := range jobs {
				results <- job * 2
			}
		})
	}
	stages.Go(func() {
		workers.Wait()
		close(results)
	})
	seen, sum := make(map[int]bool), 0
	for value := range results {
		verify(!seen[value], "duplicate result")
		seen[value] = true
		sum += value
	}
	stages.Wait()
	verify(len(seen) == count, "lost work")
	return sum
}

func workerPoolExample() {
	verify(runPool(0) == 0, "empty pool")
	verify(runPool(40) == 1560, "pool result")
	fmt.Println("worker-pool count=40 sum=1560 empty=0")
}
