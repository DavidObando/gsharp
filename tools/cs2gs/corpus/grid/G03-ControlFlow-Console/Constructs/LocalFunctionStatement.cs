// inventory: LocalFunctionStatement
// Plain, captured, static, and generic local functions are all exercised below
// (issue #1886: static local functions now call through their `let` binding
// directly instead of a nonexistent class-member access, and generic local
// functions translate to G#'s `let Name[T, ...] = func (...) ... { ... }`).
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

            static int Square(int x)
            {
                return x * x;
            }

            Console.WriteLine($"LocalFunctionStatement: Square(6) = {Square(6)}");

            T First<T>(T a, T b)
            {
                return a;
            }

            Console.WriteLine($"LocalFunctionStatement: First(1, 2) = {First(1, 2)}");
            Console.WriteLine($"LocalFunctionStatement: First(\"x\", \"y\") = {First("x", "y")}");
        }
    }
}
