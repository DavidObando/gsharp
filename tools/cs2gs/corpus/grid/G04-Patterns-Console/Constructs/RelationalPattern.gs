// inventory: RelationalPattern

package Corpus.Grid04.Constructs

import System

shared class RelationalPatternFixture {
    func Run() {
        let temps[]int32 = []int32{-10, 0, 15, 22, 30, 41}
        for t in temps {
            // The final arm is a discard rather than `>= 30`: gsc requires
            // switch expressions to carry a `default` arm (GS0176).
            let band = switch t {
                case < 0: "freezing"
                case <= 15: "cold"
                case < 30: "mild"
                default: "hot"
            }
            Console.WriteLine("RelationalPattern: $t degrees is $band")
        }
        let n = 8
        let positive = n > 0
        let atMostEight = n <= 8
        Console.WriteLine("RelationalPattern: 8 is > 0 = $positive, 8 is <= 8 = $atMostEight")
    }
}
