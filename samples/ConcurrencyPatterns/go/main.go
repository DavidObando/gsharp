package main

import (
	"fmt"
	"os"
)

func verify(condition bool, message string) {
	if !condition {
		panic(message)
	}
}

func main() {
	patterns := map[string]func(){
		"worker-pool": workerPoolExample, "bounded": boundedExample,
		"pipeline": pipelineExample, "fan-in": fanInExample,
		"ttl-cache": ttlCacheExample, "rate-limit": rateLimitExample,
		"all": allExample, "timeout": timeoutExample,
		"ownership": ownershipExample, "atomic-lazy": atomicLazyExample,
	}
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "Usage: patterns <pattern-id>")
		os.Exit(2)
	}
	run, ok := patterns[os.Args[1]]
	if !ok {
		fmt.Fprintln(os.Stderr, "Unknown pattern:", os.Args[1])
		os.Exit(2)
	}
	run()
}
