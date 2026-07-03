// inventory: IsExpression
using System;

namespace Corpus.Grid02
{
    public static class IsExpressionFixture
    {
        public static void Run()
        {
            object text = "sample";
            object number = 123;
            bool isString = text is string;
            bool isInt = number is int;
            bool wrong = text is int;
            Console.WriteLine($"IsExpression: isString={isString} isInt={isInt} wrong={wrong}");
        }
    }
}
