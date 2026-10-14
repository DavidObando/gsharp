// inventory: IsExpression

package Corpus.Grid02

import System

shared class IsExpressionFixture {
    func Run() {
        let text object = "sample"
        let number object = 123
        let isString = text is string
        let isInt = number is int32
        let wrong = text is int32
        Console.WriteLine("IsExpression: isString=$isString isInt=$isInt wrong=$wrong")
    }
}
