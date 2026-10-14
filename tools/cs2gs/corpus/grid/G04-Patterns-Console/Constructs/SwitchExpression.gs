// inventory: SwitchExpression

package Corpus.Grid04.Constructs

import System

shared class SwitchExpressionFixture {
    func Run() {
        for var n = -2; n <= 4; n += 2 {
            let label = switch n {
                case < 0: "negative"
                case 0: "zero"
                case v is int32 when v % 4 == 0: "multiple of four ($v)"
                case var v: "plain positive ($v)"
            }
            Console.WriteLine("SwitchExpression: $n -> $label")
        }
        let season = switch 3 {
            case 1: "winter"
            case 2: "spring"
            case 3: "summer"
            default: "autumn"
        }
        Console.WriteLine("SwitchExpression: quarter 3 -> $season")
    }
}
