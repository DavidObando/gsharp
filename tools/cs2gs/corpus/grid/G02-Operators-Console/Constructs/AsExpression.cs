// inventory: AsExpression
using System;

namespace Corpus.Grid02
{
    public static class AsExpressionFixture
    {
        public static void Run()
        {
            object boxedText = "hello";
            object boxedNumber = 42;
            string? text = boxedText as string;
            string? missing = boxedNumber as string;
            Console.WriteLine($"AsExpression: text={text ?? "null"} missing={missing ?? "null"}");
        }
    }
}
