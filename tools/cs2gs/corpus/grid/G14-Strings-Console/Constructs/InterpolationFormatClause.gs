// inventory: InterpolationFormatClause

package Corpus.Grid14

import System

shared class InterpolationFormatClauseFixture {
    func Run() {
        let n = 255
        let d = 3.14159
        Console.WriteLine("InterpolationFormatClause: hex=${n:X4} dec=${n:D6}")
        Console.WriteLine("InterpolationFormatClause: f2=${d:F2} padded=${d,10:F3}")
    }
}
