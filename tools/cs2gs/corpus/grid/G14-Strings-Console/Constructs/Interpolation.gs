// inventory: Interpolation

package Corpus.Grid14

import System

shared class InterpolationFixture {
    func Run() {
        let a = 6
        let b = 7
        let inner = "in"
        let nested = "outer[${"inner($inner)"}]"
        let cond = if a < b {
            "less"
        } else {
            "more"
        }
        Console.WriteLine("Interpolation: sum=${a + b} product=${a * b}")
        Console.WriteLine("Interpolation: call=${inner.ToUpperInvariant()} cond=$cond")
        Console.WriteLine("Interpolation: nested=$nested")
    }
}
