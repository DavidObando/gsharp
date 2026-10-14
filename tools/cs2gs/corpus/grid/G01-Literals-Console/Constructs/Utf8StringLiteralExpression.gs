// inventory: Utf8StringLiteralExpression

package Corpus.Grid01

import System

shared class Utf8StringLiteralExpressionFixture {
    func Run() {
        let data = []uint8{0x61, 0x62, 0x63}
        Console.WriteLine("Utf8StringLiteralExpression: length=" + data.Length.ToString())
        Console.WriteLine("Utf8StringLiteralExpression: first=" + data[0].ToString())
    }
}
