// inventory: ThisConstructorInitializer — constructor chaining : this(...)
using System;

namespace Corpus.Grid07
{
    public class Portion
    {
        private readonly int _grams;
        private readonly string _unit;

        public Portion()
            : this(100)
        {
        }

        public Portion(int grams)
            : this(grams, "g")
        {
        }

        public Portion(int grams, string unit)
        {
            _grams = grams;
            _unit = unit;
        }

        public string Describe()
        {
            return _grams.ToString() + _unit;
        }
    }

    public static class ThisConstructorInitializerFixture
    {
        public static void Run()
        {
            Console.WriteLine("ThisConstructorInitializer: default=" + new Portion().Describe());
            Console.WriteLine("ThisConstructorInitializer: single=" + new Portion(250).Describe());
            Console.WriteLine("ThisConstructorInitializer: full=" + new Portion(2, "kg").Describe());
        }
    }
}
