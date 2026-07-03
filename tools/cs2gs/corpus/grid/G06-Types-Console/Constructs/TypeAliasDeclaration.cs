// inventory: UsingDirective — type alias (using X = ...)
// QUARANTINED probe: C#12 alias-any-type tuple alias `using NamePair = (int Number, string Word);`
// fails translate with CS2GS-GAP "using directive without a resolvable name."
using System;
using Count = System.Int32;

namespace Corpus.Grid06
{
    public static class TypeAliasDeclarationFixture
    {
        public static Count AddOne(Count value)
        {
            return value + 1;
        }

        public static void Run()
        {
            Count start = 41;
            Console.WriteLine("TypeAliasDeclaration: count=" + AddOne(start).ToString());
        }
    }
}
