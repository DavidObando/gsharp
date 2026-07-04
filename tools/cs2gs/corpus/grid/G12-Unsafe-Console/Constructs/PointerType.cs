// inventory: PointerType — also AddressOfExpression and PointerIndirectionExpression
// The canonical unsafe triple: declare an int*, take &local, write and read
// through *p; plus a pointer-to-pointer double indirection.
using System;

namespace Corpus.Grid12.Constructs
{
    public static class PointerTypeFixture
    {
        public static void Run()
        {
            unsafe
            {
                int x = 3;
                int* p = &x;
                *p = 5;
                int read = *p;
                Console.WriteLine($"PointerType: x={x} read={read}");

                int** pp = &p;
                **pp = 9;
                Console.WriteLine($"PointerType: doubleIndirect x={x}");
            }
        }
    }
}
