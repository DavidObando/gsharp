// inventory: CheckedExpression
using System;

namespace Corpus.Grid02
{
    public static class CheckedExpressionFixture
    {
        public static void Run()
        {
            int a = 1000000;
            int b = 2000;
            int sum = checked(a + b);
            long product = checked((long)a * b);
            Console.WriteLine($"CheckedExpression: sum={sum} product={product}");

            int max = int.MaxValue;
            int one = 1;
            bool caught = false;
            int wrapped = 0;
            try
            {
                wrapped = checked(max + one);
            }
            catch (OverflowException)
            {
                caught = true;
            }

            Console.WriteLine($"CheckedExpression: overflow caught={caught} wrapped={wrapped}");

            int wide = 300;
            bool byteCaught = false;
            try
            {
                byte narrow = checked((byte)wide);
                Console.WriteLine($"CheckedExpression: narrow={narrow}");
            }
            catch (OverflowException)
            {
                byteCaught = true;
            }

            Console.WriteLine($"CheckedExpression: byte overflow caught={byteCaught}");
        }
    }
}
