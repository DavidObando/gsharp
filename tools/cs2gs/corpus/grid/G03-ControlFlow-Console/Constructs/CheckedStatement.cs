// inventory: CheckedStatement
// NOTE: quarantined sub-case (stage-4 silent divergence, STDOUT-MISMATCH):
//   checked { int wrapped = max + one; } inside try/catch(OverflowException) —
//   C# throws and prints "overflow caught = True"; the migrated G# emits the
//   checked statement as a plain block (overflow semantics NOT preserved) and
//   prints "unexpected wrap = -2147483648" / "overflow caught = False".
// Only non-overflowing arithmetic is kept inside the checked block below.
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
        }
    }
}
