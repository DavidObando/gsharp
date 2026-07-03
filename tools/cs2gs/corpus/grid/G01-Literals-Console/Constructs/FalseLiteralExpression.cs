// inventory: FalseLiteralExpression
using System;

namespace Corpus.Grid01
{
    public static class FalseLiteralExpressionFixture
    {
        public static void Run()
        {
            bool disabled = false;
            if (!disabled)
            {
                Console.WriteLine("FalseLiteralExpression: branch taken");
            }

            Console.WriteLine($"FalseLiteralExpression: value={false} local={disabled}");
        }
    }
}
