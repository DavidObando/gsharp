// inventory: UsingDirective — type alias (using X = ...), incl. C#12
// alias-any-type tuple alias (issue #1914).
using System;
using Count = System.Int32;
using NamePair = (int Number, string Word);

namespace Corpus.Grid06
{
    public static class TypeAliasDeclarationFixture
    {
        public static Count AddOne(Count value)
        {
            return value + 1;
        }

        public static NamePair MakePair(NamePair seed)
        {
            return (seed.Number + 1, seed.Word + "!");
        }

        public static void Run()
        {
            Count start = 41;
            Console.WriteLine("TypeAliasDeclaration: count=" + AddOne(start).ToString());

            NamePair pair = (1, "hi");
            NamePair made = MakePair(pair);
            Console.WriteLine("TypeAliasDeclaration: pair=" + made.Number.ToString() + "," + made.Word);
        }
    }
}
