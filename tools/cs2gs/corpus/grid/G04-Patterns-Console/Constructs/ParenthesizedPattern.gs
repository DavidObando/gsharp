// inventory: ParenthesizedPattern

package Corpus.Grid04.Constructs

import System

shared class ParenthesizedPatternFixture {
    func Run() {
        let values[]int32 = []int32{-3, 5, 42, 77}
        for v in values {
            let special = (v > 0 && v < 10) || v == 42
            Console.WriteLine("ParenthesizedPattern: $v is (> 0 and < 10) or 42 = $special")
        }
        let nine = 9
        let grouped = !((nine < 0 || nine > 10))
        Console.WriteLine("ParenthesizedPattern: 9 is not (< 0 or > 10) = $grouped")
    }
}
