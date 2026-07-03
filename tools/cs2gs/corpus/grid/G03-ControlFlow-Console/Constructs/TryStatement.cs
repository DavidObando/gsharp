// inventory: TryStatement
using System;

namespace Corpus.Grid03.Constructs
{
    public static class TryStatementFixture
    {
        public static void Run()
        {
            for (int code = 0; code <= 2; code++)
            {
                try
                {
                    ThrowFor(code);
                    Console.WriteLine($"TryStatement: code {code} completed without throwing");
                }
                catch (InvalidOperationException ex)
                {
                    Console.WriteLine($"TryStatement: InvalidOperationException handler caught {ex.Message}");
                }
                catch (ArgumentException ex)
                {
                    Console.WriteLine($"TryStatement: ArgumentException handler caught {ex.Message}");
                }
                finally
                {
                    Console.WriteLine($"TryStatement: finally ran for code {code}");
                }
            }

            try
            {
                try
                {
                    throw new InvalidOperationException("inner failure");
                }
                catch (InvalidOperationException)
                {
                    Console.WriteLine("TryStatement: inner handler rethrowing");
                    throw;
                }
            }
            catch (InvalidOperationException ex)
            {
                Console.WriteLine($"TryStatement: outer handler caught rethrown {ex.Message}");
            }
        }

        private static void ThrowFor(int code)
        {
            if (code == 1)
            {
                throw new InvalidOperationException("invalid operation");
            }

            if (code == 2)
            {
                throw new ArgumentException("bad argument");
            }
        }
    }
}
