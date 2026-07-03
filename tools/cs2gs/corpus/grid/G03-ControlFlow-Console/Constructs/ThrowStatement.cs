// inventory: ThrowStatement
using System;

namespace Corpus.Grid03.Constructs
{
    public static class ThrowStatementFixture
    {
        public static void Run()
        {
            try
            {
                throw new ArgumentException("bad argument");
            }
            catch (ArgumentException ex)
            {
                Console.WriteLine($"ThrowStatement: caught {ex.Message}");
            }

            try
            {
                Validate(-1);
            }
            catch (InvalidOperationException ex)
            {
                Console.WriteLine($"ThrowStatement: caught from helper: {ex.Message}");
            }

            Validate(5);
            Console.WriteLine("ThrowStatement: Validate(5) did not throw");
        }

        private static void Validate(int value)
        {
            if (value < 0)
            {
                throw new InvalidOperationException("value must be non-negative");
            }
        }
    }
}
