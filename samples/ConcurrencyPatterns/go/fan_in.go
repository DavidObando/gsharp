package main

import (
	"fmt"
	"sync"
)

func mergeSources(count int) int {
	output := make(chan int, 2)
	var stages, closer sync.WaitGroup
	for id := range count {
		input := make(chan int, 2)
		stages.Go(func() {
			defer close(input)
			for value := range 5 {
				input <- id*10 + value
			}
		})
		stages.Go(func() {
			for value := range input {
				output <- value
			}
		})
	}
	closer.Go(func() {
		stages.Wait()
		close(output)
	})
	seen, sum := make(map[int]bool), 0
	for value := range output {
		verify(!seen[value], "fan-in duplicated a value")
		seen[value] = true
		sum += value
	}
	closer.Wait()
	verify(len(seen) == count*5, "fan-in lost a value")
	return sum
}

func fanInExample() {
	verify(mergeSources(0) == 0, "empty fan-in")
	verify(mergeSources(3) == 180, "merged sum")
	fmt.Println("fan-in count=15 sum=180 empty=0")
}
