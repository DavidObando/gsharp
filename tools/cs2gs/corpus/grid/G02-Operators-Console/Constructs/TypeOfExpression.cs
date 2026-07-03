// inventory: TypeOfExpression
using System;

namespace Corpus.Grid02
{
    public static class TypeOfExpressionFixture
    {
        public static void Run()
        {
            string intName = typeof(int).Name;
            string stringName = typeof(string).Name;
            string doubleFull = typeof(double).FullName ?? "?";
            Console.WriteLine($"TypeOfExpression: int={intName} string={stringName} double={doubleFull}");
        }
    }
}
