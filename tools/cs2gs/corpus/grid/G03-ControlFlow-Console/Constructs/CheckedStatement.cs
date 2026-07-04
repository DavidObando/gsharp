// inventory: CheckedStatement
using System;

namespace Corpus.Grid03.Constructs
{
    public static class CheckedStatementFixture
    {
        public static void Run()
        {
            checked
            {
                int a = 1000000;
                int b = 2000;
                long product = (long)a * b;
                Console.WriteLine($"CheckedStatement: checked product = {product}");
            }

            checked
            {
                int x = 41;
                int y = x + 1;
                Console.WriteLine($"CheckedStatement: checked sum without overflow = {y}");
            }

            // issue #1881: the overflow-in-try/catch(OverflowException) case —
            // previously quarantined because cs2gs erased the checked context,
            // silently wrapping instead of throwing.
            bool caught = false;
            int wrapped = 0;
            try
            {
                int max = int.MaxValue;
                int one = 1;
                checked
                {
                    wrapped = max + one;
                }
            }
            catch (OverflowException)
            {
                caught = true;
            }

            Console.WriteLine($"CheckedStatement: overflow caught = {caught}");
            Console.WriteLine($"CheckedStatement: unexpected wrap = {wrapped}");
        }
    }
}
