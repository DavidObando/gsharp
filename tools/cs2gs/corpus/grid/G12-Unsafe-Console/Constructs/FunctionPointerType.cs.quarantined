// inventory: FunctionPointerType — also FunctionPointerParameter and the managed calling convention (probe)
// Managed function pointers: `delegate*<int, int>` and an explicit
// `delegate* managed<int, int, int>`, taken with & and invoked directly.
using System;

namespace Corpus.Grid12.Constructs
{
    public static class FunctionPointerTypeFixture
    {
        public static void Run()
        {
            unsafe
            {
                delegate*<int, int> square = &Square;
                Console.WriteLine($"FunctionPointerType: square(6)={square(6)}");

                delegate* managed<int, int, int> add = &Add;
                Console.WriteLine($"FunctionPointerType: add(3,4)={add(3, 4)}");
            }
        }

        private static int Square(int value)
        {
            return value * value;
        }

        private static int Add(int left, int right)
        {
            return left + right;
        }
    }
}
