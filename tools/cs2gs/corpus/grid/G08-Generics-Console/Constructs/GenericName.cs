// inventory: GenericName — constructed generic types + generic method called with explicit type arguments
using System;
using System.Collections.Generic;

namespace Corpus.Grid08
{
    public static class Echoes
    {
        public static string TypeTag<T>(T value)
        {
            return "tagged:" + value.ToString();
        }

        public static T Pick<T>(T first, T second, bool takeFirst)
        {
            return takeFirst ? first : second;
        }
    }

    public static class GenericNameFixture
    {
        public static void Run()
        {
            List<int> numbers = new List<int>();
            numbers.Add(4);
            numbers.Add(9);
            Console.WriteLine("GenericName: list-count=" + numbers.Count.ToString());
            Console.WriteLine("GenericName: explicit=" + Echoes.Pick<int>(7, 8, true).ToString());
            Console.WriteLine("GenericName: inferred=" + Echoes.TypeTag(11));
            Console.WriteLine("GenericName: explicit-string=" + Echoes.Pick<string>("a", "b", false));
        }
    }
}
