// inventory: Utf8StringLiteralExpression
using System;

namespace Corpus.Grid01
{
    public static class Utf8StringLiteralExpressionFixture
    {
        public static void Run()
        {
            System.ReadOnlySpan<byte> data = "abc"u8;
            Console.WriteLine("Utf8StringLiteralExpression: length=" + data.Length.ToString());
            Console.WriteLine("Utf8StringLiteralExpression: first=" + data[0].ToString());
        }
    }
}
