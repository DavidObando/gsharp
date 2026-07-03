// inventory: SimpleAssignmentExpression
using System;

namespace Corpus.Grid02
{
    public static class SimpleAssignmentExpressionFixture
    {
        public static void Run()
        {
            int a = 1;
            a = 2;
            int b;
            b = a;
            int c = 0;
            c = b = 7;
            Console.WriteLine($"SimpleAssignmentExpression: a={a} b={b} c={c}");
        }
    }
}
