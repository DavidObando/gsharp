// inventory: AwaitExpression — ValueTask / ValueTask<T> probe (reduced)
// Awaits over synchronously-constructed ValueTask values, plus `async`
// methods that *return* ValueTask / ValueTask<T> (issue #1918: previously
// gsc rejected the latter with GS0155 / GS0100, and awaiting a directly
// constructed ValueTask<T> ICE'd with GS9998).

package Corpus.Grid10.Constructs

import System
import System.Threading.Tasks

shared class AwaitExpressionValueTaskFixture {
    private async func TripleAsync(value int32) ValueTask[int32] {
        await Task.CompletedTask
        return value * 3
    }

    private async func NoteAsync(label string) ValueTask {
        await Task.CompletedTask
        Console.WriteLine("AwaitExpressionValueTask: $label ran")
    }

    async func RunAsync() {
        let ready = ValueTask[int32](5)
        let five = await ready
        Console.WriteLine("AwaitExpressionValueTask: ready=$five")
        let done = ValueTask.CompletedTask
        await done
        Console.WriteLine("AwaitExpressionValueTask: completed ValueTask awaited")
        let triple = await TripleAsync(5)
        Console.WriteLine("AwaitExpressionValueTask: triple=$triple")
        await NoteAsync("NoteAsync")
    }
}
