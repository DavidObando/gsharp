// inventory: CastExpression

package Corpus.Grid02

import System

shared class CastExpressionFixture {
    func Run() {
        let pi = 3.9
        let truncated = int32(pi)
        let seven = 7
        let half = float64(seven) / float64(2.0)
        let code = 66
        let letter = char(code)
        let wide = 300
        let narrowed = uint8(wide)
        Console.WriteLine("CastExpression: truncated=$truncated half=$half letter=$letter narrowed=$narrowed")
    }
}
