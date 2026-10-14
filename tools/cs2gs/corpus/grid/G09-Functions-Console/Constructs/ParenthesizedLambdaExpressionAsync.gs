// inventory: ParenthesizedLambdaExpression

package Corpus.Grid09

import System
import System.Threading.Tasks

shared class ParenthesizedLambdaExpressionAsyncFixture {
    func Run() {
        // Async lambda probe; awaits an already-completed task so the
        // result is synchronous and deterministic.
        let f async () -> int32 = async () -> {
            let forty = await Task.FromResult(40)
            return forty + 2
        }
        Console.WriteLine("ParenthesizedLambdaExpressionAsync: result=${f().GetAwaiter().GetResult()}")
    }
}
