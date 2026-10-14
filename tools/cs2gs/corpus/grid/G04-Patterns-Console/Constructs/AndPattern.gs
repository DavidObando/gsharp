// inventory: AndPattern

package Corpus.Grid04.Constructs

import System

shared class AndPatternFixture {
    func Run() {
        for var n = -5; n <= 15; n += 5 {
            let inRange = n > 0 && n < 10
            Console.WriteLine("AndPattern: $n is > 0 and < 10 = $inRange")
        }
        let boxed object = 7
        let intAndBig = boxed is int32 && boxed > 3
        Console.WriteLine("AndPattern: boxed 7 is int and > 3 = $intAndBig")
        let mid = 50
        let chained = mid >= 0 && mid <= 100 && mid != 13
        Console.WriteLine("AndPattern: 50 is >= 0 and <= 100 and not 13 = $chained")
    }
}
