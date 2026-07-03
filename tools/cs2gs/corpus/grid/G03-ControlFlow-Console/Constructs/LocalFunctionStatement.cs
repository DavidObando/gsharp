// inventory: LocalFunctionStatement
// NOTE: quarantined sub-cases (fail gsc compile after translation):
//   * static local function — call site is emitted as a class-member access
//     (`LocalFunctionStatementFixture.Square(6)`) that does not exist (GS0158).
//   * generic local function — lowered to `func (a T, b T) T` where 'T' is not
//     a known type (GS0113), cascading GS0124/GS0122.
// Plain and capturing local functions are kept below.
using System;

namespace Corpus.Grid03.Constructs
{
    public static class LocalFunctionStatementFixture
    {
        public static void Run()
        {
            int Add(int a, int b)
            {
                return a + b;
            }

            Console.WriteLine($"LocalFunctionStatement: Add(3, 4) = {Add(3, 4)}");

            int seed = 5;
            int AddSeed(int x)
            {
                return x + seed;
            }

            Console.WriteLine($"LocalFunctionStatement: AddSeed(7) with captured seed = {AddSeed(7)}");
        }
    }
}
