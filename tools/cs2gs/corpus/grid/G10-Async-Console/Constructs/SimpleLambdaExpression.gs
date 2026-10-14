// inventory: SimpleLambdaExpression — async lambdas (simple and parenthesized forms)
// Async lambdas stored in Func<...> delegates: an expression-bodied simple
// lambda, a block-bodied parenthesized lambda, and a zero-parameter async
// lambda returning Task. All are invoked and awaited sequentially.

package Corpus.Grid10.Constructs

import System
import System.Threading.Tasks

shared class SimpleLambdaExpressionFixture {
    async func RunAsync() {
        let twice async (int32) -> int32 = async (x int32) -> await Task.FromResult(x * 2)
        let doubled = await twice(15)
        Console.WriteLine("SimpleLambdaExpression: doubled=$doubled")
        let combine async (int32, int32) -> int32 = async (a int32, b int32) -> {
            let left = await Task.FromResult(a)
            let right = await Task.FromResult(b)
            return left + right
        }
        let combined = await combine(19, 23)
        Console.WriteLine("SimpleLambdaExpression: combined=$combined")
        let announce async () -> void = async () -> {
            await Task.CompletedTask
            Console.WriteLine("SimpleLambdaExpression: zero-arg async lambda ran")
        }
        await announce()
    }
}
