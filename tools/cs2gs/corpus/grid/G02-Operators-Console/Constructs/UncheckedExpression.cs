// inventory: UncheckedExpression
using System;

namespace Corpus.Grid02
{
    public static class UncheckedExpressionFixture
    {
        public static void Run()
        {
            int max = int.MaxValue;
            int one = 1;
            int wrapped = unchecked(max + one);
            Console.WriteLine($"UncheckedExpression: wrapped={wrapped}");

            uint maxU = uint.MaxValue;
            uint oneU = 1;
            uint wrappedU = unchecked(maxU + oneU);
            Console.WriteLine($"UncheckedExpression: wrappedU={wrappedU}");

            byte narrowed = unchecked((byte)300);
            Console.WriteLine($"UncheckedExpression: narrowed={narrowed}");
        }
    }
}
