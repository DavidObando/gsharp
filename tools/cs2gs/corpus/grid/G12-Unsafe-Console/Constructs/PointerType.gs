// inventory: PointerType — also AddressOfExpression and PointerIndirectionExpression
// The canonical unsafe triple: declare an int*, take &local, write and read
// through *p; plus a pointer-to-pointer double indirection.

package Corpus.Grid12.Constructs

import System

shared class PointerTypeFixture {
    func Run() {
        unsafe {
            var x = 3
            var p = &x
            *p = 5
            let read = *p
            Console.WriteLine("PointerType: x=$x read=$read")
            let pp = &p
            **pp = 9
            Console.WriteLine("PointerType: doubleIndirect x=$x")
        }
    }
}
