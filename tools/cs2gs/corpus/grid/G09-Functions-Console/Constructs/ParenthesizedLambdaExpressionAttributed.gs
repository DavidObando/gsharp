// inventory: ParenthesizedLambdaExpression

package Corpus.Grid09

import System

@AttributeUsage(AttributeTargets.Method)
class TraceMarkerAttribute : Attribute { }

shared class ParenthesizedLambdaExpressionAttributedFixture {
    func Run() {
        // C#10 attributed-lambda probe.
        let f = (x int32) -> x + 1
        Console.WriteLine("ParenthesizedLambdaExpressionAttributed: result=${f(41)}")
    }
}
