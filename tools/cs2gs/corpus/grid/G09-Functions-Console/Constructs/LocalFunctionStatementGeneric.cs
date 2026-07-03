// inventory: LocalFunctionStatement
using System;

namespace Corpus.Grid09
{
    public static class LocalFunctionStatementGenericFixture
    {
        public static void Run()
        {
            // QUARANTINED (GS0113): generic local functions (T Echo<T>(T v))
            // are emitted as 'let Echo = func (value T) T { ... }' — G#
            // lambdas cannot declare type parameters, so 'T' does not resolve.

            // Local function used as a Func<> value.
            static int Square(int x)
            {
                return x * x;
            }

            Func<int, int> f = Square;
            Console.WriteLine($"LocalFunctionStatementGeneric: asFunc={f(6)}");

            // Local function with a captured parameterized helper shape.
            int offset = 100;
            int Shift(int x)
            {
                return x + offset;
            }

            Console.WriteLine($"LocalFunctionStatementGeneric: shift={Shift(1)}");
        }
    }
}
