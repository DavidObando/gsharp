using System;

namespace Corpus.Grid09
{
    public static class RefExpressionLocalFunctionFixture
    {
        public static void Run()
        {
            int[] xs = { 1, 2, 3 };

            static ref int Pick(int[] a, int i)
            {
                return ref a[i];
            }

            ref int q = ref Pick(xs, 2);
            q = 30;
            Console.WriteLine($"RefExpressionLocalFunction: xs={string.Join(",", xs)}");
        }
    }
}
