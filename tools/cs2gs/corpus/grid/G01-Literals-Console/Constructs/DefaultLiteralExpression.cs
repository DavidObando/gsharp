// inventory: DefaultLiteralExpression
using System;

namespace Corpus.Grid01
{
    public static class DefaultLiteralExpressionFixture
    {
        public static void Run()
        {
            int number = default;
            bool flag = default;
            double real = default;
            char character = default;
            string? text = default;
            Console.WriteLine($"DefaultLiteralExpression: int={number} bool={flag} double={real}");
            Console.WriteLine($"DefaultLiteralExpression: charCode={(int)character} stringIsNull={text == null}");
        }
    }
}
