// inventory: ExtensionBlockDeclaration — extension properties via extension blocks (probe)
// C# 14 instance extension properties: a get-only expression-bodied property
// and a get-accessor property on a receiver parameter.
using System;

namespace Corpus.Grid13.Constructs
{
    public static class ExtensionBlockPropertyExtensions
    {
        extension(string s)
        {
            public int DoubledLength => s.Length * 2;

            public string FirstAndLast
            {
                get
                {
                    if (s.Length == 0)
                    {
                        return "<empty>";
                    }

                    return $"{s[0]}..{s[s.Length - 1]}";
                }
            }
        }
    }

    public static class ExtensionBlockPropertyFixture
    {
        public static void Run()
        {
            string word = "corpus";
            Console.WriteLine($"ExtensionBlockProperty: doubledLength={word.DoubledLength}");
            Console.WriteLine($"ExtensionBlockProperty: firstAndLast={word.FirstAndLast}");
        }
    }
}
