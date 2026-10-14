// inventory: DefaultLiteralExpression

package Corpus.Grid01

import System

shared class DefaultLiteralExpressionFixture {
    func Run() {
        let number = default(int32)
        let flag = default(bool)
        let real = default(float64)
        let character = default(char)
        let text string? = default(string?)
        Console.WriteLine("DefaultLiteralExpression: int=$number bool=$flag double=$real")
        Console.WriteLine("DefaultLiteralExpression: charCode=${int32(character)} stringIsNull=${text == nil}")
    }
}
