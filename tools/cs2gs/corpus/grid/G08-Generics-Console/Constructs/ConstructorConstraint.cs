// inventory: ConstructorConstraint — where T : new() with new T() construction (probe; past gap #988)
using System;

namespace Corpus.Grid08
{
    public class BlankSlate
    {
        private int _marks;

        public void Mark()
        {
            _marks = _marks + 1;
        }

        public int Marks()
        {
            return _marks;
        }
    }

    public static class FreshMaker
    {
        public static T Make<T>()
            where T : new()
        {
            return new T();
        }
    }

    public static class ConstructorConstraintFixture
    {
        public static void Run()
        {
            BlankSlate slate = FreshMaker.Make<BlankSlate>();
            slate.Mark();
            slate.Mark();
            slate.Mark();
            Console.WriteLine("ConstructorConstraint: marks=" + slate.Marks().ToString());
        }
    }
}
