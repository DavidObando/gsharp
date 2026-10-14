// inventory: DefaultExpression

package Corpus.Grid02

import System

shared class DefaultExpressionFixture {
    func Run() {
        let di = default(int32)
        let db = default(bool)
        let dd = default(float64)
        let ds string? = default(string)
        Console.WriteLine("DefaultExpression: int=$di bool=$db double=$dd stringIsNull=${ds == nil}")
    }
}
