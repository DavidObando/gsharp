package main

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

func timeoutExample() {
	ready := make(chan int, 1)
	ready <- 42
	timer := time.NewTimer(time.Minute)
	value := 0
	select {
	case value = <-ready:
	case <-timer.C:
		panic("ready value timed out")
	}
	timer.Stop()
	verify(value == 42, "ready result")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	var exited atomic.Int32
	var worker sync.WaitGroup
	started := make(chan struct{}, 1)
	worker.Go(func() {
		defer exited.Add(1)
		started <- struct{}{}
		<-ctx.Done()
	})
	<-started
	timedOut := false
	select {
	case <-ready:
		panic("unexpected result")
	case <-ctx.Done():
		timedOut = true
	}
	cancel()
	worker.Wait()

	early, stop := context.WithCancel(context.Background())
	stop()
	cancelled := false
	select {
	case <-ready:
		panic("unexpected cancellation result")
	case <-early.Done():
		cancelled = true
	}
	verify(timedOut && cancelled && exited.Load() == 1, "timeout cleanup")
	fmt.Println("timeout ready=42 deadline=1 cancellation=1 joined=1")
}
