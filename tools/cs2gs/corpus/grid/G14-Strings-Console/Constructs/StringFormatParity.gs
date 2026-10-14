// inventory: InvocationExpression

package Corpus.Grid14

import System

shared class StringFormatParityFixture {
    func Run() {
        let id = 7
        let name = "Grace"
        let viaFormat = string.Format("{0}-{1,4}-{2:D3}", name, id, id)
        let viaInterp = "$name-${id,4}-${id:D3}"
        Console.WriteLine("StringFormatParity: format=$viaFormat")
        Console.WriteLine("StringFormatParity: interp=$viaInterp")
        Console.WriteLine("StringFormatParity: equal=${viaFormat == viaInterp}")
    }
}
