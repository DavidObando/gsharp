// inventory: UnsignedRightShiftExpression

package Corpus.Grid02

import System

shared class UnsignedRightShiftExpressionFixture {
    func Run() {
        let value = 32
        let negative = -8
        let negativeLong = -8L
        let unsignedValue = 4294967288u
        Console.WriteLine(
            "UnsignedRightShiftExpression: a=${value >>> 2} logical=${negative >>> 1} arithmetic=${negative >> 1} long=${negativeLong >>> 1} uint=${unsignedValue >>> 1}"
        )
    }
}
