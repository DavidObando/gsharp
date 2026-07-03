// inventory: ExtensionBlockDeclaration — static extension members in extension blocks (probe)
// C# 14 static extension members declared with a receiverless
// `extension(string)` block and invoked through the type: string.Meaning,
// string.Repeat(...).
using System;
using System.Text;

namespace Corpus.Grid13.Constructs
{
    public static class ExtensionBlockStaticExtensions
    {
        extension(string)
        {
            public static string Meaning => "forty-two";

            public static string Repeat(string value, int count)
            {
                StringBuilder builder = new StringBuilder();
                for (int i = 0; i < count; i++)
                {
                    builder.Append(value);
                }

                return builder.ToString();
            }
        }
    }

    public static class ExtensionBlockStaticFixture
    {
        public static void Run()
        {
            Console.WriteLine($"ExtensionBlockStatic: meaning={string.Meaning}");
            Console.WriteLine($"ExtensionBlockStatic: repeat={string.Repeat("ab", 3)}");
        }
    }
}
