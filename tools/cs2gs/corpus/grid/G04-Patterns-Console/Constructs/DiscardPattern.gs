// inventory: DiscardPattern
// NOTE: quarantined sub-case: a bare-type switch-expression arm (`int => ...`)
// fails stage 1 with CS2GS-GAP "pattern 'TypePattern' has no canonical G# form
// yet (ADR-0115 §B)". Only discard arms alongside constant/relational arms are
// kept below.

package Corpus.Grid04.Constructs

import System

shared class DiscardPatternFixture {
    func Run() {
        for var i = 0; i <= 2; i++ {
            let label = switch i {
                case 0: "zero"
                default: "nonzero"
            }
            Console.WriteLine("DiscardPattern: $i -> $label")
        }
        let temp = -5
        let sign = switch temp {
            case < 0: "negative"
            default: "non-negative"
        }
        Console.WriteLine("DiscardPattern: $temp -> $sign")
    }
}
