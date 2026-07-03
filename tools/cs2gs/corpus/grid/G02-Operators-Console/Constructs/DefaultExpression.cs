// inventory: DefaultExpression
using System;

namespace Corpus.Grid02
{
    public static class DefaultExpressionFixture
    {
        public static void Run()
        {
            int di = default(int);
            bool db = default(bool);
            double dd = default(double);
            string? ds = default(string);
            Console.WriteLine($"DefaultExpression: int={di} bool={db} double={dd} stringIsNull={ds == null}");
        }
    }
}
