package main

import (
	"fmt"
	"sync"
)

func ownedProduce(output chan<- int, count int) {
	defer close(output)
	for value := range count {
		output <- value
	}
}

func runOwned(count int) int {
	channel := make(chan int, 2)
	var reader <-chan int = channel
	var producer sync.WaitGroup
	producer.Go(func() { ownedProduce(channel, count) })
	seen, sum := 0, 0
	for value := range reader {
		seen++
		sum += value
	}
	producer.Wait()
	zero, ok := <-reader
	verify(seen == count && !ok && zero == 0, "closure is not a data sentinel")
	return sum
}

func ownershipExample() {
	verify(runOwned(0) == 0 && runOwned(6) == 15, "owned channel output")
	fmt.Println("ownership count=6 sum=15 closed-ok=0 empty=0")
}
