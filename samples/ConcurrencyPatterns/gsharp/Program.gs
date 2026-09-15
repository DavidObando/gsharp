package Patterns

import System

func verify(condition bool, message string) {
    if !condition {
        throw InvalidOperationException(message)
    }
}

let argv = Environment.GetCommandLineArgs()
if argv.Length != 2 {
    Console.Error.WriteLine("Usage: Patterns <pattern-id>")
    Environment.ExitCode = 2
} else {
    switch argv[1] {
        case "worker-pool" {
            workerPoolExample()
        }
        case "bounded" {
            boundedExample()
        }
        case "pipeline" {
            pipelineExample()
        }
        case "fan-in" {
            fanInExample()
        }
        case "ttl-cache" {
            ttlCacheExample()
        }
        case "rate-limit" {
            rateLimitExample()
        }
        case "all" {
            allExample()
        }
        case "timeout" {
            timeoutExample()
        }
        case "ownership" {
            ownershipExample()
        }
        case "atomic-lazy" {
            atomicLazyExample()
        }
        case _ {
            Console.Error.WriteLine("Unknown pattern: " + argv[1])
            Environment.ExitCode = 2
        }
    }
}
