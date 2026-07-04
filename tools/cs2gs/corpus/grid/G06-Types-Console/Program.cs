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

            // QUARANTINED (see Quarantined/): ExplicitInterfaceSpecifierFixture —
            // explicit interface impl is lowered to a plain method: with a same-name
            // public method it fails compile (GS0264 duplicate overload); alone it
            // compiles but fails ilverify ("Class implements interface but not method").
            InterfaceDeclarationFixture.Run();

            // QUARANTINED (see Quarantined/): PrimaryConstructorBaseTypeFixture —
            // primary-constructor parameters are dropped (GS0125 Variable 'name'
            // doesn't exist; GS0144 arity 0).
            PartialClassFixture.Run();
            RecordDeclarationFixture.Run();
            RecordStructDeclarationFixture.Run();
            RequiredMemberFixture.Run();
            SimpleBaseTypeFixture.Run();
            StructDeclarationFixture.Run();
            TypeAliasDeclarationFixture.Run();
        }
    }
}
