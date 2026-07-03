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
            // QUARANTINED: ExtensionBlockDeclaration — the C# 14 `extension`
            // container block (instance methods, extension properties, and
            // static extension members alike). Stage 1 (translate) fails with
            // CS2GS-GAP: "'ExtensionBlockDeclaration' has no canonical G#
            // declaration mapping; recorded for triage (ADR-0115 §B)." for
            // both `extension(string s)` and receiverless `extension(string)`.
            // See ExtensionBlockDeclaration.cs.quarantined,
            // ExtensionBlockProperty.cs.quarantined, and
            // ExtensionBlockStatic.cs.quarantined.
            // ExtensionBlockDeclarationFixture.Run();
            // ExtensionBlockPropertyFixture.Run();
            // ExtensionBlockStaticFixture.Run();
            ExtensionMethodsClassicFixture.Run();
            ExtensionMethodsGenericFixture.Run();
        }
    }
}
