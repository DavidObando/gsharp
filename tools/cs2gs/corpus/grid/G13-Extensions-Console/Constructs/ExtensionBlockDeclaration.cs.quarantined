// inventory: ExtensionBlockDeclaration — C# 14 `extension` container block, instance methods (probe)
// The headline C# 14 form: `extension(string s) { ... }` inside a static
// class, declaring instance-style extension methods invoked as s.Doubled().
using System;

namespace Corpus.Grid13.Constructs
{
    public static class ExtensionBlockDeclarationExtensions
    {
        extension(string s)
        {
            public int Doubled()
            {
                return s.Length * 2;
            }

            public string Shout()
            {
                return s.ToUpperInvariant() + "!";
            }
        }
    }

    public static class ExtensionBlockDeclarationFixture
    {
        public static void Run()
        {
            string word = "grid";
            Console.WriteLine($"ExtensionBlockDeclaration: doubled={word.Doubled()}");
            Console.WriteLine($"ExtensionBlockDeclaration: shout={word.Shout()}");
        }
    }
}
