// inventory: Parameter
using System;

namespace Corpus.Grid09
{
    public static class OptionalAndParamsArrayFixture
    {
        public static void Run()
        {
            Console.WriteLine($"OptionalAndParamsArray: defaults={Greet("Ada")}");
            Console.WriteLine($"OptionalAndParamsArray: oneOverride={Greet("Bea", "Yo")}");
            Console.WriteLine($"OptionalAndParamsArray: namedSkip={Greet("Cid", times: 2)}");

            Console.WriteLine($"OptionalAndParamsArray: sumNone={Sum()}");
            Console.WriteLine($"OptionalAndParamsArray: sumThree={Sum(1, 2, 3)}");
            Console.WriteLine($"OptionalAndParamsArray: sumArray={Sum(new[] { 4, 5 })}");
        }

        private static string Greet(string name, string greeting = "Hello", int times = 1)
        {
            return $"{greeting} {name} x{times}";
        }

        private static int Sum(params int[] values)
        {
            int total = 0;
            foreach (int v in values)
            {
                total += v;
            }

            return total;
        }
    }
}
