// inventory: NumericLiteralExpression

package Corpus.Grid01

import System

shared class NumericLiteralExpressionFixture {
    func Run() {
        let plain = 42
        let big = 9_000_000_000L
        let unsignedBig = 18446744073709551615UL
        let unsignedInt = 4000000000u
        let hex = 0xFF
        let binary = 0b1010_1010
        let separated = 1_000_000
        let d = 3.14159
        let f = 2.5f
        let m = 19.99m
        let sci = 1.5e3
        Console.WriteLine("NumericLiteralExpression: int=$plain long=$big sep=$separated")
        Console.WriteLine("NumericLiteralExpression: ulong=$unsignedBig uint=$unsignedInt")
        Console.WriteLine("NumericLiteralExpression: hex=$hex binary=$binary")
        Console.WriteLine("NumericLiteralExpression: double=$d float=$f sci=$sci")
        Console.WriteLine("NumericLiteralExpression: decimal=$m")
    }
}
