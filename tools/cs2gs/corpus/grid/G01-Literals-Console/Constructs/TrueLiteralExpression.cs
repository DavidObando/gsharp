// inventory: TrueLiteralExpression
using System;

namespace Corpus.Grid01
{
    public static class TrueLiteralExpressionFixture
    {
        public static void Run()
        {
            bool enabled = true;
            if (enabled)
            {
                Console.WriteLine("TrueLiteralExpression: branch taken");
            }

            Console.WriteLine($"TrueLiteralExpression: value={true} local={enabled}");
        }
    }
}
