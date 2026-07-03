// inventory: OrAssignmentExpression
using System;

namespace Corpus.Grid02
{
    public static class OrAssignmentExpressionFixture
    {
        public static void Run()
        {
            int bits = 0b0101;
            bits |= 0b0010;
            bool flag = false;
            flag |= true;
            Console.WriteLine($"OrAssignmentExpression: bits={bits} flag={flag}");
        }
    }
}
