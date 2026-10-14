// inventory: SizeOfExpression
// sizeof over primitives (safe context) and over a user struct (unsafe
// context). All sizes are fixed by the CLI spec / sequential layout.

package Corpus.Grid12.Constructs

import System

internal struct SizePair {
    var A int32
    var B int32
}

shared class SizeOfExpressionFixture {
    func Run() {
        Console.WriteLine("SizeOfExpression: sizeof(byte)=${1}")
        Console.WriteLine("SizeOfExpression: sizeof(short)=${2}")
        Console.WriteLine("SizeOfExpression: sizeof(int)=${4}")
        Console.WriteLine("SizeOfExpression: sizeof(long)=${8}")
        Console.WriteLine("SizeOfExpression: sizeof(char)=${2}")
        Console.WriteLine("SizeOfExpression: sizeof(double)=${8}")
        var pair SizePair
        pair.A = 3
        pair.B = 4
        unsafe {
            Console.WriteLine("SizeOfExpression: sizeof(SizePair)=${sizeof(SizePair)} sum=${pair.A + pair.B}")
        }
    }
}
