// inventory: LocalFunctionStatement
// Issue #1886: generic local functions (`T Echo<T>(T v)`) now translate to G#'s
// `let Echo[T] = func (value T) T { ... }` generic function-literal syntax.
using System;

namespace Corpus.Grid09
{
    public static class LocalFunctionStatementGenericFixture
    {
        public static void Run()
        {
            T Echo<T>(T v)
            {
                return v;
            }

            Console.WriteLine($"LocalFunctionStatementGeneric: Echo(7)={Echo(7)}");
            Console.WriteLine($"LocalFunctionStatementGeneric: Echo(\"hi\")={Echo("hi")}");

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
