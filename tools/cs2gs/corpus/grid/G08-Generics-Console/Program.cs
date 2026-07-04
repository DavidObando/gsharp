// G08-Generics-Console: generics construct grid for cs2gs differential
// conformance (ADR-0115). One construct per file under Constructs/; each
// fixture prints deterministic lines prefixed "<Kind>: ". Run order is
// Constructs/ file-name (ordinal) order.
using System;

namespace Corpus.Grid08
{
    internal static class Program
    {
        private static void Main()
        {
            AllowsConstraintClauseFixture.Run();
            ClassConstraintFixture.Run();
            ConstructorConstraintFixture.Run();
            DefaultConstraintFixture.Run();
            GenericAttributeFixture.Run();
            GenericNameFixture.Run();
            OmittedTypeArgumentFixture.Run();
            StructConstraintFixture.Run();
            TypeArgumentListFixture.Run();
            TypeConstraintFixture.Run();
            TypeParameterFixture.Run();
            TypeParameterListFixture.Run();
        }
    }
}
