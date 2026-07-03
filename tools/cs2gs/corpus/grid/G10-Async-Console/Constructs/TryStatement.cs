// inventory: TryStatement — await inside loop bodies and try/catch/finally
// Awaits inside for/while loops and inside try, catch, and finally blocks. The
// thrown exception is created and caught locally, so control flow is fixed.
using System;
using System.Threading.Tasks;

namespace Corpus.Grid10.Constructs
{
    public static class TryStatementFixture
    {
        public static async Task RunAsync()
        {
            int total = 0;
            for (int i = 1; i <= 3; i++)
            {
                total += await Task.FromResult(i * 10);
                Console.WriteLine($"TryStatement: loop step {i} total={total}");
            }

            int iterations = 0;
            while (iterations < 2)
            {
                iterations += await Task.FromResult(1);
            }

            Console.WriteLine($"TryStatement: while iterations={iterations}");

            try
            {
                int inTry = await Task.FromResult(5);
                Console.WriteLine($"TryStatement: try value={inTry}");
                throw new InvalidOperationException("expected");
            }
            catch (InvalidOperationException ex)
            {
                int inCatch = await Task.FromResult(ex.Message.Length);
                Console.WriteLine($"TryStatement: catch messageLength={inCatch}");
            }
            finally
            {
                int inFinally = await Task.FromResult(99);
                Console.WriteLine($"TryStatement: finally value={inFinally}");
            }
        }
    }
}
