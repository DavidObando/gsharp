// inventory: NameOfExpression
using System;

namespace Corpus.Grid02
{
    public static class NameOfExpressionFixture
    {
        public static void Run()
        {
            int counter = 3;
            string localName = nameof(counter);
            string typeName = nameof(Console);
            string methodName = nameof(Run);
            Console.WriteLine($"NameOfExpression: local={localName} type={typeName} method={methodName} value={counter}");
        }
    }
}
