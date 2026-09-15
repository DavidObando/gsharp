package Patterns

import Gsharp.Concurrency
import System
import System.Threading

class PipelineState {
    public var Exited int32
}

func pipelineProduce(count int32, output out chan[int32], state PipelineState, context Context) {
    try {
        for value in 0 ... count {
            output <- value
        }
    } catch (e OperationCanceledException) {
        if !context.IsCancelled {
            rethrow
        }
    } finally {
        output.Close()
        Interlocked.Increment(ref state.Exited)
    }
}

func pipelineDouble(input in chan[int32], output out chan[int32], state PipelineState, context Context) {
    try {
        for value in input {
            output <- value * 2
        }
    } catch (e OperationCanceledException) {
        if !context.IsCancelled {
            rethrow
        }
    } finally {
        output.Close()
        Interlocked.Increment(ref state.Exited)
    }
}

func runPipeline(size int32, stopAfter int32)(int32, int32) {
    let first = chan[int32](2)
    let second = chan[int32](2)
    let state = PipelineState()
    var count = 0
    var sum = 0
    scope {
        go pipelineProduce(size, first, state, ctx)
        go pipelineDouble(first, second, state, ctx)
        for value in second {
            count++
            sum += value
            if stopAfter > 0 && count == stopAfter {
                ctx.TryCancel()
                break
            }
        }
    }
    verify(state.Exited == 2, "pipeline did not join both stages")
    return (count, sum)
}

func pipelineExample() {
    let (empty, _) = runPipeline(0, 0)
    let (complete, total) = runPipeline(8, 0)
    let (partial, subtotal) = runPipeline(100, 3)
    verify(empty == 0 && complete == 8 && total == 56, "pipeline completion")
    verify(partial == 3 && subtotal == 6, "pipeline cancellation")
    Console.WriteLine("pipeline full=8/56 cancelled=3/6 joined=2 empty=0")
}
