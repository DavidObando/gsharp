// inventory: AndAssignmentExpression
using System;

namespace Corpus.Grid02
{
    public static class AndAssignmentExpressionFixture
    {
        public static void Run()
        {
            int bits = 0b1111;
            bits &= 0b1010;
            bool flag = true;
            flag &= false;
            Console.WriteLine($"AndAssignmentExpression: bits={bits} flag={flag}");
        }
    }
}
