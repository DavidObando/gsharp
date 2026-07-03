// inventory: StringLiteralExpression
using System;

namespace Corpus.Grid01
{
    public static class StringLiteralExpressionFixture
    {
        public static void Run()
        {
            string plain = "hello world";
            string escaped = "line1\tcolumn2";
            string verbatim = @"C:\temp\logs";
            string verbatimQuotes = @"say ""hi"" twice";
            string raw = """He said "raw" strings work.""";
            string empty = "";
            Console.WriteLine($"StringLiteralExpression: plain={plain}");
            Console.WriteLine($"StringLiteralExpression: escaped={escaped}");
            Console.WriteLine($"StringLiteralExpression: verbatim={verbatim}");
            Console.WriteLine($"StringLiteralExpression: verbatimQuotes={verbatimQuotes}");
            Console.WriteLine($"StringLiteralExpression: raw={raw}");
            Console.WriteLine($"StringLiteralExpression: emptyLength={empty.Length}");
        }
    }
}
