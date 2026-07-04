// G13-Extensions-Console: extension-member construct grid fixtures (ADR-0115).
// Classic `this`-parameter extension methods plus the C# 14 `extension` block
// form (instance methods, properties, static members). One construct per
// Constructs/<Kind>.cs file; fixtures run in file-name order and print
// deterministic, prefix-tagged lines.
using System;
using Corpus.Grid13.Constructs;

namespace Corpus.Grid13
{
    internal static class Program
    {
        private static void Main()
        {
            ExtensionBlockDeclarationFixture.Run();
            ExtensionBlockPropertyFixture.Run();
            ExtensionBlockStaticFixture.Run();
            ExtensionMethodsClassicFixture.Run();
            ExtensionMethodsGenericFixture.Run();
        }
    }
}
