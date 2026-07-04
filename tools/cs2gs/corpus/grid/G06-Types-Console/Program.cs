// G06-Types-Console: type-declaration construct grid for cs2gs differential
// conformance (ADR-0115). One construct per file under Constructs/; each
// fixture prints deterministic lines prefixed "<Kind>: ". Run order is
// Constructs/ file-name (ordinal) order.
using System;

namespace Corpus.Grid06
{
    internal static class Program
    {
        private static void Main()
        {
            BaseListFixture.Run();
            ClassDeclarationFixture.Run();
            DestructorDeclarationFixture.Run();
            EnumDeclarationFixture.Run();
            EnumMemberDeclarationFixture.Run();

            ExplicitInterfaceSpecifierFixture.Run();
            InterfaceDeclarationFixture.Run();

            PartialClassFixture.Run();
            PrimaryConstructorBaseTypeFixture.Run();
            RecordDeclarationFixture.Run();
            RecordStructDeclarationFixture.Run();
            RequiredMemberFixture.Run();
            SimpleBaseTypeFixture.Run();
            StructDeclarationFixture.Run();
            TypeAliasDeclarationFixture.Run();
        }
    }
}
