package main

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
)

func boundedExample() {
	permits := make(chan struct{}, 3)
	var workers sync.WaitGroup
	var mu sync.Mutex
	active, peak, completed, failed := 0, 0, 0, 0
	work := func(id int) error {
		if id == 7 {
			return errors.New("expected work failure")
		}
		runtime.Gosched()
		return nil
	}
	for id := range 24 {
		permits <- struct{}{}
		workers.Go(func() {
			defer func() { <-permits }()
			mu.Lock()
			active++
			peak = max(peak, active)
			mu.Unlock()
			err := work(id)
			mu.Lock()
			if err != nil {
				failed++
			}
			active--
			completed++
			mu.Unlock()
		})
	}
	workers.Wait()
	verify(peak <= 3, "concurrency limit")
	verify(completed == 24 && failed == 1, "completion or failure accounting")
	verify(active == 0 && len(permits) == 0, "permit leak")
	fmt.Println("bounded limit=3 completed=24 failures=1 permits=3")
}
