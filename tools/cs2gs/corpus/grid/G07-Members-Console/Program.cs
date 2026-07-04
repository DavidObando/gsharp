// G07-Members-Console: member-declaration construct grid for cs2gs differential
// conformance (ADR-0115). One construct per file under Constructs/; each
// fixture prints deterministic lines prefixed "<Kind>: ". Run order is
// Constructs/ file-name (ordinal) order.
using System;

namespace Corpus.Grid07
{
    internal static class Program
    {
        private static void Main()
        {
            ArrowExpressionClauseFixture.Run();
            AttributeListFixture.Run();
            BaseConstructorInitializerFixture.Run();

            // QUARANTINED (see Quarantined/):
            //  * CompoundAssignmentOperatorDeclarationFixture — C#14 instance
            //    `operator +=` fails round-trip (GS0005 Unexpected token <PlusEqualsToken>).
            ConstructorDeclarationFixture.Run();
            ConversionOperatorDeclarationFixture.Run();
            EventDeclarationFixture.Run();
            EventFieldDeclarationFixture.Run();
            FieldDeclarationFixture.Run();
            FieldExpressionFixture.Run();
            IndexerDeclarationFixture.Run();
            InitAccessorDeclarationFixture.Run();
            MethodDeclarationFixture.Run();
            OperatorDeclarationFixture.Run();
            PropertyDeclarationFixture.Run();
            ThisConstructorInitializerFixture.Run();
        }
    }
}
