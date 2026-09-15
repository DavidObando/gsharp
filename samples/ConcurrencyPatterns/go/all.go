package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
)

func runAll(tasks ...func(context.Context) error) []error {
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	failures := make(chan error, len(tasks))
	var workers sync.WaitGroup
	for _, task := range tasks {
		workers.Go(func() {
			if err := task(ctx); err != nil {
				if errors.Is(err, context.Canceled) && ctx.Err() != nil {
					return
				}
				failures <- err
				cancel(err)
			}
		})
	}
	workers.Wait()
	close(failures)
	var result []error
	for err := range failures {
		result = append(result, err)
	}
	return result
}

func allExample() {
	successful := make(chan int, 3)
	var tasks []func(context.Context) error
	for value := 1; value <= 3; value++ {
		tasks = append(tasks, func(context.Context) error { successful <- value; return nil })
	}
	verify(len(runAll(tasks...)) == 0, "successful children")
	verify(<-successful+<-successful+<-successful == 6, "successful sum")
	verify(len(runAll()) == 0, "empty all")
	verify(len(runAll(func(context.Context) error { return context.Canceled })) == 1,
		"unrequested cancellation must remain a failure")
	output := make(chan int, 1)
	ready, started := make(chan struct{}, 1), make(chan struct{}, 1)
	var exited atomic.Int32
	failures := runAll(
		func(context.Context) error {
			output <- 7
			ready <- struct{}{}
			return nil
		},
		func(ctx context.Context) error {
			defer exited.Add(1)
			started <- struct{}{}
			<-ctx.Done()
			return ctx.Err()
		},
		func(context.Context) error {
			<-ready
			<-started
			return errors.New("expected failure")
		},
	)
	verify(len(failures) == 1 && failures[0].Error() == "expected failure", "failure propagation")
	verify(exited.Load() == 1 && <-output == 7, "join")
	fmt.Println("all success=6 failures=1 blocked-child-joined=1 empty=0")
}
