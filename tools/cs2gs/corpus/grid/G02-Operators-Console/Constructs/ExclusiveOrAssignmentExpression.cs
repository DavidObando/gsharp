// inventory: ExclusiveOrAssignmentExpression
using System;

namespace Corpus.Grid02
{
    public static class ExclusiveOrAssignmentExpressionFixture
    {
        public static void Run()
        {
            int bits = 0b1100;
            bits ^= 0b1010;
            bool flag = true;
            flag ^= true;
            Console.WriteLine($"ExclusiveOrAssignmentExpression: bits={bits} flag={flag}");
        }
    }
}
