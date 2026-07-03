// inventory: LockStatement
using System;

namespace Corpus.Grid03.Constructs
{
    public static class LockStatementFixture
    {
        private static readonly object Gate = new object();
        private static int _counter;

        public static void Run()
        {
            lock (Gate)
            {
                _counter++;
                Console.WriteLine($"LockStatement: counter={_counter}");
            }

            try
            {
                lock (Gate)
                {
                    Console.WriteLine("LockStatement: about to throw");
                    throw new InvalidOperationException("boom");
                }
            }
            catch (InvalidOperationException ex)
            {
                Console.WriteLine($"LockStatement: caught {ex.Message}");
            }

            // The prior lock's body threw, but `finally` must still release
            // the monitor — re-acquiring the SAME gate here with no deadlock
            // is the deterministic proof (issue #1885).
            lock (Gate)
            {
                _counter++;
                Console.WriteLine($"LockStatement: counter={_counter}");
            }
        }
    }
}
